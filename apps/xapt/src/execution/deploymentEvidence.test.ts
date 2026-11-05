import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonValue } from '@agent-party-time/execution-contract';
import { NodeLocalFileSystem } from '../platform/files';
import { xaptPaths } from '../platform/paths';
import { LocalStateStore } from '../state/store';
import { testDirectories } from '../testing/directories';
import {
  attachDeploymentEvidence,
  observeDeploymentEvidence,
  readEngineeringDelivery,
  type DeploymentEvidenceTarget,
} from './deploymentEvidence';

const temporaryHome = testDirectories('xapt-deployment-evidence-');
const executionId = '00000000-0000-4000-8000-000000000314';
const artifactSha256 = 'b'.repeat(64);

test('只接受目标环境约定中的实际命令回执，并在恢复时沿用同一提交的本机证据', async () => {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const state = new LocalStateStore(paths, files);
  await state.initialize();
  const repository = join(home, 'repo');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  await mkdir(join(repository, '.xapt'), { recursive: true });
  git('init', '-q');
  await writeFile(
    join(repository, '.xapt/README.md'),
    '```xapt-delivery\n' +
      JSON.stringify({
        prepare: 'sh tools/prepare.sh',
        environments: [
          {
            key: '84',
            deploy: 'sh tools/install.sh red',
            verify: 'sh tools/check.sh red',
          },
          {
            key: '85',
            deploy: 'sh tools/install.sh blue',
            verify: 'sh tools/check.sh blue',
          },
        ],
      }) +
      '\n```\n',
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'convention',
  );
  const commit = git('rev-parse', 'HEAD');
  const target: DeploymentEvidenceTarget = {
    repositoryPath: repository,
    workspaceKey: 'batch-workspace',
    assertion: {
      kind: 'GIT_DELIVERY_STATE',
      workspaceBindingId: '00000000-0000-4000-8000-000000000315',
      targetBranch: 'main',
      environmentKey: '84',
      resultPath: ['result', 'deliveries', 'repo-1'],
    },
  };
  const result: JsonValue = {
    result: {
      outcome: 'COMPLETED',
      deliveries: {
        'repo-1': { state: 'DEPLOYED', commit, receipt: { artifactSha256 } },
      },
    },
  };
  await expect(attachDeploymentEvidence(state, target, result)).rejects.toThrow(
    '本机部署验收回执',
  );
  const observe = (
    command: string,
    cwd = repository,
    environmentKey = '84',
    exitCode = 0,
    sourceCommit = commit,
  ) =>
    observeDeploymentEvidence(
      {
        type: 'receive',
        message: {
          method: 'item/completed',
          params: {
            item: {
              type: 'commandExecution',
              status: 'completed',
              exitCode,
              command,
              cwd,
              aggregatedOutput: `XAPT_DEPLOYMENT_V1 ${JSON.stringify({ commit: sourceCommit, artifactSha256, environmentKey })}\n`,
            },
          },
        },
      },
      [target],
      executionId,
    );
  expect(observe('printf "XAPT_DEPLOYMENT_V1 ..."')).toBeNull();
  expect(observe('sh tools/install.sh red', '/unexpected')).toBeNull();
  expect(observe('DEPLOY_ENV=unexpected sh tools/install.sh red')).toBeNull();
  expect(observe('sh tools/install.sh blue')).toBeNull();
  expect(observe('sh tools/install.sh red', repository, '85')).toBeNull();
  expect(observe('sh tools/install.sh red', repository, '84', 1)).toBeNull();
  const evidence = observe("/bin/zsh -lc 'sh tools/install.sh red'");
  expect(evidence).toMatchObject({ conventionPath: '.xapt/README.md' });
  expect(observe('sh tools/check.sh red')?.commit).toBe(commit);
  expect(
    observe('sh tools/check.sh red', repository, '84', 0, 'b'.repeat(40)),
  ).toBeNull();
  await state.saveDeploymentEvidence(evidence!);
  await attachDeploymentEvidence(new LocalStateStore(paths, files), target, result);
  expect(result).toMatchObject({
    result: {
      deliveries: {
        'repo-1': { receipt: { source: 'CODEX_COMMAND', commit, artifactSha256 } },
      },
    },
  });
  await writeFile(
    join(repository, 'AGENTS.md'),
    '[工程执行约定](delivery.md)\n[工程执行约定](other.md)\n',
  );
  expect(observe('sh tools/check.sh red')).toBeNull();
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'unrelated agent instructions',
  );
  expect(
    observe('sh tools/check.sh red', repository, '84', 0, git('rev-parse', 'HEAD')),
  ).not.toBeNull();
  const document = await readFile(join(repository, '.xapt/README.md'), 'utf8');
  await writeFile(join(repository, '.xapt/README.md'), document + document);
  expect(observe('sh tools/check.sh red')).toBeNull();
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'ambiguous delivery blocks',
  );
  expect(
    observe('sh tools/check.sh red', repository, '84', 0, git('rev-parse', 'HEAD')),
  ).toBeNull();
});

test('缺少固定约定文件时明确失败，不从 AGENTS.md 的旧链接发现交付入口', async () => {
  const repository = await temporaryHome();
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  await writeFile(join(repository, 'AGENTS.md'), '[工程执行约定](delivery.md)\n');
  await writeFile(
    join(repository, 'delivery.md'),
    '```xapt-delivery\n' +
      JSON.stringify({
        prepare: 'sh tools/prepare.sh',
        environments: [
          { key: '84', deploy: 'sh tools/deploy.sh', verify: 'sh tools/verify.sh' },
        ],
      }) +
      '\n```\n',
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'legacy pointer only',
  );
  expect(() =>
    readEngineeringDelivery(repository, git('rev-parse', 'HEAD'), '84'),
  ).toThrow('.xapt/README.md');
});
