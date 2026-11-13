import type {
  ExecutionResultAssertion,
  JsonValue,
} from '@agent-party-time/execution-contract';
import type { CommandRunner } from '../platform/contracts';

export type ExecutionResultBaseline = { gitHead: string } | null;

export interface ExecutionResultVerifier {
  capture(
    repositoryPath: string,
    assertions: ExecutionResultAssertion[],
  ): Promise<ExecutionResultBaseline>;
  verify(
    repositoryPath: string,
    assertions: ExecutionResultAssertion[],
    baseline: ExecutionResultBaseline,
    result: JsonValue,
  ): Promise<void>;
}

export class ExecutionResultVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionResultVerificationError';
  }
}

export class GitExecutionResultVerifier implements ExecutionResultVerifier {
  constructor(private readonly commands: CommandRunner) {}

  async capture(
    repositoryPath: string,
    assertions: ExecutionResultAssertion[],
  ): Promise<ExecutionResultBaseline> {
    if (
      !assertions.some(
        ({ kind }) => kind === 'GIT_COMMITS_CREATED' || kind === 'GIT_DELIVERY_STATE',
      )
    )
      return null;
    return {
      gitHead: await this.git(repositoryPath, ['rev-parse', 'HEAD']),
    };
  }

  async verify(
    repositoryPath: string,
    assertions: ExecutionResultAssertion[],
    baseline: ExecutionResultBaseline,
    result: JsonValue,
  ): Promise<void> {
    verifyResultContent(assertions, result);
    for (const assertion of assertions) {
      if (assertion.kind === 'GIT_DELIVERY_STATE') {
        await this.verifyDelivery(repositoryPath, assertion, baseline, result);
        continue;
      }
      if (assertion.kind !== 'GIT_COMMITS_CREATED') continue;
      const value = valueAtPath(result, assertion.resultPath);
      if (value === undefined) {
        if (
          assertion.workspaceBindingId &&
          valueAtPath(result, ['result', 'outcome']) !== 'FAILED'
        )
          throw new ExecutionResultVerificationError('修复结果缺少成员工作区的提交列表');
        continue;
      }
      if (!baseline)
        throw new ExecutionResultVerificationError('本机 Commit 结果校验缺少执行前基线');
      if (
        await this.git(repositoryPath, [
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
        ])
      )
        throw new ExecutionResultVerificationError('修复工作区仍有未提交改动');
      const ancestry = await this.commands.run('git', [
        '-C',
        repositoryPath,
        'merge-base',
        '--is-ancestor',
        baseline.gitHead,
        'HEAD',
      ]);
      if (ancestry.exitCode !== 0)
        throw new ExecutionResultVerificationError('当前 Git 历史不包含执行前基线');
      const actualCommits = lines(
        await this.git(repositoryPath, [
          'rev-list',
          '--reverse',
          `${baseline.gitHead}..HEAD`,
        ]),
      );
      if (
        !Array.isArray(value) ||
        !value.every(
          (item) =>
            typeof item === 'string' &&
            (assertion.workspaceBindingId
              ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
              : /^[a-f0-9]{7,64}$/u
            ).test(item),
        )
      )
        throw new ExecutionResultVerificationError(
          'Codex 返回的本地 Commit 证据格式无效',
        );
      const reportedCommits: string[] = [];
      for (const commit of value)
        try {
          reportedCommits.push(
            await this.git(repositoryPath, [
              'rev-parse',
              '--verify',
              `${commit}^{commit}`,
            ]),
          );
        } catch {
          throw new ExecutionResultVerificationError('Codex 返回的本地 Commit 不存在');
        }
      if (!sameValues(reportedCommits, actualCommits))
        throw new ExecutionResultVerificationError(
          'Codex 返回的本地 Commit 与本次 Execution 创建记录不一致',
        );
    }
  }

