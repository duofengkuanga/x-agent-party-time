import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObservationEvent } from '@agent-party-time/execution-contract/observability';
import { testDirectories } from '../testing/directories';
import { CodexAppServerExecutor } from '../codex/app-server';
import { ExecutionObservation } from './recorder';
import { protocolObserver } from './protocol';

const directory = testDirectories('xapt-observation-protocol-');

test('启动与早到命令事件在 Turn 注册前已被安全采集', async () => {
  const root = await directory();
  const executable = join(root, 'codex');
  const sentinel = 'SYNTHETIC_PRIVATE_VALUE';
  await writeFile(
    executable,
    `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = value => console.log(JSON.stringify(value));
rl.on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'initialize') send({id:m.id,result:{}});
 if(m.method === 'thread/start') send({id:m.id,result:{thread:{id:'thread-1'},model:'gpt-example'}});
 if(m.method === 'turn/start') {
  const params = {threadId:'thread-1',turnId:'turn-1'};
  send({method:'item/started',params:{...params,item:{id:'command-1',type:'commandExecution',command:'umi build',cwd:'/private/${sentinel}'}}});
  send({id:m.id,result:{turn:{id:'turn-1'}}});
  send({method:'item/completed',params:{...params,item:{id:'command-1',type:'commandExecution',status:'completed',exitCode:0,durationMs:10,aggregatedOutput:'${sentinel}'}}});
  send({method:'turn/completed',params:{...params,turn:{id:'turn-1',status:'completed',items:[{type:'agentMessage',text:'{"ok":true}'}]}}});
 }
});
`,
    { mode: 0o700 },
  );
  const events: ObservationEvent[] = [];
  const observation = new ExecutionObservation(randomUUID(), (event) =>
    events.push(event),
  );
  const executor = new CodexAppServerExecutor(executable);
  const started = await executor.begin(
    {
      approvalPolicy: 'never',
      executionId: observation.executionId,
      repositoryPath: root,
      taskId: null,
      skill: null,
      text: 'Return JSON',
      attachments: [],
      outputSchema: { type: 'object' },
      onInteraction: async () => ({}),
      observe: protocolObserver(observation),
    },
    new AbortController().signal,
  );
  expect(await started.completion).toEqual({ ok: true });
  const early = events.findIndex((event) => event.name === 'item.started');
  const associated = events.findIndex((event) => event.name === 'turn.associated');
  expect(early).toBeGreaterThan(-1);
  expect(early).toBeLessThan(associated);
  expect(events.some((event) => event.name === 'rpc.sent')).toBe(true);
  expect(events.some((event) => event.name === 'process.exited')).toBe(true);
  expect(events.find((event) => event.name === 'item.finished')?.activity).toBe('build');
  expect(JSON.stringify(events)).not.toContain(sentinel);
  expect(JSON.stringify(events)).not.toContain('aggregatedOutput');
  expect(JSON.stringify(events)).not.toContain('Return JSON');
  expect(
    events.find((event) => event.configuration?.effectiveModel)?.configuration
      ?.effectiveModel,
  ).toBe('gpt-example');
});

test('采集器写失败不阻断业务；阶段仍将原错误交给业务处理', async () => {
  const observation = new ExecutionObservation(randomUUID(), () => {
    throw new Error('diagnostics unavailable');
  });
  expect(await observation.phase('validation', async () => 42)).toBe(42);
  await expect(
    observation.phase('workspace', async () => {
      throw new Error('business failure');
    }),
  ).rejects.toThrow('business failure');
  expect(() => observation.close()).not.toThrow();
});

test('可见消息和未知输出不被当作内部工具精确区间', () => {
  const events: ObservationEvent[] = [];
  const observation = new ExecutionObservation(randomUUID(), (event) =>
    events.push(event),
  );
  const observe = protocolObserver(observation);
  observe({
    type: 'receive',
    message: {
      method: 'item/completed',
      params: {
        threadId: 's',
        turnId: 't',
        item: { id: 'message-1', type: 'agentMessage', text: 'build:test succeeded' },
      },
    },
  });
  expect(events.some((event) => event.name === 'item.finished')).toBe(false);
  expect(events.at(-1)?.activity).toBe('message');
  expect(JSON.stringify(events)).not.toContain('build:test');
});

test('有界来源回执只从实际命令结果提取，拒绝未知字段和自然语言模拟', () => {
  const events: ObservationEvent[] = [];
  const observation = new ExecutionObservation(randomUUID(), (event) =>
    events.push(event),
  );
  const observer = protocolObserver(observation);
  const workId = randomUUID();
  const receipt = {
    version: 1,
    activityId: randomUUID(),
    activity: 'build',
    status: 'succeeded',
    workId,
  };
  for (const [id, type, output] of [
    ['chat', 'agentMessage', `XAPT_OBSERVATION_V1 ${JSON.stringify(receipt)}`],
    ['echo', 'commandExecution', 'build succeeded; npm run build'],
    [
      'unsafe',
      'commandExecution',
      `XAPT_OBSERVATION_V1 ${JSON.stringify({ ...receipt, output: 'SYNTHETIC_SECRET' })}`,
    ],
    [
      'valid',
      'commandExecution',
      `XAPT_OBSERVATION_V1 ${JSON.stringify(receipt)}\nXAPT_OBSERVATION_V1 ${JSON.stringify(receipt)}`,
    ],
  ])
    observer({
      type: 'receive',
      message: {
        method: 'item/completed',
        params: {
          threadId: 's',
          turnId: 't',
          item: {
            id,
            type,
            text: output,
            aggregatedOutput: output,
            status: 'completed',
            exitCode: 0,
          },
        },
      },
    });
  const source = events.filter((event) => event.reason === 'source_reported');
  expect(source).toHaveLength(1);
  expect(source[0]).toMatchObject({
    workId,
    activity: 'build',
    correlation: { parentIntervalId: 'valid' },
  });
  expect(source[0]!.sourceDurationMs).toBeUndefined();
  expect(JSON.stringify(events)).not.toContain('SYNTHETIC_SECRET');
  expect(JSON.stringify(events)).not.toContain('aggregatedOutput');
});

test('完全相同的完成通知在running移除或分类缓存失效后仍是同一事实', () => {
  const events: ObservationEvent[] = [];
  const observation = new ExecutionObservation(randomUUID(), (event) =>
    events.push(event),
  );
  const observer = protocolObserver(observation);
  observer({
    type: 'receive',
    message: {
      method: 'item/started',
      params: {
        threadId: 's',
        turnId: 't',
        item: { id: 'one', type: 'commandExecution', command: 'umi build' },
      },
    },
  });
  const completed = {
    type: 'receive' as const,
    message: {
      method: 'item/completed',
      params: {
        threadId: 's',
        turnId: 't',
        item: {
          id: 'one',
          type: 'commandExecution',
          status: 'completed',
          durationMs: 10,
        },
      },
    },
  };
  observer(completed);
  observer(completed);
  expect(events.filter((event) => event.name === 'item.finished')).toHaveLength(1);
  expect(events.some((event) => event.reason === 'conflict')).toBe(false);
});
