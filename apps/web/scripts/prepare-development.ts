import { rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { serverPaths } from '@/server/config';
import { openDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';

type PreparationResult = {
  database: string;
  reset: boolean;
};

const repositoryScratch = resolve(import.meta.dir, '../../..', '.scratch');

export function prepareDevelopmentDatabase(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PreparationResult {
  const paths = serverPaths(env);
  assertDisposableDevelopmentHome(paths.root);

  try {
    openDatabase(paths.database).close();
    return { database: paths.database, reset: false };
  } catch (error) {
    if (
      !(error instanceof PlatformError) ||
      error.code !== 'SCHEMA_VERSION_MISMATCH'
    )
      throw error;
  }

  rmSync(paths.server, { force: true, recursive: true });
  openDatabase(paths.database).close();
  return { database: paths.database, reset: true };
}

function assertDisposableDevelopmentHome(home: string): void {
  const relativeHome = relative(repositoryScratch, home);
  if (
    relativeHome === '' ||
    relativeHome === '..' ||
    relativeHome.startsWith(`..${sep}`) ||
    isAbsolute(relativeHome)
  )
    throw new Error('开发数据目录必须位于仓库 .scratch 内');
}

if (import.meta.main) {
  const result = prepareDevelopmentDatabase();
  if (result.reset)
    process.stdout.write(
      `[dev] 已重建 Schema 不匹配的开发数据库：${result.database}\n`,
    );
}
