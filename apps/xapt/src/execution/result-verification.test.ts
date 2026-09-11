import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionResultAssertion } from '@agent-party-time/execution-contract';
import { NodeCommandRunner } from '../platform/system';
import { GitExecutionResultVerifier } from './result-verification';

const directories: string[] = [];
const assertions: ExecutionResultAssertion[] = [
  { kind: 'GIT_COMMITS_CREATED', resultPath: ['result', 'commits'] },
];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('只接受本次 Execution 创建且按顺序返回的真实 Commit', async () => {
  const repository = await gitRepository();
  const commands = new NodeCommandRunner();
  const verifier = new GitExecutionResultVerifier(commands);
  const baseline = await verifier.capture(repository, assertions);

  await writeFile(join(repository, 'change.txt'), 'change\n');
  await git(repository, ['add', 'change.txt']);
  await git(repository, ['commit', '-m', 'fix: change']);
  const commit = await git(repository, ['rev-parse', 'HEAD']);
  const shortCommit = await git(repository, ['rev-parse', '--short=8', 'HEAD']);

  await expect(
    verifier.verify(repository, assertions, baseline, {
      result: { commits: [shortCommit] },
    }),
  ).resolves.toBeUndefined();
  await expect(
    verifier.verify(repository, assertions, baseline, {
      result: { commits: [`${shortCommit}${'0'.repeat(32)}`] },
    }),
  ).rejects.toThrow(`Codex 返回的本地 Commit ${shortCommit}`);
  await expect(
    verifier.verify(repository, assertions, baseline, {
      result: { commits: [baseline!.gitHead] },
    }),
  ).rejects.toThrow('与本次 Execution 创建记录不一致');
  await expect(
    verifier.verify(repository, assertions, baseline, {
      result: { commits: [commit] },
    }),
  ).resolves.toBeUndefined();

  await writeFile(join(repository, 'second.txt'), 'second\n');
  await git(repository, ['add', 'second.txt']);
  await git(repository, ['commit', '-m', 'fix: second change']);
  const secondCommit = await git(repository, ['rev-parse', 'HEAD']);
  await expect(
    verifier.verify(repository, assertions, baseline, {
      result: { commits: [commit, secondCommit] },
    }),
  ).resolves.toBeUndefined();
  await expect(
    verifier.verify(repository, assertions, baseline, {
      result: { commits: [secondCommit, commit] },
    }),
  ).rejects.toThrow('与本次 Execution 创建记录不一致');
});

test('缺少原 Execution 基线时拒绝接受同步结果', async () => {
  const repository = await gitRepository();
  const verifier = new GitExecutionResultVerifier(new NodeCommandRunner());

  await expect(
    verifier.verify(repository, assertions, null, {
      result: { commits: ['abcdef1'] },
    }),
  ).rejects.toThrow('本机 Commit 结果校验缺少执行前基线');
});

test('不声明提交的有效业务失败结果不要求 Commit 基线', async () => {
  const repository = await gitRepository();
  const verifier = new GitExecutionResultVerifier(new NodeCommandRunner());

  await expect(
    verifier.verify(repository, assertions, null, {
      result: {
        outcome: 'FAILED',
        failedStep: '执行测试',
        reason: '测试失败',
        completedActions: [],
        pendingActions: [],
      },
    }),
  ).resolves.toBeUndefined();
});

async function gitRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'xapt-result-verification-'));
  directories.push(repository);
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'xapt test']);
  await git(repository, ['config', 'user.email', 'xapt@example.com']);
  await writeFile(join(repository, 'base.txt'), 'base\n');
  await git(repository, ['add', 'base.txt']);
  await git(repository, ['commit', '-m', 'chore: base']);
  return repository;
}

async function git(repository: string, args: string[]): Promise<string> {
  const result = await new NodeCommandRunner().run('git', [
    '-C',
    repository,
    ...args,
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
