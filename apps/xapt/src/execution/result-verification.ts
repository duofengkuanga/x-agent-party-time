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
    if (!assertions.some(({ kind }) => kind === 'GIT_COMMITS_CREATED'))
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
    if (!assertions.some(({ kind }) => kind === 'GIT_COMMITS_CREATED')) return;
    for (const assertion of assertions) {
      if (assertion.kind !== 'GIT_COMMITS_CREATED') continue;
      const value = valueAtPath(result, assertion.resultPath);
      if (value === undefined) continue;
      if (!baseline)
        throw new ExecutionResultVerificationError(
          '本机 Commit 结果校验缺少执行前基线',
        );
      const actualCommits = lines(
        await this.git(repositoryPath, [
          'rev-list',
          '--reverse',
          `${baseline.gitHead}..HEAD`,
        ]),
      );
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === 'string')
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
          throw new ExecutionResultVerificationError(
            `Codex 返回的本地 Commit ${commit} 不存在`,
          );
        }
      if (!sameValues(reportedCommits, actualCommits))
        throw new ExecutionResultVerificationError(
          'Codex 返回的本地 Commit 与本次 Execution 创建记录不一致',
        );
    }
  }

  private async git(repositoryPath: string, args: string[]): Promise<string> {
    const result = await this.commands.run('git', [
      '-C',
      repositoryPath,
      ...args,
    ]);
    if (result.exitCode !== 0)
      throw new ExecutionResultVerificationError('无法校验本机 Git 提交记录');
    return result.stdout.trim();
  }
}

function valueAtPath(value: JsonValue, path: string[]): JsonValue | undefined {
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
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
