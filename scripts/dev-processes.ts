import { spawnSync } from 'node:child_process';
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonControlClient } from '../apps/xapt/src/daemon/control.js';
import type { DaemonSnapshot } from '../apps/xapt/src/daemon/status.js';
import { xaptPaths } from '../apps/xapt/src/platform/paths.js';

export type ServiceKey = 'app' | 'agent';

export type ProcessRow = {
  pid: number;
  ppid: number;
  elapsed: string;
  command: string;
};

export type ServiceProcess = ProcessRow & {
  service: ServiceKey;
  cwd: string;
};

type ServiceMatcher = {
  pattern: RegExp;
  relativeCwds: readonly string[];
};

type ServiceDefinition = {
  key: ServiceKey;
  label: string;
  matchers: readonly ServiceMatcher[];
};

const PROJECT_ROOT = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..'),
);

const BUN = String.raw`(?:^|\s)(?:\S*\/)?bun`;

const SERVICE_DEFINITIONS: readonly ServiceDefinition[] = [
  {
    key: 'app',
    label: 'App',
    matchers: [
      {
        pattern: new RegExp(`${BUN}\\s+run\\s+dev:app(?:\\s|$)`),
        relativeCwds: ['.'],
      },
      {
        pattern: new RegExp(
          `${BUN}\\s+--cwd\\s+(?:\\S*\/)?apps/web\\s+dev(?:\\s|$)`,
        ),
        relativeCwds: ['.', 'apps/web'],
      },
      {
        pattern: /(?:^|\s)(?:\S*\/)?next\s+dev(?:\s|$)|next-server/u,
        relativeCwds: ['apps/web'],
      },
    ],
  },
  {
    key: 'agent',
    label: 'Agent',
    matchers: [],
  },
];

export function parseProcessTable(output: string): ProcessRow[] {
  return output
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsed: match[3]!,
      command: match[4]!,
    }));
}

function readProcessTable(): ProcessRow[] {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || '无法读取系统进程列表');
  return parseProcessTable(result.stdout);
}

function normalizeExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return normalize(path);
  }
}

function readProcessCwd(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  if (process.platform === 'darwin') {
    const result = spawnSync(
      'lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { encoding: 'utf8' },
    );
    if (result.error || result.status !== 0) return null;
    const pathLine = result.stdout
      .split('\n')
      .find((line) => line.startsWith('n'));
    return pathLine?.slice(1) || null;
  }

  return null;
}

function projectRelativePath(cwd: string, projectRoot: string): string | null {
  const normalizedCwd = normalizeExistingPath(cwd);
  const normalizedRoot = normalizeExistingPath(projectRoot);
  const path = relative(normalizedRoot, normalizedCwd);
  if (path === '') return '.';
  if (path === '..' || path.startsWith(`..${sep}`)) return null;
  return path.split(sep).join('/');
}

function commandCouldMatch(command: string): boolean {
  return SERVICE_DEFINITIONS.some((definition) =>
    definition.matchers.some((matcher) => matcher.pattern.test(command)),
  );
}

export function discoverServiceProcesses(
  rows: readonly ProcessRow[],
  cwdForPid: (pid: number) => string | null,
  projectRoot = PROJECT_ROOT,
): ServiceProcess[] {
  const matches: ServiceProcess[] = [];

  for (const row of rows) {
    if (!commandCouldMatch(row.command)) continue;
    const cwd = cwdForPid(row.pid);
    if (!cwd) continue;
    const relativeCwd = projectRelativePath(cwd, projectRoot);
    if (!relativeCwd) continue;

    const definition = SERVICE_DEFINITIONS.find((candidate) =>
      candidate.matchers.some(
        (matcher) =>
          matcher.relativeCwds.includes(relativeCwd) &&
          matcher.pattern.test(row.command),
      ),
    );
    if (definition) matches.push({ ...row, service: definition.key, cwd });
  }

  return matches;
}

export function collectDescendantPids(
  rows: readonly ProcessRow[],
  rootPids: ReadonlySet<number>,
): Set<number> {
  const selected = new Set(rootPids);
  let changed = true;

  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && selected.has(row.ppid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }

  return selected;
}

export function findServiceRoots(
  processes: readonly ServiceProcess[],
): ServiceProcess[] {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));

  return processes.filter((entry) => {
    let parent = byPid.get(entry.ppid);
    while (parent) {
      if (parent.service === entry.service) return false;
      parent = byPid.get(parent.ppid);
    }
    return true;
  });
}

