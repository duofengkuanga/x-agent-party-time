import { describe, expect, test } from 'bun:test';
import { parseCommand } from './command';

describe('parseCommand', () => {
  test.each([
    [[], { kind: 'help' }],
    [['--help'], { kind: 'help' }],
    [['--version'], { kind: 'version' }],
    [['daemon', 'start'], { kind: 'daemon-start' }],
    [
      ['daemon', 'connect', 'https://apt.example.com'],
      { kind: 'daemon-connect', serverUrl: 'https://apt.example.com' },
    ],
    [['daemon', 'stop'], { kind: 'daemon-stop', force: false }],
    [['daemon', 'stop', '--force'], { kind: 'daemon-stop', force: true }],
    [['daemon', 'status'], { kind: 'daemon-status' }],
    [['update'], { kind: 'update' }],
    [['uninstall'], { kind: 'uninstall', force: false }],
    [['uninstall', '--force'], { kind: 'uninstall', force: true }],
    [['internal-daemon'], { kind: 'internal-daemon' }],
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
    [['--unknown']],
  ] as const)('rejects invalid arguments %j', (args) => {
    expect(() => parseCommand(args)).toThrow();
  });
});
