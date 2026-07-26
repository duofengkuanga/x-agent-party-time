import { describe, expect, test } from 'bun:test';
import { safeRedirectPath } from './server';

describe('safeRedirectPath', () => {
  test('只允许站内绝对路径', () => {
    expect(safeRedirectPath('/cooking?tab=queue#latest')).toBe(
      '/cooking?tab=queue#latest',
    );
    expect(safeRedirectPath('https://example.com')).toBeNull();
    expect(safeRedirectPath('//example.com')).toBeNull();
    expect(safeRedirectPath('/\\example.com')).toBeNull();
    expect(safeRedirectPath('/%5cexample.com')).toBeNull();
    expect(safeRedirectPath('/cooking\nmalformed')).toBeNull();
  });
});
