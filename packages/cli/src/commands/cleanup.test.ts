import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteCodexSession } from './cleanup.js';

describe('cleanup session deletion', () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  test('is idempotent when a previously deleted session is absent', async () => {
    const executable = await fakeCodex();
    await expect(
      deleteCodexSession(executable, 'present'),
    ).resolves.toBeUndefined();
    await expect(
      deleteCodexSession(executable, 'missing'),
    ).resolves.toBeUndefined();
  });

  test('does not hide other Codex deletion failures', async () => {
    const executable = await fakeCodex();
    await expect(deleteCodexSession(executable, 'denied')).rejects.toThrow(
      'permission denied',
    );
  });

  async function fakeCodex() {
    directory = await mkdtemp(join(tmpdir(), 'apt-cleanup-codex-'));
    const executable = join(directory, 'fake-codex.cjs');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const sessionId = process.argv.at(-1);
if (sessionId === 'missing') {
  process.stderr.write('session not found\\n');
  process.exit(1);
}
if (sessionId === 'denied') {
  process.stderr.write('permission denied\\n');
  process.exit(1);
}
`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    return executable;
  }
});
