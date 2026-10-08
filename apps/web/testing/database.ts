import { afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type AppDatabase } from '@/platform/database';

/** Register per-suite cleanup before creating any isolated test databases. */
export function testDatabases() {
  const directories: string[] = [];
  const databases: AppDatabase[] = [];
  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
  return async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-party-test-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'server.sqlite'));
    databases.push(database);
    return { directory, database };
  };
}

/** Count fixture rows using only named equality conditions. */
export function countRows(
  database: AppDatabase,
  table: string,
  where: Record<string, string | number | null> = {},
): number {
  const conditions = Object.entries(where);
  const predicate = conditions.length
    ? ` WHERE ${conditions.map(([column]) => `${column} = ?`).join(' AND ')}`
    : '';
  return (
    database.get<{ count: number }>(
      `SELECT COUNT(*) count FROM ${table}${predicate}`,
      ...conditions.map(([, value]) => value),
    )?.count ?? 0
  );
}

export function expectRowCount(...args: Parameters<typeof countRows>) {
  return expect(countRows(...args));
}
