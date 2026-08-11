import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexAppServerExecutor,
  publicInteractionPayload,
  restorePrivateInteractionResolution,
} from './codex-app-server';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('Fake Codex 完成 thread start/resume、turn/start 与结构化结果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xapt-fake-codex-'));
  directories.push(root);
  const executable = join(root, 'codex');
  const requestLog = join(root, 'requests.jsonl');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  fs.appendFileSync(${JSON.stringify(requestLog)}, line + '\\n');
  const message = JSON.parse(line);
  if (message.method === 'initialize')
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
  else if (message.method === 'thread/start')
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } }));
  else if (message.method === 'thread/resume')
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
  else if (message.method === 'turn/start') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-1' } } }));
    console.log(JSON.stringify({ jsonrpc: '2.0', method: 'unknown/notification', params: { ignored: true } }));
    console.log(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: '{"summary":"ok"}' }] } } }));
  }
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const executor = new CodexAppServerExecutor(executable);

  const started = await executor.begin(
    {
      approvalPolicy: 'on-request',
      executionId: '00000000-0000-4000-8000-000000000601',
      repositoryPath: root,
      prompt: '只返回 JSON',
      outputSchema: { type: 'object' },
      attachments: [],
      artifactsDirectory: join(root, 'artifacts'),
      resumeSessionId: null,
      onInteraction: async () => ({}),
    },
    new AbortController().signal,
  );

  expect(started.sessionId).toBe('thread-1');
  expect(await started.completion).toEqual({ summary: 'ok' });

  const resumed = await executor.begin(
    {
      approvalPolicy: 'on-request',
      executionId: '00000000-0000-4000-8000-000000000602',
      repositoryPath: root,
      prompt: '继续并只返回 JSON',
      outputSchema: { type: 'object' },
      attachments: [],
      artifactsDirectory: join(root, 'artifacts'),
      resumeSessionId: 'thread-1',
      onInteraction: async () => ({}),
    },
    new AbortController().signal,
  );
  expect(resumed.sessionId).toBe('thread-1');
  expect(await resumed.completion).toEqual({ summary: 'ok' });

  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const method of ['thread/start', 'thread/resume']) {
    const request = requests.find((entry) => entry.method === method);
    expect(request?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'danger-full-access',
    });
  }
  await executor.close();
});

describe('Codex Interaction 安全投影', () => {
  test('命令审批不上传 cwd、线程标识或命令中的绝对路径', () => {
    const payload = publicInteractionPayload(
      'item/commandExecution/requestApproval',
      {
        threadId: 'thread-private',
        turnId: 'turn-private',
        cwd: '/Users/example/private-repository',
        command: 'cat /Users/example/private-repository/secret.txt',
        reason: '检查 /private/tmp/repair.log',
      },
    );
    expect(payload).toEqual({
      command: 'cat 本机路径已隐藏',
      reason: '检查 本机路径已隐藏',
    });
    expect(JSON.stringify(payload)).not.toContain('/Users/example');
    expect(JSON.stringify(payload)).not.toContain('/private/tmp');
  });

  test('文件与权限审批只保留网页需要的脱敏信息', () => {
    expect(
      publicInteractionPayload('item/fileChange/requestApproval', {
        grantRoot: '/Users/example/private-repository',
        reason: '需要修改工作区文件',
      }),
    ).toEqual({ reason: '需要修改工作区文件' });
    expect(
      publicInteractionPayload('item/permissions/requestApproval', {
        permissions: {
          fileSystem: {
            root: '/Users/example/private-repository',
            mode: 'write',
          },
        },
        reason: '运行验证',
      }),
    ).toEqual({
      permissions: {
        fileSystem: { root: '本机路径已隐藏', mode: 'write' },
      },
      reason: '运行验证',
    });
  });

  test('负责人允许权限后只在 Runner 本机恢复原始权限参数', () => {
    expect(
      restorePrivateInteractionResolution(
        'item/permissions/requestApproval',
        {
          permissions: {
            fileSystem: { root: '本机路径已隐藏', mode: 'write' },
          },
          scope: 'session',
        },
        {
          permissions: {
            fileSystem: {
              root: '/Users/example/private-repository',
              mode: 'write',
            },
          },
        },
      ),
    ).toEqual({
      permissions: {
        fileSystem: {
          root: '/Users/example/private-repository',
          mode: 'write',
        },
      },
      scope: 'session',
    });
  });

  test('只恢复用户实际选中的权限子集', () => {
    expect(
      restorePrivateInteractionResolution(
        'item/permissions/requestApproval',
        {
          permissions: {
            network: {
              hosts: ['registry.npmjs.org'],
            },
          },
          scope: 'turn',
        },
        {
          permissions: {
            fileSystem: {
              root: '/Users/example/private-repository',
              mode: 'write',
            },
            network: {
              hosts: ['registry.npmjs.org', 'api.example.com'],
            },
          },
        },
      ),
    ).toEqual({
      permissions: {
        network: {
          hosts: ['registry.npmjs.org'],
        },
      },
      scope: 'turn',
    });

    expect(
      restorePrivateInteractionResolution(
        'item/permissions/requestApproval',
        {
          permissions: {
            mounts: [{ mode: 'write' }],
          },
          scope: 'turn',
        },
        {
          permissions: {
            mounts: [
              {
                mode: 'write',
                root: '/Users/example/private-repository',
              },
            ],
          },
        },
      ),
    ).toEqual({
      permissions: {
        mounts: [{ mode: 'write' }],
      },
      scope: 'turn',
    });
  });

  test('Turn 与 Session 权限都会在 Runner 本机恢复，拒绝保持空权限', () => {
    const privatePayload = {
      permissions: {
        fileSystem: {
          root: '/Users/example/private-repository',
          mode: 'write',
        },
      },
    };
    expect(
      restorePrivateInteractionResolution(
        'item/permissions/requestApproval',
        {
          permissions: {
            fileSystem: { root: '本机路径已隐藏', mode: 'write' },
          },
          scope: 'turn',
        },
        privatePayload,
      ),
    ).toEqual({
      permissions: privatePayload.permissions,
      scope: 'turn',
    });
    expect(
      restorePrivateInteractionResolution(
        'item/permissions/requestApproval',
        { permissions: {}, scope: 'turn' },
        privatePayload,
      ),
    ).toEqual({ permissions: {}, scope: 'turn' });
  });
});