  private async verifyDelivery(
    repositoryPath: string,
    assertion: Extract<ExecutionResultAssertion, { kind: 'GIT_DELIVERY_STATE' }>,
    baseline: ExecutionResultBaseline,
    result: JsonValue,
  ): Promise<void> {
    const member = valueAtPath(result, assertion.resultPath);
    if (!member || typeof member !== 'object' || Array.isArray(member))
      throw new ExecutionResultVerificationError('更新结果缺少工程交付事实');
    if (!['PUSHED', 'DEPLOYED', 'UNCHANGED'].includes(String(member.state))) return;
    const head = await this.git(repositoryPath, ['rev-parse', 'HEAD']);
    if (
      await this.git(repositoryPath, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ])
    )
      throw new ExecutionResultVerificationError('更新工作区仍有未提交改动');
    if (member.state === 'UNCHANGED') {
      if (!baseline || baseline.gitHead !== head)
        throw new ExecutionResultVerificationError('声明未改动的工程存在未交付提交');
      return;
    }
    if (member.commit !== head)
      throw new ExecutionResultVerificationError('已推送的提交与工程工作区不一致');
    if (assertion.candidateCommits?.length) {
      if (!baseline || head === baseline.gitHead)
        throw new ExecutionResultVerificationError('工程尚未集成本批候选提交');
      for (const candidate of assertion.candidateCommits) {
        const ancestor = await this.commands.run('git', [
          '-C',
          repositoryPath,
          'merge-base',
          '--is-ancestor',
          candidate,
          head,
        ]);
        if (ancestor.exitCode === 0) continue;
        const sourcePatch = await this.git(repositoryPath, [
          'show',
          '--format=medium',
          '--no-color',
          candidate,
        ]);
        const appliedPatch = await this.git(repositoryPath, [
          'log',
          '--no-merges',
          '-p',
          '--no-color',
          `${baseline.gitHead}..${head}`,
        ]);
        const sourceId = await this.commands.run(
          'git',
          ['-C', repositoryPath, 'patch-id', '--stable'],
          { stdin: sourcePatch },
        );
        const applied = await this.commands.run(
          'git',
          ['-C', repositoryPath, 'patch-id', '--stable'],
          { stdin: appliedPatch },
        );
        const fingerprint = sourceId.stdout.trim().split(/\s+/u)[0];
        if (
          sourceId.exitCode !== 0 ||
          applied.exitCode !== 0 ||
          !fingerprint ||
          !lines(applied.stdout.trim()).some(
            (line) => line.split(/\s+/u)[0] === fingerprint,
          )
        )
          throw new ExecutionResultVerificationError('工程交付提交未包含本批冻结候选');
      }
    }
    const branch = `refs/heads/${assertion.targetBranch}`;
    const remote = await this.git(repositoryPath, [
      'ls-remote',
      '--exit-code',
      '--refs',
      'origin',
      branch,
    ]);
    if (lines(remote).includes(`${head}\t${branch}`)) return;
    const remoteHead = lines(remote)
      .find((line) => line.endsWith(`\t${branch}`))
      ?.split('\t')[0];
    if (
      member.state === 'DEPLOYED' &&
      remoteHead &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(remoteHead)
    ) {
      // A later push must not invalidate a deployment already awaiting synchronization.
      await this.git(repositoryPath, [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        remoteHead,
      ]);
      const ancestry = await this.commands.run('git', [
        '-C',
        repositoryPath,
        'merge-base',
        '--is-ancestor',
        head,
        remoteHead,
      ]);
      if (ancestry.exitCode === 0) return;
    }
    throw new ExecutionResultVerificationError('工程远端分支尚未确认当前交付提交');
  }

  private async git(repositoryPath: string, args: string[]): Promise<string> {
    const result = await this.commands.run('git', ['-C', repositoryPath, ...args]);
    if (result.exitCode !== 0)
      throw new ExecutionResultVerificationError('无法校验本机 Git 提交记录');
    return result.stdout.trim();
  }
}

/** Pure assertions also apply to read-only sessions without a Git workspace. */
export function verifyResultContent(
  assertions: ExecutionResultAssertion[],
  result: JsonValue,
): void {
  for (const assertion of assertions) {
    if (assertion.kind !== 'JSON_STRING_PATTERN') continue;
    const value = valueAtPath(result, assertion.resultPath);
    if (value === undefined) continue;
    let pattern: RegExp;
    try {
      pattern = new RegExp(assertion.pattern, 'u');
    } catch {
      throw new ExecutionResultVerificationError('本机结果字符串约束无效');
    }
    const pending: JsonValue[] = [value];
    while (pending.length) {
      const item = pending.pop()!;
      if (typeof item === 'string' && !pattern.test(item))
        throw new ExecutionResultVerificationError(
          '结构化结果不符合本机字符串约束，结果未发送',
        );
      if (item && typeof item === 'object') pending.push(...Object.values(item));
    }
  }
}

export function valueAtPath(value: JsonValue, path: string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of path) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== 'object' ||
      Array.isArray(current)
    )
      return undefined;
    current = current[segment];
  }
  return current;
}

function lines(value: string): string[] {
  return value ? value.split('\n').filter(Boolean) : [];
}

function sameValues(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}
