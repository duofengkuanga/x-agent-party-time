import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { serverPaths } from '@/platform/config';
import { initializeSchema } from './schema';

export class AppDatabase extends Database {
  get<T = unknown>(sql: string, ...bindings: SQLQueryBindings[]): T | null {
    return this.prepare<T, SQLQueryBindings[]>(sql).get(...bindings);
  }

  all<T = unknown>(sql: string, ...bindings: SQLQueryBindings[]): T[] {
    return this.prepare<T, SQLQueryBindings[]>(sql).all(...bindings);
  }
}

export function openDatabase(databasePath: string): AppDatabase {
  const resolvedPath = resolve(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const database = new AppDatabase(resolvedPath, {
    create: true,
    strict: true,
  });
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