function printStatus(
  processes: readonly ServiceProcess[],
  agent: DaemonSnapshot,
): void {
  const roots = findServiceRoots(processes);
  console.log('开发服务状态：');

  for (const definition of SERVICE_DEFINITIONS) {
    if (definition.key === 'agent') {
      const detail =
        agent.service === 'RUNNING'
          ? `运行中，${agent.activeSlots} / ${agent.totalSlots} 个执行槽使用中`
          : agent.service === 'UNRESPONSIVE'
            ? '无响应'
            : '未运行';
      console.log(`- ${definition.label}：${detail}`);
      continue;
    }
    const serviceRoots = roots.filter(
      (entry) => entry.service === definition.key,
    );
    if (serviceRoots.length === 0) {
      console.log(`- ${definition.label}：未运行`);
      continue;
    }

    const instances = serviceRoots
      .map((entry) => `PID ${entry.pid}（${entry.elapsed}）`)
      .join('、');
    console.log(`- ${definition.label}：运行中，${instances}`);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForExit(
  pids: ReadonlySet<number>,
  timeoutMs: number,
): Promise<Set<number>> {
  const deadline = Date.now() + timeoutMs;
  let remaining = new Set([...pids].filter(processIsAlive));

  while (remaining.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = new Set([...remaining].filter(processIsAlive));
  }

  return remaining;
}

function signalProcesses(
  pids: Iterable<number>,
  signal: NodeJS.Signals,
): string[] {
  const errors: string[] = [];

  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH')
        errors.push(`PID ${pid}: ${(error as Error).message}`);
    }
  }

  return errors;
}

async function stopServices(
  rows: readonly ProcessRow[],
  processes: readonly ServiceProcess[],
  agent: DaemonSnapshot,
  stopAgent: () => Promise<void>,
): Promise<number> {
  if (processes.length === 0 && agent.service === 'STOPPED') {
    console.log('没有发现正在运行的开发服务。');
    return 0;
  }

  if (agent.service === 'UNRESPONSIVE') {
    console.error('停止失败：xapt 开发 daemon 本机控制无响应。');
    return 1;
  }

  if (agent.service === 'RUNNING') {
    try {
      await stopAgent();
    } catch (error) {
      console.error(
        `停止失败：${error instanceof Error ? error.message : 'xapt daemon 控制失败'}`,
      );
      return 1;
    }
  }

  const matchedPids = new Set(processes.map((entry) => entry.pid));
  const targetPids = collectDescendantPids(rows, matchedPids);
  targetPids.delete(process.pid);

  const serviceRoots = findServiceRoots(processes);
  const grouped = SERVICE_DEFINITIONS.map((definition) => {
    if (definition.key === 'agent')
      return agent.service === 'RUNNING' ? 'Agent 1 组' : null;
    const count = serviceRoots.filter(
      (entry) => entry.service === definition.key,
    ).length;
    return count > 0 ? `${definition.label} ${count} 组` : null;
  }).filter((value): value is string => value !== null);

  console.log(`正在停止：${grouped.join('、')}。`);
  const errors = signalProcesses(targetPids, 'SIGTERM');
  let remaining = await waitForExit(targetPids, 5_000);

  if (remaining.size > 0) {
    console.warn(
      `仍有 ${remaining.size} 个进程未退出，正在发送 SIGKILL：${[...remaining].join(', ')}`,
    );
    errors.push(...signalProcesses(remaining, 'SIGKILL'));
    remaining = await waitForExit(remaining, 1_000);
  }

  if (errors.length > 0 || remaining.size > 0) {
    for (const error of errors) console.error(`停止失败：${error}`);
    if (remaining.size > 0)
      console.error(`仍在运行：${[...remaining].join(', ')}`);
    return 1;
  }

  console.log('App、Agent 开发服务已全部停止。');
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const action = argv[0] ?? 'status';
  if (action !== 'status' && action !== 'stop') {
    console.error('用法：bun run status | bun run stop');
    return 2;
  }

  const rows = readProcessTable();
  const processes = discoverServiceProcesses(rows, readProcessCwd);
  const developmentHome = resolve(PROJECT_ROOT, '.scratch/xapt-development');
  const control = new DaemonControlClient(
    xaptPaths(developmentHome).controlSocket,
  );
  let agent: DaemonSnapshot;
  const controlSocket = xaptPaths(developmentHome).controlSocket;
  if (!existsSync(controlSocket)) {
    agent = stoppedSnapshotForDevelopment();
  } else {
    try {
      agent = await control.status();
    } catch {
      agent = {
        ...stoppedSnapshotForDevelopment(),
        service: 'UNRESPONSIVE',
      };
    }
  }
  if (action === 'status') {
    printStatus(processes, agent);
    return 0;
  }

  return stopServices(rows, processes, agent, async () => {
    await control.stop(false);
  });
}

function stoppedSnapshotForDevelopment(): DaemonSnapshot {
  return {
    service: 'STOPPED',
    connection: 'UNCONFIGURED',
    activity: 'IDLE',
    version: 'development',
    codexVersion: null,
    serverOrigin: null,
    agentName: null,
    lastHeartbeatAt: null,
    activeSlots: 0,
    totalSlots: 3,
    waitingInteractions: 0,
    outboxCount: 0,
    bindingCount: 0,
    bindingActive: false,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url))
  process.exitCode = await main();
