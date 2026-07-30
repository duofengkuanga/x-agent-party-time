import { describe, expect, test } from 'bun:test';
import {
  CodexAppServerExecutor,
  publicInteractionPayload,
  restorePrivateInteractionResolution,
} from './codex-app-server';

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
