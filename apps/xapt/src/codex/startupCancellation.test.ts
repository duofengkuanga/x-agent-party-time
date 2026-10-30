import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testDirectories } from '../testing/directories';
import { CodexAppServerExecutor } from './appServer';

const directory = testDirectories('xapt-startup-cancel-');

test.each(['before-start', 'initialize', 'thread/start'] as const)(
  '%s 阶段失去租约后不发送首轮消息',
  async (abortAt) => {
    const root = await directory();
    const executable = join(root, 'codex');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const reply = (id, result) => console.log(JSON.stringify({ id, result }));
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') reply(m.id, {});
  if (m.method === 'thread/start') reply(m.id, { thread: { id: 'session' } });
  if (m.method === 'turn/start') reply(m.id, { turn: { id: 'turn' } });
  if (m.method === 'turn/interrupt') reply(m.id, {});
});
`,
      { mode: 0o700 },
    );
    const executor = new CodexAppServerExecutor(executable);
    const controller = new AbortController();
    const sent = new Map<number, string>();
    if (abortAt === 'before-start') controller.abort();
    try {
      const pending = executor
        .begin(
          {
            approvalPolicy: 'never',
            executionId: 'cancel-startup',
            repositoryPath: root,
            text: 'fixture',
            skill: null,
            outputSchema: { type: 'object' },
            attachments: [],
            taskId: null,
            onInteraction: async () => ({}),
            observe(notice) {
              if (notice.type !== 'send' && notice.type !== 'receive') return;
              const message = notice.message as { id: number; method?: string };
              if (notice.type === 'send' && message.method)
                sent.set(message.id, message.method);
              if (notice.type === 'receive' && sent.get(message.id) === abortAt)
                controller.abort();
            },
          },
          controller.signal,
        )
        .then(async (started) => {
          await started.completion.catch(() => undefined);
          return started;
        });
      await expect(pending).rejects.toBeInstanceOf(Error);
      expect([...sent.values()]).not.toContain('turn/start');
      if (abortAt === 'before-start') expect(sent.size).toBe(0);
    } finally {
      await executor.close();
    }
  },
);
