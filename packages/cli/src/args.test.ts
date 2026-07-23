import { describe, expect, test } from 'bun:test';
import { parseArgs, withoutLeadingPositionals } from './args.js';

describe('CLI argument routing', () => {
  test('keeps global options while removing command positionals', () => {
    const args = [
      '--home',
      '/tmp/apt',
      'task',
      'status',
      'task-1',
      'backlog',
      '--json',
    ];
    const nested = withoutLeadingPositionals(args, 2);
    expect(nested).toEqual([
      '--home',
      '/tmp/apt',
      'task-1',
      'backlog',
      '--json',
    ]);
    expect(parseArgs(nested).positionals).toEqual(['task-1', 'backlog']);
  });

  test('does not consume a command after a boolean global option', () => {
    expect(parseArgs(['--json', 'agent', 'list']).positionals).toEqual([
      'agent',
      'list',
    ]);
  });
});
