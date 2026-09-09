import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { serverPaths } from '@/platform/config';
import { initializeSchema } from './schema';

export type AppDatabase = Database;

export function openDatabase(databasePath: string): AppDatabase {
  const resolvedPath = resolve(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const database = new Database(resolvedPath, { create: true, strict: true });
  try {
    initializeSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

type DatabaseGlobal = typeof globalThis & {
  __agentPartyTimeDatabase?: AppDatabase;
};

export function database(): AppDatabase {
  const globalState = globalThis as DatabaseGlobal;
  if (!globalState.__agentPartyTimeDatabase)
    globalState.__agentPartyTimeDatabase = openDatabase(serverPaths().database);
  return globalState.__agentPartyTimeDatabase;
}
