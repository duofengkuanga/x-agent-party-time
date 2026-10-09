import type { Keychain } from '../platform/contracts';

export class MemoryKeychain implements Keychain {
  private readonly values = new Map<string, string>();

  async save(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }

  async read(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}
