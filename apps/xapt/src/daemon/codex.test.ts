import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandResult,
  CommandRunner,
  UserEnvironment,
} from '../platform/contracts';
import { NodeLocalFileSystem } from '../platform/files';
import {
  MacOsCodexPreflight,
  compareVersions,
  parseCodexVersion,
  type CodexInitializer,
} from './codex';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe('Codex daemon 预检', () => {
  test('接受大于等于最低版本并执行登录与 initialize 检查', async () => {
    const home = await temporaryHome();
    const initializer = new FakeInitializer();
    const commands = commandFixture({ version: '0.999.0' });
    const result = await new MacOsCodexPreflight(
      commands,
      new NodeLocalFileSystem(),
      environment(home),
      initializer,
    ).check();

    expect(result).toEqual({
      executable: '/opt/bin/codex',
      version: '0.999.0',
    });
    expect(initializer.executables).toEqual(['/opt/bin/codex']);
  });

  test('缺失、过旧、未登录和 initialize 失败给出确定诊断', async () => {
    const home = await temporaryHome();
    const cases: Array<{
      commands: CommandRunner;
      initializer?: CodexInitializer;
      code: string;
    }> = [
      {
        commands: commandFixture({ found: false }),
        code: 'NOT_FOUND',
      },
      {
        commands: commandFixture({ version: '0.144.9' }),
        code: 'VERSION_TOO_OLD',
      },
      {
        commands: commandFixture({ loggedIn: false }),
        code: 'NOT_LOGGED_IN',
      },
      {
        commands: commandFixture({}),
        initializer: { initialize: async () => Promise.reject(new Error()) },
        code: 'INITIALIZE_FAILED',
      },
    ];

    for (const item of cases) {
      const preflight = new MacOsCodexPreflight(
        item.commands,
        new NodeLocalFileSystem(),
        environment(home),
        item.initializer ?? new FakeInitializer(),
      );
      await expect(preflight.check()).rejects.toMatchObject({
        code: item.code,
      });
    }
  });

  test('PATH 缺失时只回退到可执行的 ~/.local/bin/codex', async () => {
    const home = await temporaryHome();
    const fallback = join(home, '.local/bin/codex');
    const files = new NodeLocalFileSystem();
    await files.writeAtomic(fallback, 'binary', 0o755);
    const commands = commandFixture({ found: false, fallback });

    expect(
      await new MacOsCodexPreflight(
        commands,
        files,
        environment(home),
        new FakeInitializer(),
      ).check(),
    ).toMatchObject({ executable: fallback });
  });

  test('接受官方 ~/.local/bin/codex 的可执行符号链接', async () => {
    const home = await temporaryHome();
    const target = join(home, 'codex-real');
    const fallback = join(home, '.local/bin/codex');
    const files = new NodeLocalFileSystem();
    await files.writeAtomic(target, 'binary', 0o755);
    await files.ensureDirectory(join(home, '.local/bin'), 0o755);
    await symlink(target, fallback);
    const commands = commandFixture({ found: false, fallback });

    expect(
      await new MacOsCodexPreflight(
        commands,
        files,
        environment(home),
        new FakeInitializer(),
      ).check(),
    ).toMatchObject({ executable: fallback });
  });
});

test('Codex 版本解析与比较不使用精确 allowlist', () => {
  expect(parseCodexVersion('codex-cli 0.146.0')).toBe('0.146.0');
  expect(compareVersions('0.146.0', '0.145.0')).toBeGreaterThan(0);
  expect(compareVersions('0.145.0', '0.145.0')).toBe(0);
  expect(compareVersions('0.144.9', '0.145.0')).toBeLessThan(0);
});

class FakeInitializer implements CodexInitializer {
  readonly executables: string[] = [];

  async initialize(executable: string): Promise<void> {
    this.executables.push(executable);
  }
}

function commandFixture(
  options: {
    found?: boolean;
    fallback?: string;
    version?: string;
    loggedIn?: boolean;
  } = {},
): CommandRunner {
  const executable = options.fallback ?? '/opt/bin/codex';
  return {
    run: async (_command, args): Promise<CommandResult> => {
      if (args[0] === 'codex')
        return options.found === false
          ? result(1)
          : result(0, '/opt/bin/codex\n');
      if (args[0] === '--version')
        return result(0, `codex-cli ${options.version ?? '0.146.0'}\n`);
      if (args[0] === 'login')
        return options.loggedIn === false ? result(1) : result(0, 'Logged in');
      throw new Error(`unexpected command for ${executable}`);
    },
  };
}

function result(exitCode: number, stdout = ''): CommandResult {
  return { exitCode, stdout, stderr: '' };
}

function environment(home: string): UserEnvironment {
  return {
    homeDirectory: () => home,
    userId: () => 501,
    platform: () => 'darwin',
    architecture: () => 'arm64',
    isTerminal: () => false,
  };
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'xapt-codex-'));
  homes.push(home);
  return home;
}
