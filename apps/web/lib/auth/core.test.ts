import { describe, expect, test } from 'bun:test';
import {
  authenticateDemoUser,
  createSessionToken,
  readSessionToken,
  safeRedirectPath,
} from './core';

const secret = 'test-session-secret';

describe('demo authentication', () => {
  test('authenticates every seeded account with its account type', () => {
    expect(authenticateDemoUser('xujiequan', '123456')?.accountType).toBe(
      'DEVELOPER',
    );
    expect(authenticateDemoUser('zhoumingbo', '123456')?.accountType).toBe(
      'DEVELOPER',
    );
    expect(authenticateDemoUser('tianguohui', '123456')?.accountType).toBe(
      'TESTER',
    );
  });

  test('rejects unknown users and invalid passwords', () => {
    expect(authenticateDemoUser('nobody', '123456')).toBeNull();
    expect(authenticateDemoUser('xujiequan', 'wrong')).toBeNull();
  });
});

describe('signed sessions', () => {
  test('round-trips a valid session', async () => {
    const token = await createSessionToken('user-xujiequan', secret, 2_000);
    expect((await readSessionToken(token, secret, 1_000))?.displayName).toBe(
      '徐捷泉',
    );
  });

  test('rejects expired and tampered sessions', async () => {
    const token = await createSessionToken('user-tianguohui', secret, 2_000);
    expect(await readSessionToken(token, secret, 2_001)).toBeNull();
    expect(await readSessionToken(`${token}x`, secret, 1_000)).toBeNull();
  });
});

describe('safe redirect paths', () => {
  test('only accepts application-local paths', () => {
    expect(safeRedirectPath('/cooking?from=login')).toBe('/cooking?from=login');
    expect(safeRedirectPath('https://example.com')).toBeNull();
    expect(safeRedirectPath('//example.com')).toBeNull();
  });
});
