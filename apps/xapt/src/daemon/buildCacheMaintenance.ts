import { readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { LocalFileSystem } from '../platform/files';
import type { XaptPaths } from '../platform/paths';
import type { LocalStateStore } from '../state/store';

const hourMs = 60 * 60 * 1_000;
const dayMs = 24 * hourMs;
const RegistrationSchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        bindingId: z.uuid(),
        revision: z.string().regex(/^[a-f0-9]{40}$/u),
      }),
    )
    .max(100),
});
const MaintenanceReportSchema = z.object({
  nextCheckAt: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  issues: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(20),
});
const PackageScriptsSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
});
const registeredCommand =
  /^node (scripts\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:js|cjs|mjs)) --maintain$/u;
const nodeVersion = /^v?(\d+(?:\.\d+){0,2})$/u;

export async function runBuildCacheMaintenance(
  paths: XaptPaths,
  state: LocalStateStore,
  files: LocalFileSystem,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let nextCheckAt = Date.now() + hourMs;
    try {
      nextCheckAt = await maintainBuildCaches(paths, state, files, signal);
    } catch {
      if (!signal.aborted) console.warn('无法检查本机登记的构建缓存，下次维护时重试。');
    }
    try {
      await delay(Math.max(60_000, nextCheckAt - Date.now()), undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

export async function maintainBuildCaches(
  paths: XaptPaths,
  state: LocalStateStore,
  files: LocalFileSystem,
  signal: AbortSignal,
): Promise<number> {
  let nextCheckAt = Date.now() + dayMs;
  const file = join(paths.state, 'buildCacheMaintenance.json');
  const registration = await files.info(file);
  if (!registration) return nextCheckAt;
  if (registration.type !== 'file' || registration.mode !== 0o600)
    throw new Error('本机缓存维护登记必须是权限为 0600 的普通文件');
  const configuration = RegistrationSchema.parse(
    JSON.parse((await readText(files, file, 64 * 1024)) ?? ''),
  );
  const { bindings } = await state.loadBindings();
  const checked = new Set<string>();
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: paths.home };
  for (const { bindingId, revision } of configuration.entries) {
    if (signal.aborted) return nextCheckAt;
    const binding = bindings[bindingId];
    if (!binding) continue;
    try {
      const cwd = await realpath(binding.repositoryPath);
      const manifest = await readText(files, join(cwd, 'package.json'), 256 * 1024);
      if (!manifest) continue;
      const { scripts } = PackageScriptsSchema.parse(JSON.parse(manifest));
      const command = scripts?.['build:cache:maintain'];
      if (command === undefined) continue;
      const script = registeredCommand.exec(command)?.[1];
      if (
        !script ||
        (await realpath(join(cwd, script))) !== join(cwd, script) ||
        (await files.info(join(cwd, script)))?.type !== 'file'
      )
        throw new Error('构建缓存维护入口不是工程内登记的脚本');
      const git = await readCommand(
        [
          'git',
          'rev-parse',
          '--path-format=absolute',
          '--show-toplevel',
          '--git-common-dir',
          'HEAD',
        ],
        cwd,
        env,
        signal,
      );
      const [topLevel, commonDirectory, head] = git?.split('\n') ?? [];
      if (
        !topLevel ||
        !commonDirectory ||
        head !== revision ||
        (await realpath(topLevel)) !== cwd
      )
        throw new Error('构建缓存所属仓库或当前版本与本机登记不符');
      const tracked = await readCommand(
        ['git', 'ls-files', '--error-unmatch', '--', 'package.json', script],
        cwd,
        env,
        signal,
      );
      const status = await readCommand(
        ['git', 'status', '--porcelain', '--untracked-files=no'],
        cwd,
        env,
        signal,
      );
      if (!tracked || status !== '') throw new Error('缓存维护要求已登记版本的干净检出');
      const commonGit = await realpath(commonDirectory);
      if (checked.has(commonGit)) continue;

      const declared = await declaredRuntime(files, cwd);
      const node = await resolveNode(paths, cwd, declared, env, signal);
      checked.add(commonGit);
      const report = await runRegisteredMaintenance(node, script, cwd, env, signal);
      nextCheckAt = Math.min(nextCheckAt, report.nextCheckAt);
      if (report.failures)
        console.warn(
          `构建缓存维护有 ${report.failures} 个失败条目。${report.issues.length ? ` 缓存标识 ${report.issues.join('、')}` : ''}`,
        );
    } catch {
      if (!signal.aborted) {
        console.warn('一个已登记仓库的构建缓存维护未完成，下次检查重试。');
        nextCheckAt = Math.min(nextCheckAt, Date.now() + hourMs);
      }
    }
  }
  return nextCheckAt;
}

async function runRegisteredMaintenance(
  node: string,
  script: string,
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const child = Bun.spawn([node, script, '--maintain'], {
    cwd,
    env: { ...env, PATH: `${dirname(node)}:${env.PATH}` },
    detached: true,
    maxBuffer: 16 * 1024,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const timeout = setTimeout(stop, 120_000);
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) stop();
    const [exitCode, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    const report = MaintenanceReportSchema.parse(JSON.parse(output.trim()));
    if (exitCode !== 0 && (exitCode !== 1 || report.failures === 0))
      throw new Error('构建缓存维护命令未成功');
    return report;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', stop);
    stop();
  }
}

async function declaredRuntime(
  files: LocalFileSystem,
  cwd: string,
): Promise<string | null> {
  for (const name of ['.nvmrc', '.node-version']) {
    const contents = await readText(files, join(cwd, name), 1_024);
    if (contents !== null) return contents.split('#', 1)[0]!.trim();
  }
  const tools = await readText(files, join(cwd, '.tool-versions'), 4_096);
  return tools?.match(/^nodejs\s+(\S+)/mu)?.[1] ?? null;
}

async function resolveNode(
  paths: XaptPaths,
  cwd: string,
  declared: string | null,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const requested = declared === null ? null : nodeVersion.exec(declared)?.[1];
  if (declared !== null && !requested) throw new Error('无法核对工程声明的 Node 版本');
  const matches = (version: string) =>
    requested === null || version === requested || version.startsWith(`${requested}.`);
  const configured = Bun.which('node', { PATH: env.PATH });
  const nvm = join(paths.home, '.nvm', 'versions', 'node');
  const installed = requested
    ? await readdir(nvm).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })
    : [];
  const candidates = [
    ...(configured ? [configured] : []),
    ...installed
      .filter((entry) => {
        const version = nodeVersion.exec(entry)?.[1];
        return version && matches(version);
      })
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      .map((entry) => join(nvm, entry, 'bin', 'node')),
  ];
  for (const candidate of candidates) {
    const version = await readCommand([candidate, '--version'], cwd, env, signal);
    const actual = version && nodeVersion.exec(version)?.[1];
    if (actual && matches(actual)) return candidate;
  }
  throw new Error('未找到符合工程声明的 Node 运行时');
}

async function readText(
  files: LocalFileSystem,
  filename: string,
  limit: number,
): Promise<string | null> {
  const info = await files.info(filename);
  if (!info) return null;
  if (info.type !== 'file' || info.size > limit) throw new Error('本机登记文件无效');
  const bytes = await files.read(filename);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

async function readCommand(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const child = Bun.spawn(cmd, {
      cwd,
      env,
      signal,
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4_096,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [exitCode, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    return exitCode === 0 ? output.trim() : null;
  } catch {
    return null;
  }
}
