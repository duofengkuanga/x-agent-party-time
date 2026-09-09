import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerExecutor } from './app-server';

for (const mode of [
  'completed',
  'failed',
  'invalid',
  'start-error',
  'cancel',
]) {
  test(`会话在 ${mode} 后释放，其他执行仍可继续`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'xapt-session-lifecycle-'));
    const executable = join(root, 'codex');
    const children: ChildProcess[] = [];
    const executor = new CodexAppServerExecutor(executable, ((
      ...args: Parameters<typeof spawn>
    ) => {
      const child = spawn(...args);
      children.push(child);
      return child;
    }) as typeof spawn);
    await writeFile(
      executable,
      `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const reply = (id, result) => console.log(JSON.stringify({ id, result }));
const completed = (status, text) => console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'session', turn: { id: 'turn', status, error: { message: "The 'gpt-6-astra' model requires a newer version of Codex." }, items: [{ type: 'agentMessage', text }] } } }));
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') reply(m.id, {});
  if (m.method === 'thread/start') reply(m.id, { thread: { id: 'session' } });
  if (m.method === 'turn/start') {
    const mode = m.params.input[0].text;
    if (mode === 'start-error') console.log(JSON.stringify({ id: m.id, error: { message: 'turn start failed' } }));
    else {
      reply(m.id, { turn: { id: 'turn' } });
      if (mode !== 'cancel') completed(mode === 'failed' ? 'failed' : 'completed', mode === 'invalid' ? 'invalid' : '{"ok":true}');
    }
  }
  if (m.method === 'turn/interrupt') { reply(m.id, {}); completed('interrupted', ''); }
});
`,
      { mode: 0o700 },
    );
    const input = (text: string) => ({
      approvalPolicy: 'on-request' as const,
      executionId: text,
      repositoryPath: root,
      text,
      skill: null,
      outputSchema: { type: 'object' },
      attachments: [],
      artifactsDirectory: join(root, text),
      taskId: null,
      onInteraction: async () => ({}),
    });
    const otherController = new AbortController();
    try {
      const other = await executor.begin(
        input('cancel'),
        otherController.signal,
      );
      const otherDone = other.completion.catch((error) => error);
      const controller = new AbortController();
      if (mode === 'start-error') {
        await expect(
          executor.begin(input(mode), controller.signal),
        ).rejects.toThrow('turn start failed');
      } else {
        const execution = await executor.begin(input(mode), controller.signal);
        const done = execution.completion.catch((error) => error);
        if (mode === 'cancel') controller.abort();
        const result = await done;
        if (mode === 'completed') expect(result).toEqual({ ok: true });
        else expect(result).toBeInstanceOf(Error);
      }
      // The finished execution must no longer have a writer process, while the
      // unrelated in-flight turn must still own its own live process.
      expect(children).toHaveLength(2);
      expect(
        children[1]!.exitCode !== null || children[1]!.signalCode !== null,
      ).toBe(true);
      expect(children[0]!.exitCode).toBeNull();
      expect(children[0]!.signalCode).toBeNull();
      otherController.abort();
      await otherDone;
    } finally {
      otherController.abort();
      await executor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('同步读取外部最新结果，不复用旧进程或跳过尚未完成的最新 Turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xapt-session-sync-'));
  const executable = join(root, 'codex');
  const history = join(root, 'history.json');
  const children: ChildProcess[] = [];
  const executor = new CodexAppServerExecutor(executable, ((
    ...args: Parameters<typeof spawn>
  ) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  }) as typeof spawn);
  await writeFile(
    executable,
    `#!/usr/bin/env node
const history = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(history)}, 'utf8'));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
  else if (m.method === 'thread/read') console.log(JSON.stringify({ id: m.id, result: { thread: { turns: history } } }));
  else if (m.id) console.log(JSON.stringify({ id: m.id, error: { message: '只允许读取，不允许恢复或运行会话' } }));
});
`,
    { mode: 0o700 },
  );
  const turn = (id: string, status = 'completed') => ({
    id,
    status,
    items: [{ type: 'agentMessage', text: JSON.stringify({ summary: id }) }],
  });
  try {
    await writeFile(history, JSON.stringify([turn('old')]));
    expect(await executor.readLastCompletedTurn('session')).toEqual({
      turnId: 'old',
      result: { summary: 'old' },
    });
    await writeFile(history, JSON.stringify([turn('old'), turn('new')]));
    expect(await executor.readLastCompletedTurn('session')).toEqual({
      turnId: 'new',
      result: { summary: 'new' },
    });
    for (const status of ['inProgress', 'failed', 'interrupted']) {
      await writeFile(
        history,
        JSON.stringify([turn('old'), turn('new', status)]),
      );
      await expect(executor.readLastCompletedTurn('session')).rejects.toThrow(
        '最新 Turn 尚未成功完成',
      );
    }
    expect(
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    ).toBe(true);
  } finally {
    await executor.close();
    await rm(root, { recursive: true, force: true });
  }
});
