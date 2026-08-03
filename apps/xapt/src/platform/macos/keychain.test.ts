import { describe, expect, test } from 'bun:test';
import type { CommandResult, CommandRunner, Keychain } from '../contracts';
import {
  MacOsKeychain,
  XAPT_KEYCHAIN_SERVICE,
  keychainAccount,
} from './keychain';

class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<{
    executable: string;
    args: readonly string[];
    stdin?: string;
  }> = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(
    executable: string,
    args: readonly string[],
    options: { stdin?: string } = {},
  ): Promise<CommandResult> {
    this.calls.push({ executable, args, stdin: options.stdin });
    return this.results.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
  }
}

class MemoryKeychain implements Keychain {
  private readonly values = new Map<string, string>();

  async save(account: string, credential: string): Promise<void> {
    this.values.set(account, credential);
  }

  async read(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

describe('Keychain Adapter', () => {
  test('Account 稳定地由 Server Origin 与 Runner ID 构成', () => {
    expect(
      keychainAccount(
        'https://apt.example.com/path?ignored=true',
        '00000000-0000-4000-8000-000000000001',
      ),
    ).toBe('https://apt.example.com|00000000-0000-4000-8000-000000000001');
  });

  test('macOS Adapter 只通过 stdin 写 Credential，不进入参数或错误', async () => {
    const commands = new FakeCommandRunner([
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: 'credential-secret\n', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
    ]);
    const keychain = new MacOsKeychain(commands);
    const account = keychainAccount(
      'https://apt.example.com',
      '00000000-0000-4000-8000-000000000001',
    );

    await keychain.save(account, 'credential-secret');
    expect(await keychain.read(account)).toBe('credential-secret');
    await keychain.delete(account);

    expect(commands.calls[0]).toEqual({
      executable: '/bin/sh',
      args: [
        '-c',
        'exec /usr/bin/security "$@"',
        'security',
        'add-generic-password',
        '-U',
        '-s',
        XAPT_KEYCHAIN_SERVICE,
        '-a',
        account,
        '-w',
      ],
      stdin: 'credential-secret\ncredential-secret\n',
    });
    expect(JSON.stringify(commands.calls[0]!.args)).not.toContain(
      'credential-secret',
    );
  });

  test('Fake Adapter 支持隔离写入、读取和删除', async () => {
    const keychain = new MemoryKeychain();
    await keychain.save('account', 'secret');
    expect(await keychain.read('account')).toBe('secret');
    await keychain.delete('account');
    expect(await keychain.read('account')).toBeNull();
  });
});