describe('Codex Turn 失败摘要', () => {
  test('Turn 失败时保留 429 重试耗尽摘要', async () => {
    const executor = new CodexAppServerExecutor();
    const failure = new Promise((resolve, reject) => {
      (
        executor as unknown as {
          completeTurn: (
            active: unknown,
            params: Record<string, unknown>,
          ) => void;
        }
      ).completeTurn(
        {
          threadId: 'thread-429',
          turnId: 'turn-429',
          log: { write: () => undefined },
          reject,
          resolve,
        },
        {
          turn: {
            id: 'turn-429',
            status: 'failed',
            error: {
              message:
                'exceeded retry limit, last status: 429 Too Many Requests, request id: request-429',
              codexErrorInfo: {
                responseTooManyFailedAttempts: { httpStatusCode: 429 },
              },
            },
          },
        },
      );
    });

    await expect(failure).rejects.toMatchObject({
      message: 'Codex 请求过多：429 Too Many Requests，已超过重试次数。',
      sessionId: 'thread-429',
    });
  });
});

describe('Codex Turn 结构化结果解析', () => {
  function completeTurnWithMessage(text: string): Promise<unknown> {
    const executor = new CodexAppServerExecutor();
    return new Promise((resolve, reject) => {
      (
        executor as unknown as {
          completeTurn: (
            active: unknown,
            params: Record<string, unknown>,
          ) => void;
        }
      ).completeTurn(
        {
          threadId: 'thread-structured',
          turnId: 'turn-structured',
          log: { write: () => undefined },
          reject,
          resolve,
        },
        {
          turn: {
            id: 'turn-structured',
            status: 'completed',
            items: [{ type: 'agentMessage', text }],
          },
        },
      );
    });
  }

  test('整条消息就是 JSON 时直接解析', async () => {
    await expect(completeTurnWithMessage('{"summary":"ok"}')).resolves.toEqual({
      summary: 'ok',
    });
  });

  test('总结后跟 ```json 代码块时提取代码块解析', async () => {
    const message =
      '修复完成，提交已创建。\n\n```json\n{"outcome":"COMPLETED","commits":["640d5b3"]}\n```';
    await expect(completeTurnWithMessage(message)).resolves.toEqual({
      outcome: 'COMPLETED',
      commits: ['640d5b3'],
    });
  });

  test('未标注 json 的代码块也能解析', async () => {
    await expect(
      completeTurnWithMessage('```\n{"ok":true}\n```'),
    ).resolves.toEqual({ ok: true });
  });

  test('多个代码块时取最后一个', async () => {
    const message = '```json\n{"first":1}\n```\n\n```json\n{"second":2}\n```';
    await expect(completeTurnWithMessage(message)).resolves.toEqual({
      second: 2,
    });
  });

  test('无代码块但消息内嵌 JSON 对象时提取解析', async () => {
    const message =
      '处理完成，结果如下：{"outcome":"COMPLETED","count":2} 以上。';
    await expect(completeTurnWithMessage(message)).resolves.toEqual({
      outcome: 'COMPLETED',
      count: 2,
    });
  });

  test('纯自然语言且无 JSON 时返回结构化结果无效', async () => {
    await expect(
      completeTurnWithMessage('修复完成，提交已创建且工作区干净。'),
    ).rejects.toMatchObject({
      message: 'Codex Turn 返回的结构化结果无效',
      sessionId: 'thread-structured',
    });
  });

  test('代码块内不是合法 JSON 时返回结构化结果无效', async () => {
    await expect(
      completeTurnWithMessage('```json\n{这不是 JSON}\n```'),
    ).rejects.toMatchObject({
      message: 'Codex Turn 返回的结构化结果无效',
      sessionId: 'thread-structured',
    });
  });
});
