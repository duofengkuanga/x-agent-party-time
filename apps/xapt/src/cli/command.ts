export type XaptCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'daemon-start' }
  | { kind: 'daemon-connect'; serverUrl: string }
  | { kind: 'daemon-stop'; force: boolean }
  | { kind: 'daemon-status' }
  | { kind: 'update' }
  | { kind: 'uninstall'; force: boolean }
  | { kind: 'internal-daemon' };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export function parseCommand(args: readonly string[]): XaptCommand {
  if (args.length === 0 || isExactly(args, '--help')) return { kind: 'help' };
  if (isExactly(args, '--version')) return { kind: 'version' };

  const [command, ...rest] = args;
  switch (command) {
    case 'daemon':
      return parseDaemonCommand(rest);
    case 'update':
      requireNoArguments('update', rest);
      return { kind: 'update' };
    case 'uninstall':
      return {
        kind: 'uninstall',
        force: parseOptionalForce('uninstall', rest),
      };
    case 'internal-daemon':
      requireNoArguments('internal-daemon', rest);
      return { kind: 'internal-daemon' };
    default:
      throw new CliUsageError(`未知命令“${command}”`);
  }
}

function parseDaemonCommand(args: readonly string[]): XaptCommand {
  const [command, ...rest] = args;
  switch (command) {
    case 'start':
      requireNoArguments('daemon start', rest);
      return { kind: 'daemon-start' };
    case 'connect': {
      if (rest.length === 0)
        throw new CliUsageError('缺少必需参数 <server-url>');
      if (rest.length > 1)
        throw new CliUsageError(`daemon connect 不接受参数“${rest[1]}”`);
      return { kind: 'daemon-connect', serverUrl: rest[0]! };
    }
    case 'stop':
      return {
        kind: 'daemon-stop',
        force: parseOptionalForce('daemon stop', rest),
      };
    case 'status':
      requireNoArguments('daemon status', rest);
      return { kind: 'daemon-status' };
    case undefined:
      throw new CliUsageError('缺少 daemon 子命令');
    default:
      throw new CliUsageError(`未知 daemon 子命令“${command}”`);
  }
}

function parseOptionalForce(command: string, args: readonly string[]): boolean {
  if (args.length === 0) return false;
  if (isExactly(args, '--force')) return true;
  throw new CliUsageError(`${command} 不接受参数“${args[0]}”`);
}

function requireNoArguments(command: string, args: readonly string[]): void {
  if (args.length > 0)
    throw new CliUsageError(`${command} 不接受参数“${args[0]}”`);
}

function isExactly(args: readonly string[], value: string): boolean {
  return args.length === 1 && args[0] === value;
}
