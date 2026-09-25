import { createHash } from 'node:crypto';
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
