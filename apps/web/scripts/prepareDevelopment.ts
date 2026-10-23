import { isAbsolute, relative, resolve, sep } from 'node:path';
import { serverPaths } from '@/server/config';
import { openDatabase } from '@/server/database/index';

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

  openDatabase(paths.database).close();
  return { database: paths.database, reset: false };
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
    process.stdout.write(`[dev] 已重建 Schema 不匹配的开发数据库：${result.database}\n`);
}
