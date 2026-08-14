import type { CommandRunner, Keychain } from '../contracts';

export const XAPT_KEYCHAIN_SERVICE = 'com.agentpartytime.xapt';

export function keychainAccount(serverUrl: string, runnerId: string): string {
  const url = new URL(serverUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('服务地址必须使用 HTTP 或 HTTPS');
  if (!runnerId) throw new Error('Agent 标识不能为空');
  return `${url.origin}|${runnerId}`;
}

export class MacOsKeychain implements Keychain {
  constructor(private readonly commands: CommandRunner) {}

  async save(account: string, credential: string): Promise<void> {
    if (!credential) throw new Error('授权凭据不能为空');
    const result = await this.commands.run(
      '/bin/sh',
      [
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
      { stdin: `${credential}\n${credential}\n` },
    );
    if (result.exitCode !== 0) throw new KeychainError('无法保存授权凭据');
  }

  async read(account: string): Promise<string | null> {
    const result = await this.commands.run('/usr/bin/security', [
      'find-generic-password',
      '-s',
      XAPT_KEYCHAIN_SERVICE,
      '-a',
      account,
      '-w',
    ]);
    if (result.exitCode === 44) return null;
    if (result.exitCode !== 0) throw new KeychainError('无法读取授权凭据');
    return result.stdout.replace(/\r?\n$/, '');
  }

  async delete(account: string): Promise<void> {
    const result = await this.commands.run('/usr/bin/security', [
      'delete-generic-password',
      '-s',
      XAPT_KEYCHAIN_SERVICE,
      '-a',
      account,
    ]);
    if (result.exitCode !== 0 && result.exitCode !== 44)
      throw new KeychainError('无法删除授权凭据');
  }
}

export class KeychainError extends Error {
  constructor(message: string) {
    super(`${message}。下一步：请检查 macOS 系统钥匙串是否可用后重试。`);
    this.name = 'KeychainError';
  }
}
