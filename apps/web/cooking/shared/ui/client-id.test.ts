import { afterEach, expect, test } from 'bun:test';
import { createClientId } from './client-id';

const originalCrypto = globalThis.crypto;

afterEach(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: originalCrypto,
  });
});

test('在 randomUUID 不可用时使用 getRandomValues 生成 UUID', () => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues<T extends ArrayBufferView>(array: T): T {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(
          0xab,
        );
        return array;
      },
    } as Crypto,
  });

  expect(createClientId()).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
