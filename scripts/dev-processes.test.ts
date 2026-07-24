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
        '  101   10  01:02 bun run dev:control-plane\n  102  101  00:59 bun --watch src/main.ts\n',
      ),
    ).toEqual([
      row(101, 10, 'bun run dev:control-plane', '01:02'),
      row(102, 101, 'bun --watch src/main.ts', '00:59'),
    ]);
  });
});

describe('discoverServiceProcesses', () => {
  test('只匹配当前仓库中的三个开发服务', () => {
    const rows = [
      row(101, 10, 'bun run dev:control-plane'),
      row(102, 101, 'bun --cwd services/control-plane dev'),
      row(103, 102, 'bun --watch src/main.ts'),
      row(201, 20, 'bun run dev:runner'),
      row(202, 201, 'bun packages/cli/src/index.ts start'),
      row(301, 30, 'bun run dev:web'),
      row(302, 301, 'next dev'),
      row(401, 40, 'bun run dev:web'),
      row(501, 50, 'bun test'),
    ];
    const cwdByPid = new Map([
      [101, projectRoot],
      [102, `${projectRoot}/services/control-plane`],
      [103, `${projectRoot}/services/control-plane`],
      [201, projectRoot],
      [202, projectRoot],
      [301, projectRoot],
      [302, `${projectRoot}/apps/web`],
      [401, '/workspace/another-project'],
      [501, projectRoot],
    ]);

    const matches = discoverServiceProcesses(
      rows,
      (pid) => cwdByPid.get(pid) ?? null,
      projectRoot,
    );

    expect(matches.map(({ pid, service }) => [pid, service])).toEqual([
      [101, 'control-plane'],
      [102, 'control-plane'],
      [103, 'control-plane'],
      [201, 'runner'],
      [202, 'runner'],
      [301, 'web'],
      [302, 'web'],
    ]);
    expect(findServiceRoots(matches).map(({ pid }) => pid)).toEqual([
      101, 201, 301,
    ]);
  });
});

describe('collectDescendantPids', () => {
  test('包含服务派生出的非 Bun 子进程', () => {
    const rows = [
      row(101, 10, 'bun run dev:runner'),
      row(102, 101, 'bun packages/cli/src/index.ts start'),
      row(103, 102, 'codex app-server'),
      row(104, 103, 'worker child'),
      row(201, 20, 'unrelated process'),
    ];

    expect([...collectDescendantPids(rows, new Set([101, 102]))]).toEqual([
      101, 102, 103, 104,
    ]);
  });
});
