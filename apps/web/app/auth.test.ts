import { describe, expect, test } from 'bun:test';
import { safeRedirectPath } from './auth';

describe('safeRedirectPath', () => {
  test('只允许站内绝对路径', () => {
    expect(safeRedirectPath('/submissions?tab=queue#latest')).toBe(
      '/submissions?tab=queue#latest',
    );
    expect(safeRedirectPath('https://example.com')).toBeNull();
    expect(safeRedirectPath('//example.com')).toBeNull();
    expect(safeRedirectPath('/\\example.com')).toBeNull();
    expect(safeRedirectPath('/%5cexample.com')).toBeNull();
    expect(safeRedirectPath('/submissions\nmalformed')).toBeNull();
  });
});
