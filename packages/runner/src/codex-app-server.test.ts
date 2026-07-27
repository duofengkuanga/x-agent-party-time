import { describe, expect, test } from 'bun:test';
import {
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
});
