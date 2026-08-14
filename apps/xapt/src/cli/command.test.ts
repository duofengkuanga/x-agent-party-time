import { describe, expect, test } from 'bun:test';
import { parseCommand } from './command';

describe('parseCommand', () => {
  test.each([
    [[], { kind: 'help' }],
    [['--help'], { kind: 'help' }],
    [['-h'], { kind: 'help' }],
    [['--version'], { kind: 'version' }],
    [['-v'], { kind: 'version' }],
    [['daemon', 'start'], { kind: 'daemon-start' }],
    [
      ['daemon', 'connect', 'https://apt.example.com'],
      { kind: 'daemon-connect', serverUrl: 'https://apt.example.com' },
    ],
    [['daemon', 'stop'], { kind: 'daemon-stop', force: false }],
    [['daemon', 'stop', '--force'], { kind: 'daemon-stop', force: true }],
    [['daemon', 'status'], { kind: 'daemon-status' }],
    [['skills', 'update'], { kind: 'skills-update' }],
    [['update'], { kind: 'update' }],
    [['uninstall'], { kind: 'uninstall', force: false }],
    [['uninstall', '--force'], { kind: 'uninstall', force: true }],
    [
      ['bugs', 'delete', '944d519c-1ed0-4711-a3b1-325bec5bbe56'],
      {
        kind: 'bugs-delete',
        bugIds: ['944d519c-1ed0-4711-a3b1-325bec5bbe56'],
        all: false,
        force: false,
      },
    ],
    [
      [
        'bugs',
        'delete',
        '944d519c-1ed0-4711-a3b1-325bec5bbe56',
        'd4c975ce-8742-46f6-8ded-be0629a974c1',
        '--force',
      ],
      {
        kind: 'bugs-delete',
        bugIds: [
          '944d519c-1ed0-4711-a3b1-325bec5bbe56',
          'd4c975ce-8742-46f6-8ded-be0629a974c1',
        ],
        all: false,
        force: true,
      },
    ],
    [
      ['bugs', 'delete', '--all'],
      { kind: 'bugs-delete', bugIds: [], all: true, force: false },
    ],
    [
      ['bugs', 'delete', '--all', '--force'],
      { kind: 'bugs-delete', bugIds: [], all: true, force: true },
    ],
    [
      ['bugs', 'delete', '--force', '--all'],
      { kind: 'bugs-delete', bugIds: [], all: true, force: true },
    ],
    [['internal-daemon'], { kind: 'internal-daemon' }],
    [
      ['internal-render-install-state', '0.3.4', '2026-08-01T00:00:00.000Z'],
      {
        kind: 'internal-render-install-state',
        previousVersion: '0.3.4',
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
    [
      ['internal-render-install-state', '-', '2026-08-01T00:00:00.000Z'],
      {
        kind: 'internal-render-install-state',
        previousVersion: null,
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  ] as const)('parses %j', (args, expected) => {
    expect(parseCommand(args)).toEqual(expected);
  });

  test.each([
    [['pair']],
    [['bind']],
    [['heartbeat']],
    [['bindings']],
    [['daemon']],
    [['daemon', 'logs']],
    [['daemon', 'connect']],
    [['daemon', 'connect', 'https://apt.example.com', 'extra']],
    [['daemon', 'start', '--unknown']],
    [['update', '0.2.0']],
    [['uninstall', '--unknown']],
    [['skills']],
    [['skills', 'update', '--force']],
    [['skills', 'prune']],
    [['bugs']],
    [['bugs', 'delete']],
    [['bugs', 'delete', '--all', '944d519c-1ed0-4711-a3b1-325bec5bbe56']],
    [['bugs', 'delete', '--unknown']],
    [['bugs', 'list']],
    [['internal-render-install-state']],
    [['internal-render-install-state', '-', 'not-a-date']],
    [['--unknown']],
  ] as const)('rejects invalid arguments %j', (args) => {
    expect(() => parseCommand(args)).toThrow();
  });
});
