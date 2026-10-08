import { createHash } from 'node:crypto';
import { parseRow, type DatabaseRow } from '@/platform/database/row-mapper';
import { RunnerSchema, type Runner } from './contract';

export type RunnerRow = DatabaseRow<Runner> & { credential_hash: string };

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function mapRunner(row: RunnerRow): Runner {
  return parseRow(RunnerSchema, row);
}
