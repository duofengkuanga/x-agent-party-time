import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('Fake Codex 完成 initialize、thread/start、turn/start 与结构化结果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xapt-fake-codex-'));
  directories.push(root);
  const executable = join(root, 'codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize')
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
  else if (message.method === 'thread/start')
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } }));
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
