import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import type {
  ExecutionResultAssertion,
  JsonValue,
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
const receiptSchema = z.strictObject({
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

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
  const single = `'${expected.replaceAll("'", "'\\''")}'`;
  const double = `"${expected.replace(/[\\"$\x60]/gu, '\\$&')}"`;
  return text === expected || (Boolean(shell) && (text === single || text === double));
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
  const target = targets.find(({ repositoryPath, assertion }) => {
    const expected = assertion.deploymentCommand;
    if (!expected || resolve(item.cwd as string) !== resolve(repositoryPath))
      return false;
    const frontend = /^(npm|pnpm|bun) run deploy:(84|85|88)$/u.exec(expected);
    const verify = expected.endsWith(' --prepared')
      ? expected.replace(/ --prepared$/u, ' --verify-prepared')
      : frontend
        ? `${expected}${frontend[1] === 'npm' ? ' --' : ''} --verify-only`
        : null;
    return (
      commandMatches(item.command as string, expected) ||
      (verify !== null && commandMatches(item.command as string, verify))
    );
  });
  if (!target?.assertion.deploymentCommand) return null;
  const receipts = item.aggregatedOutput
    .slice(-16_384)
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(receiptPrefix));
  if (receipts.length !== 1 || receipts[0]!.length > 512) return null;
  try {
    const receipt = receiptSchema.parse(
      JSON.parse(receipts[0]!.slice(receiptPrefix.length)),
    );
    return {
      schemaVersion: 1,
      workspaceKey: target.workspaceKey,
      executionId,
      source: 'CODEX_COMMAND',
      commandSha256: deploymentCommandDigest(target.assertion.deploymentCommand),
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
  const command = target.assertion.deploymentCommand;
  if (!command) return;
  const value = valueAtPath(result, target.assertion.resultPath);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  delete value.receipt;
  if (value.state !== 'DEPLOYED') return;
  const evidence = await state.loadDeploymentEvidence(target.workspaceKey);
  if (
    !evidence ||
    evidence.commit !== value.commit ||
    evidence.commandSha256 !== deploymentCommandDigest(command)
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
  };
}
