import { createHash } from 'node:crypto';
import type { Execution } from '@agent-party-time/execution-contract';
import { PlatformError } from '@/platform/errors';
import type { ExecutionRecords, ExecutionRow } from './records';
export const ACTIVE_STATES = [
  'QUEUED',
  'CLAIMED',
  'RUNNING',
  'WAITING_FOR_INTERACTION',
  'WAITING_TO_RESUME',
  'CANCEL_REQUESTED',
] as const;
export const LEASED_STATES = [
  'CLAIMED',
  'RUNNING',
  'WAITING_FOR_INTERACTION',
  'WAITING_TO_RESUME',
  'CANCEL_REQUESTED',
] as const;
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function newLeaseExpiry(now: Date, durationMs: number): string {
  return new Date(now.getTime() + durationMs).toISOString();
}

export function requireLeasedExecution(
  records: ExecutionRecords,
  now: () => Date,
  runnerId: string,
  executionId: string,
  leaseToken: string,
  states: Execution['state'][],
): ExecutionRow {
  const row = records.getRow(executionId);
  if (row.runner_id !== runnerId)
    throw new PlatformError('NOT_FOUND', '处理任务不存在');
  requireLeasedRow(now, row, leaseToken, states);
  return row;
}

export function requireLeasedRow(
  now: () => Date,
  row: ExecutionRow,
  leaseToken: string,
  states: Execution['state'][],
): void {
  if (
    !states.includes(row.state) ||
    !row.lease_token_hash ||
    row.lease_token_hash !== hashSecret(leaseToken) ||
    !row.lease_expires_at
  )
    throw new PlatformError('LEASE_EXPIRED', '任务领取凭据已失效');
  if (Date.parse(row.lease_expires_at) <= now().getTime())
    throw new PlatformError('LEASE_EXPIRED', '任务领取凭据已失效');
}
