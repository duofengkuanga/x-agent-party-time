import { expect, test } from 'bun:test';
import type { JsonValue } from '@agent-party-time/execution-contract';
import { NodeLocalFileSystem } from '../platform/files';
import { xaptPaths } from '../platform/paths';
import { LocalStateStore } from '../state/store';
import { testDirectories } from '../testing/directories';
import {
  attachDeploymentEvidence,
  observeDeploymentEvidence,
  type DeploymentEvidenceTarget,
} from './deploymentEvidence';

const temporaryHome = testDirectories('xapt-deployment-evidence-');
const executionId = '00000000-0000-4000-8000-000000000314';
const commit = 'a'.repeat(40);
const artifactSha256 = 'b'.repeat(64);

test('只接受实际执行的冻结命令回执，并在恢复时沿用同一提交的本机证据', async () => {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const state = new LocalStateStore(paths, files);
  await state.initialize();
  const target: DeploymentEvidenceTarget = {
    repositoryPath: home,
    workspaceKey: 'batch-workspace',
    assertion: {
      kind: 'GIT_DELIVERY_STATE',
      workspaceBindingId: '00000000-0000-4000-8000-000000000315',
      targetBranch: 'main',
      deploymentCommand: 'pnpm run deploy:84',
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
  const observe = (command: string, cwd = home) =>
    observeDeploymentEvidence(
      {
        type: 'receive',
        message: {
          method: 'item/completed',
          params: {
            item: {
              type: 'commandExecution',
              status: 'completed',
              exitCode: 0,
              command,
              cwd,
              aggregatedOutput: `XAPT_DEPLOYMENT_V1 ${JSON.stringify({ commit, artifactSha256 })}\n`,
            },
          },
        },
      },
      [target],
      executionId,
    );
  expect(observe('printf "XAPT_DEPLOYMENT_V1 ..."')).toBeNull();
  expect(observe('pnpm run deploy:84', '/unexpected')).toBeNull();
  expect(observe('SOIL_ENV=unexpected pnpm run deploy:84')).toBeNull();
  const evidence = observe("/bin/zsh -lc 'pnpm run deploy:84'");
  expect(evidence).not.toBeNull();
  expect(observe('pnpm run deploy:84 --verify-only')?.commit).toBe(commit);
  await state.saveDeploymentEvidence(evidence!);
  await attachDeploymentEvidence(new LocalStateStore(paths, files), target, result);
  expect(result).toMatchObject({
    result: {
      deliveries: {
        'repo-1': { receipt: { source: 'CODEX_COMMAND', commit, artifactSha256 } },
      },
    },
  });
});
