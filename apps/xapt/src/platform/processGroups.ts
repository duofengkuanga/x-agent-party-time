import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** The managed App Server starts a new session; its descendant groups are owned. */
export async function ownedProcessGroups(rootPid: number): Promise<number[]> {
  const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,pgid=']);
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  if (!rows.some(([pid]) => pid === rootPid))
    throw new Error('执行进程已异常退出，无法确认原工具进程归属');
  const owned = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of rows) {
      if (pid && parent && owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
    }
  }
  return [
    ...new Set([
      rootPid,
      ...rows.flatMap(([pid, , group]) =>
        pid && group && owned.has(pid) ? [group] : [],
      ),
    ]),
  ];
}

export function processGroupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}
