import { describe, expect, test } from 'bun:test';
import {
  collectDescendantPids,
  discoverServiceProcesses,
  findServiceRoots,
  parseProcessTable,
  type ProcessRow,
} from './dev-processes.js';

const projectRoot = '/workspace/agent-party-time';

function row(
  pid: number,
  ppid: number,
  command: string,
  elapsed = '00:10',
): ProcessRow {
  return { pid, ppid, command, elapsed };
}

describe('parseProcessTable', () => {
  test('保留命令中的空格', () => {
    expect(
      parseProcessTable(
        '  101   10  01:02 bun run dev:app\n  102  101  00:59 next dev\n',
      ),
    ).toEqual([
      row(101, 10, 'bun run dev:app', '01:02'),
      row(102, 101, 'next dev', '00:59'),
    ]);
  });
});

describe('discoverServiceProcesses', () => {
  test('只匹配当前仓库中的 App 与 Runner', () => {
    const rows = [
      row(101, 10, 'bun run dev:app'),
      row(102, 101, 'bun --cwd apps/web dev'),
      row(103, 102, 'next dev'),
      row(201, 20, 'bun run dev:runner'),
      row(202, 201, 'bun packages/runner/src/index.ts start'),
      row(301, 30, 'bun run dev:app'),
      row(501, 50, 'bun test'),
    ];
    const cwdByPid = new Map([
      [101, projectRoot],
      [102, `${projectRoot}/apps/web`],
      [103, `${projectRoot}/apps/web`],
      [201, projectRoot],
      [202, projectRoot],
      [301, '/workspace/another-project'],
      [501, projectRoot],
    ]);

    const matches = discoverServiceProcesses(
      rows,
      (pid) => cwdByPid.get(pid) ?? null,
      projectRoot,
    );

    expect(matches.map(({ pid, service }) => [pid, service])).toEqual([
      [101, 'app'],
      [102, 'app'],
      [103, 'app'],
      [201, 'runner'],
      [202, 'runner'],
    ]);
    expect(findServiceRoots(matches).map(({ pid }) => pid)).toEqual([101, 201]);
  });
});

describe('collectDescendantPids', () => {
  test('包含 Runner 派生出的 Codex 子进程', () => {
    const rows = [
      row(101, 10, 'bun run dev:runner'),
      row(102, 101, 'bun packages/runner/src/index.ts start'),
      row(103, 102, 'codex app-server'),
      row(104, 103, 'worker child'),
      row(201, 20, 'unrelated process'),
    ];

    expect([...collectDescendantPids(rows, new Set([101, 102]))]).toEqual([
      101, 102, 103, 104,
    ]);
  });
});
