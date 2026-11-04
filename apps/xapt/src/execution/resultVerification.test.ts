import { testDirectories } from '../testing/directories';
import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import type { ExecutionResultAssertion } from '@agent-party-time/execution-contract';
import { NodeCommandRunner } from '../platform/system';
import { GitExecutionResultVerifier } from './resultVerification';

const createTestDirectory = testDirectories('xapt-result-verification-');
const assertions: ExecutionResultAssertion[] = [
  { kind: 'GIT_COMMITS_CREATED', resultPath: ['result', 'commits'] },
];

test('纯结果字符串约束在上传前执行，不依赖 Git 工作区或基线', async () => {
  const verifier = new GitExecutionResultVerifier(new NodeCommandRunner());
  const rules: ExecutionResultAssertion[] = [
    {
      kind: 'JSON_STRING_PATTERN',
      resultPath: ['result', 'context'],
      pattern: '^[a-z ]*$',
    },
  ];
  await expect(
    verifier.verify('', rules, null, {
      result: { context: { note: 'portable text', nested: ['allowed'] } },
    }),
  ).resolves.toBeUndefined();
  await expect(
    verifier.verify('', rules, null, {
      result: { context: { nested: ['NOT_ALLOWED'] } },
    }),
  ).rejects.toThrow('字符串约束');
  await expect(
    verifier.verify('', rules, null, { result: { outcome: 'FAILED' } }),
  ).resolves.toBeUndefined();
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
  ).rejects.toThrow('Codex 返回的本地 Commit 不存在');
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

test('拒绝把脏工作区或丢失基线的 Git 历史当成修复完成', async () => {
  const repository = await gitRepository();
  const verifier = new GitExecutionResultVerifier(new NodeCommandRunner());
  await git(repository, ['commit', '--allow-empty', '-m', 'repair baseline']);
  const baseline = await verifier.capture(repository, assertions);
  await writeFile(join(repository, 'draft.txt'), 'unfinished\n');
  const reported = { result: { commits: [] } };
  await expect(
    verifier.verify(repository, assertions, baseline, reported),
  ).rejects.toThrow('未提交');
  await git(repository, ['add', 'draft.txt']);
  await git(repository, ['commit', '-m', 'save draft']);
  await git(repository, ['switch', '--detach', 'HEAD~2']);
  await expect(
    verifier.verify(repository, assertions, baseline, reported),
  ).rejects.toThrow('不包含执行前基线');
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

test('更新结果核对远端目标的完整 SHA，未改动成员必须仍在原基线', async () => {
  const repository = await gitRepository();
  const remote = await createTestDirectory();
  await git(remote, ['init', '--bare']);
  await git(repository, ['remote', 'add', 'origin', remote]);
  await git(repository, ['push', 'origin', 'HEAD:main']);
  const verifier = new GitExecutionResultVerifier(new NodeCommandRunner());
  const assertions: ExecutionResultAssertion[] = [
    {
      kind: 'GIT_DELIVERY_STATE',
      workspaceBindingId: '00000000-0000-4000-8000-000000000101',
      targetBranch: 'main',
      resultPath: ['result', 'deliveries', 'repo-1'],
    },
  ];
  const baseline = await verifier.capture(repository, assertions);
  await git(repository, ['commit', '--allow-empty', '-m', 'integrated']);
  const head = await git(repository, ['rev-parse', 'HEAD']);
  const result = (state: string, commit?: string) => ({
    result: { deliveries: { 'repo-1': { state, commit: commit ?? null } } },
  });
  await expect(
    verifier.verify(repository, assertions, baseline, result('UNCHANGED')),
  ).rejects.toThrow('未交付提交');
  await expect(
    verifier.verify(repository, assertions, baseline, result('DEPLOYED', head)),
  ).rejects.toThrow('远端分支尚未确认');
  await git(repository, ['push', 'origin', 'HEAD:main']);
  await expect(
    verifier.verify(repository, assertions, baseline, result('DEPLOYED', head)),
  ).resolves.toBeUndefined();
});

async function gitRepository(): Promise<string> {
  const repository = await createTestDirectory();
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'xapt test']);
  await git(repository, ['config', 'user.email', 'xapt@example.com']);
  await writeFile(join(repository, 'base.txt'), 'base\n');
  await git(repository, ['add', 'base.txt']);
  await git(repository, ['commit', '-m', 'chore: base']);
  return repository;
}

async function git(repository: string, args: string[]): Promise<string> {
  const result = await new NodeCommandRunner().run('git', ['-C', repository, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
