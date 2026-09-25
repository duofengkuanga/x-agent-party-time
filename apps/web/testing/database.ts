import { afterEach } from 'bun:test';
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
