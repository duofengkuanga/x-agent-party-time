import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

export type ServerPaths = {
  root: string;
  server: string;
  database: string;
  files: string;
};

export function serverPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServerPaths {
  const root = resolve(
    /* turbopackIgnore: true */
    env.AGENT_PARTY_TIME_HOME ?? join(homedir(), '.agent-party-time'),
  );
  const server = join(root, 'server');
  return {
    root,
    server,
    database: join(server, 'server.sqlite'),
    files: join(server, 'files'),
  };
}

export function sessionDurationMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = env.AGENT_PARTY_TIME_SESSION_DURATION_MS;
  if (!configured) return DEFAULT_SESSION_DURATION_MS;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('AGENT_PARTY_TIME_SESSION_DURATION_MS 必须是正整数');
  return value;
}
