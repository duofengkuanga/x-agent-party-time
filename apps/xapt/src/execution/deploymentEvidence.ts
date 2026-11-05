import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import {
  DeploymentReceiptSchema,
  EnvironmentKeySchema,
  type ExecutionResultAssertion,
  type JsonValue,
} from '@agent-party-time/execution-contract';
import type { CodexObservationNotice } from '../observability/protocol';
import type { LocalStateStore } from '../state/store';
import type { DeploymentEvidence } from '../state/schemas';
import { ExecutionResultVerificationError, valueAtPath } from './resultVerification';

type DeliveryAssertion = Extract<
  ExecutionResultAssertion,
  { kind: 'GIT_DELIVERY_STATE' }
>;
export type DeploymentEvidenceTarget = {
  repositoryPath: string;
  workspaceKey: string;
  assertion: DeliveryAssertion;
};

const receiptPrefix = 'XAPT_DEPLOYMENT_V1 ';
const receiptSchema = DeploymentReceiptSchema.pick({
  commit: true,
  artifactSha256: true,
  environmentKey: true,
});
const entry = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .regex(/^[a-zA-Z0-9_./:@ -]+$/u);
const deliverySchema = z.strictObject({
  prepare: entry,
  environments: z
    .array(
      z.strictObject({
        key: EnvironmentKeySchema,
        deploy: entry,
        verify: entry,
      }),
    )
    .min(1)
    .max(50),
});

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  return execFileSync('git', ['-C', cwd, ...args], {
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function readEngineeringDelivery(cwd: string, environmentKey: string) {
  try {
    const conventionPath = '.xapt/README.md';
    const document = readFileSync(resolve(cwd, conventionPath), 'utf8');
    const blocks = [...document.matchAll(/^```xapt-delivery\r?\n([\s\S]*?)^```\r?$/gmu)];
    if (blocks.length !== 1) throw new Error('工程约定必须提供唯一的交付配置块');
    const config = deliverySchema.parse(JSON.parse(blocks[0]![1]!));
    const keys = new Set(config.environments.map(({ key }) => key));
    const commands = new Set([
      config.prepare,
      ...config.environments.flatMap(({ deploy, verify }) => [deploy, verify]),
    ]);
    if (
      keys.size !== config.environments.length ||
      commands.size !== config.environments.length * 2 + 1
    )
      throw new Error('工程约定包含重复的环境或交付入口');
    const environment = config.environments.find(({ key }) => key === environmentKey);
    if (!environment) throw new Error('工程约定缺少目标环境的交付入口');
    return {
      ...environment,
      conventionPath,
      conventionSha256: deploymentCommandDigest(document),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('工程')) throw error;
    throw new Error('工程执行约定 .xapt/README.md 不可读或交付入口无效');
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function commandMatches(actual: string, expected: string): boolean {
  const shell = actual
    .trim()
    .match(/^(?:\/bin\/)?(?:bash|zsh|sh) (?:-lc|-c) ([\s\S]+)$/u);
  const text = shell?.[1] ?? actual.trim();
  return (
    text === expected ||
    (Boolean(shell) && (text === `'${expected}'` || text === `"${expected}"`))
  );
}

export function deploymentCommandDigest(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

export function observeDeploymentEvidence(
  notice: CodexObservationNotice,
  targets: DeploymentEvidenceTarget[],
  executionId: string,
): DeploymentEvidence | null {
  if (notice.type !== 'receive') return null;
  const message = record(notice.message);
  if (message.method !== 'item/completed') return null;
  const item = record(record(message.params).item);
  if (
    item.type !== 'commandExecution' ||
    item.status !== 'completed' ||
    item.exitCode !== 0 ||
    typeof item.command !== 'string' ||
    typeof item.cwd !== 'string' ||
    typeof item.aggregatedOutput !== 'string'
  )
    return null;
  const target = targets.find(
    ({ repositoryPath, assertion }) =>
      assertion.environmentKey && resolve(item.cwd as string) === resolve(repositoryPath),
  );
  if (!target) return null;
  const receipts = item.aggregatedOutput
    .slice(-16_384)
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(receiptPrefix));
  if (receipts.length !== 1 || receipts[0]!.length > 512) return null;
  try {
    const receipt = receiptSchema.parse(
      JSON.parse(receipts[0]!.slice(receiptPrefix.length)),
    );
    if (
      receipt.environmentKey !== target.assertion.environmentKey ||
      git(target.repositoryPath, 'rev-parse', 'HEAD').trim() !== receipt.commit ||
      git(target.repositoryPath, 'status', '--porcelain')
    )
      return null;
    const convention = readEngineeringDelivery(
      target.repositoryPath,
      receipt.environmentKey,
    );
    const command = [convention.deploy, convention.verify].find((expected) =>
      commandMatches(item.command as string, expected),
    );
    if (!command) return null;
    return {
      schemaVersion: 2,
      workspaceKey: target.workspaceKey,
      executionId,
      source: 'CODEX_COMMAND',
      commandSha256: deploymentCommandDigest(command),
      conventionPath: convention.conventionPath,
      conventionSha256: convention.conventionSha256,
      recordedAt: new Date().toISOString(),
      ...receipt,
    };
  } catch {
    return null;
  }
}

export async function attachDeploymentEvidence(
  state: LocalStateStore,
  target: DeploymentEvidenceTarget,
  result: JsonValue,
): Promise<void> {
  const environmentKey = target.assertion.environmentKey;
  const value = valueAtPath(result, target.assertion.resultPath);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  delete value.receipt;
  if (value.state !== 'DEPLOYED') return;
  const evidence = await state.loadDeploymentEvidence(target.workspaceKey);
  const convention =
    environmentKey &&
    evidence &&
    evidence.commit === value.commit &&
    evidence.environmentKey === environmentKey
      ? readEngineeringDelivery(target.repositoryPath, environmentKey)
      : null;
  if (
    !evidence ||
    !convention ||
    evidence.conventionPath !== convention.conventionPath ||
    evidence.conventionSha256 !== convention.conventionSha256 ||
    ![convention.deploy, convention.verify].some(
      (command) => deploymentCommandDigest(command) === evidence.commandSha256,
    )
  ) {
    if (valueAtPath(result, ['result', 'outcome']) === 'FAILED') {
      value.state = 'UNKNOWN';
      value.evidence = '缺少与本批提交匹配的本机部署验收回执';
      return;
    }
    throw new ExecutionResultVerificationError('缺少与本批提交匹配的本机部署验收回执');
  }
  value.receipt = {
    source: evidence.source,
    commit: evidence.commit,
    commandSha256: evidence.commandSha256,
    artifactSha256: evidence.artifactSha256,
    environmentKey: evidence.environmentKey,
    conventionPath: evidence.conventionPath,
    conventionSha256: evidence.conventionSha256,
  };
}
