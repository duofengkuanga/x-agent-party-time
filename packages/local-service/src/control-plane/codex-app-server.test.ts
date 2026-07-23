import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUG_REPAIR_OUTPUT_JSON_SCHEMA,
  type RepairPrompt,
  type RepairResult,
} from '@agent-party-time/shared';
import {
  CodexAppServerExecutor,
  type CodexAppServerInteraction,
} from './codex-app-server.js';

const OUTPUT_SCHEMA = JSON.parse(
  JSON.stringify(BUG_REPAIR_OUTPUT_JSON_SCHEMA),
) as RepairPrompt['outputSchema'];

const READY_RESULT: RepairResult = {
  status: 'ready',
  summary: '修复完成',
  changes: [{ path: 'src/example.ts', summary: '修正返回值' }],
  checks: [{ name: 'unit', status: 'passed', summary: '1 test passed' }],
  candidateCommit: 'deadbeef',
  reason: null,
};

describe('CodexAppServerExecutor', () => {
  const homes = new Set<string>();
  const executors = new Set<CodexAppServerExecutor>();

  afterEach(async () => {
    await Promise.all([...executors].map((executor) => executor.close()));
    executors.clear();
    await Promise.all(
      [...homes].map((home) => rm(home, { recursive: true, force: true })),
    );
    homes.clear();
  });

  test('单个 App Server 进程复用 Thread，并在原 Thread 中输入继续', async () => {
    const fixture = await createFakeAppServer();
    const executor = fixture.executor;
    const first = await executor.execute(
      {
        attemptId: crypto.randomUUID(),
        repositoryPath: fixture.home,
        prompt: 'READY',
        outputSchema: OUTPUT_SCHEMA,
        artifactsDirectory: join(fixture.home, 'first'),
      },
      new AbortController().signal,
    );
    const resumed = await executor.execute(
      {
        attemptId: crypto.randomUUID(),
        repositoryPath: fixture.home,
        prompt: '不应再次发送完整 prompt',
        outputSchema: OUTPUT_SCHEMA,
        artifactsDirectory: join(fixture.home, 'resumed'),
        resumeSessionId: first.sessionId,
      },
      new AbortController().signal,
    );

    expect(first.sessionId).toBe('thread-1');
    expect(resumed.sessionId).toBe('thread-1');
    expect(first.result).toEqual(READY_RESULT);
    expect(resumed.result).toEqual(READY_RESULT);
    expect((await lines(fixture.startupsPath)).length).toBe(1);

    const messages = await jsonLines(fixture.messagesPath);
    expect(
      messages.filter((message) => message.method === 'initialize'),
    ).toHaveLength(1);
    expect(
      messages.find((message) => message.method === 'initialize'),
    ).toMatchObject({
      params: {
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
    expect(
      messages.filter((message) => message.method === 'thread/start'),
    ).toHaveLength(1);
    expect(
      messages.filter((message) => message.method === 'thread/resume'),
    ).toHaveLength(1);
    expect(
      messages.find((message) => message.method === 'thread/resume'),
    ).toMatchObject({ params: { threadId: 'thread-1' } });
    const turns = messages.filter((message) => message.method === 'turn/start');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      params: {
        input: [{ type: 'text', text: 'READY', text_elements: [] }],
        outputSchema: OUTPUT_SCHEMA,
      },
    });
    expect(turns[1]).toMatchObject({
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: '继续', text_elements: [] }],
      },
    });
    expect(JSON.stringify(messages)).not.toContain('codex exec');
  });

  test('把四类 App Server 原生交互交给调用方并原样返回响应', async () => {
    const fixture = await createFakeAppServer();
    const interactions: CodexAppServerInteraction[] = [];
    const expectedResponses = [
      {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: { commandPrefix: ['bun', 'test'] },
          },
        },
      },
      { decision: 'acceptForSession' },
      {
        permissions: { network: { enabled: true } },
        scope: 'session',
      },
      { answers: { reason: { answers: ['继续修复'] } } },
    ];
    const result = await fixture.executor.executeStructured(
      {
        executionId: crypto.randomUUID(),
        repositoryPath: fixture.home,
        prompt: 'INTERACTIONS',
        outputSchema: OUTPUT_SCHEMA,
        resultSchema: (await import('@agent-party-time/shared'))
          .RepairResultSchema,
        artifactsDirectory: join(fixture.home, 'interactions'),
        onInteraction: async (interaction) => {
          interactions.push(interaction);
          return expectedResponses[interactions.length - 1];
        },
      },
      new AbortController().signal,
    );

    expect(result.result).toEqual(READY_RESULT);
    expect(interactions.map((interaction) => interaction.method)).toEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
    ]);
    expect(interactions[0]).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-command',
      params: {
        proposedExecpolicyAmendment: { commandPrefix: ['bun', 'test'] },
      },
    });
    expect(await jsonLines(fixture.responsesPath)).toEqual(expectedResponses);
  });

  test('App Server 退出时保留已知 Thread id', async () => {
    const fixture = await createFakeAppServer();
    await expect(
      fixture.executor.execute(
        {
          attemptId: crypto.randomUUID(),
          repositoryPath: fixture.home,
          prompt: 'EXIT',
          outputSchema: OUTPUT_SCHEMA,
          artifactsDirectory: join(fixture.home, 'exit'),
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'CodexAppServerError',
      sessionId: 'thread-1',
      message: expect.stringContaining('Codex App Server 已退出'),
    });
  });

  test('拒绝无效结构化结果而不伪造 candidate commit', async () => {
    const fixture = await createFakeAppServer();
    await expect(
      fixture.executor.execute(
        {
          attemptId: crypto.randomUUID(),
          repositoryPath: fixture.home,
          prompt: 'INVALID',
          outputSchema: OUTPUT_SCHEMA,
          artifactsDirectory: join(fixture.home, 'invalid'),
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'CodexAppServerError',
      sessionId: 'thread-1',
    });
  });

  async function createFakeAppServer() {
    const home = await mkdtemp(join(tmpdir(), 'apt-fake-app-server-'));
    homes.add(home);
    const executable = join(home, 'fake-codex.cjs');
    const messagesPath = join(home, 'messages.jsonl');
    const responsesPath = join(home, 'responses.jsonl');
    const startupsPath = join(home, 'startups.txt');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const home = ${JSON.stringify(home)};
const messagesPath = ${JSON.stringify(messagesPath)};
const responsesPath = ${JSON.stringify(responsesPath)};
const startupsPath = ${JSON.stringify(startupsPath)};
fs.appendFileSync(startupsPath, String(process.pid) + '\\n');
let threadCounter = 0;
let turnCounter = 0;
let interactionFlow = null;
const ready = ${JSON.stringify(READY_RESULT)};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const complete = (threadId, turnId, value = ready) => {
  send({
    jsonrpc: '2.0',
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { type: 'agentMessage', text: typeof value === 'string' ? value : JSON.stringify(value) }
    }
  });
  send({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id: turnId,
        status: 'completed',
        items: [],
        itemsView: 'notLoaded'
      }
    }
  });
};
const requests = [
  ['item/commandExecution/requestApproval', 'item-command', { proposedExecpolicyAmendment: { commandPrefix: ['bun', 'test'] } }],
  ['item/fileChange/requestApproval', 'item-file', { reason: '修改源码' }],
  ['item/permissions/requestApproval', 'item-permission', { permissions: { network: { enabled: true } } }],
  ['item/tool/requestUserInput', 'item-input', { questions: [{ id: 'reason', header: '继续', question: '下一步？', options: null }] }]
];
function sendInteraction() {
  const entry = requests[interactionFlow.index];
  if (!entry) return complete(interactionFlow.threadId, interactionFlow.turnId);
  const [method, itemId, extra] = entry;
  send({
    jsonrpc: '2.0',
    id: 100 + interactionFlow.index,
    method,
    params: { threadId: interactionFlow.threadId, turnId: interactionFlow.turnId, itemId, ...extra }
  });
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(messagesPath, JSON.stringify(message) + '\\n');
  if (interactionFlow && message.id === 100 + interactionFlow.index && !message.method) {
    fs.appendFileSync(responsesPath, JSON.stringify(message.result) + '\\n');
    interactionFlow.index += 1;
    return sendInteraction();
  }
  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake', codexHome: home, platformFamily: 'unix', platformOs: 'macos' } });
  if (message.method === 'thread/start') {
    const threadId = 'thread-' + (++threadCounter);
    return send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: threadId } } });
  }
  if (message.method === 'thread/resume') return send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === 'turn/interrupt') return send({ jsonrpc: '2.0', id: message.id, result: {} });
  if (message.method !== 'turn/start') return;
  const turnId = 'turn-' + (++turnCounter);
  const threadId = message.params.threadId;
  const text = message.params.input[0].text;
  send({ jsonrpc: '2.0', id: message.id, result: { turn: { id: turnId } } });
  if (text === 'EXIT') return setTimeout(() => process.exit(7), 5);
  if (text === 'INTERACTIONS') {
    interactionFlow = { threadId, turnId, index: 0 };
    return sendInteraction();
  }
  complete(threadId, turnId, text === 'INVALID' ? '{not-json' : ready);
});
`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const executor = new CodexAppServerExecutor({ executable });
    executors.add(executor);
    return { home, executor, messagesPath, responsesPath, startupsPath };
  }
});

async function lines(path: string) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
}

async function jsonLines(path: string) {
  try {
    return (await lines(path)).map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
