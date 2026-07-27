import { describe, expect, test } from 'bun:test';
import { PlatformError } from '@/platform/errors';
import { WorkspaceEventBus } from '../application/workspace-events';
import { handleWorkspaceEvents, handleWorkspaceSnapshot } from './http';

const submissionId = '00000000-0000-4000-8000-000000000501';

describe('Submission Workspace HTTP', () => {
  test('Snapshot 禁止缓存并保留无权访问的隐藏错误', async () => {
    const response = handleWorkspaceSnapshot(submissionId, 'workspace-user', {
      getWorkspace: () => workspace(3),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).revision).toBe(3);

    const hidden = handleWorkspaceSnapshot(submissionId, 'outsider', {
      getWorkspace: () => {
        throw new PlatformError('NOT_FOUND', '提测单不存在或无权访问');
      },
    });
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: '提测单不存在或无权访问',
      },
    });
  });

  test('SSE 首先发送当前 Revision，后续只发送失效标识', async () => {
    const events = new WorkspaceEventBus();
    const response = handleWorkspaceEvents(
      request('/api/cooking/events'),
      'workspace-user',
      {
        canAccessSubmission: () => true,
        getWorkspace: () => workspace(4),
      },
      events,
      60_000,
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const initial = `${await readChunk(reader)}${await readChunk(reader)}`;
    expect(initial).toContain('retry: 1000');
    expect(initial).toContain(
      `data: {"submissionId":"${submissionId}","revision":4}`,
    );

    events.publish({ submissionId, revision: 5 });
    const update = await readChunk(reader);
    expect(update).toBe(
      `data: {"submissionId":"${submissionId}","revision":5}\n\n`,
    );
    expect(update).not.toMatch(/title|requirement|binding|repository|path/iu);
    await reader.cancel();
  });

  test('重连从当前 Revision 收敛，不依赖事件重放', async () => {
    const response = handleWorkspaceEvents(
      request('/api/cooking/events'),
      'workspace-user',
      {
        canAccessSubmission: () => true,
        getWorkspace: () => workspace(9),
      },
      new WorkspaceEventBus(),
      60_000,
    );
    const reader = response.body!.getReader();
    await readChunk(reader);
    expect(await readChunk(reader)).toContain('"revision":9');
    await reader.cancel();
  });

  test('先订阅再读取当前 Revision，不会漏掉连接窗口内的提交', async () => {
    const events = new WorkspaceEventBus();
    const response = handleWorkspaceEvents(
      request('/api/cooking/events'),
      'workspace-user',
      {
        canAccessSubmission: () => true,
        getWorkspace: () => {
          events.publish({ submissionId, revision: 5 });
          return workspace(4);
        },
      },
      events,
      60_000,
    );
    const reader = response.body!.getReader();
    await readChunk(reader);
    expect(await readChunk(reader)).toContain('"revision":4');
    expect(await readChunk(reader)).toContain('"revision":5');
    await reader.cancel();
  });

  test('连接期间权限被撤销后停止发送失效通知', async () => {
    let canAccess = true;
    const events = new WorkspaceEventBus();
    const response = handleWorkspaceEvents(
      request('/api/cooking/events'),
      'workspace-user',
      {
        canAccessSubmission: () => canAccess,
        getWorkspace: () => workspace(2),
      },
      events,
      60_000,
    );
    const reader = response.body!.getReader();
    await readChunk(reader);
    await readChunk(reader);

    canAccess = false;
    events.publish({ submissionId, revision: 3 });

    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test('单个监听器失败不会阻断其他连接或反向影响已提交命令', () => {
    const failures: unknown[] = [];
    const delivered: number[] = [];
    const events = new WorkspaceEventBus((error) => failures.push(error));
    events.subscribe(() => {
      throw new Error('连接已经失效');
    });
    events.subscribe(({ revision }) => delivered.push(revision));

    expect(() => events.publish({ submissionId, revision: 7 })).not.toThrow();
    expect(failures).toHaveLength(1);
    expect(delivered).toEqual([7]);
  });
});

function request(path: string): Request {
  return new Request(`http://server${path}?submissionId=${submissionId}`);
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const result = await reader.read();
  if (result.done) throw new Error('SSE Stream 意外结束');
  return new TextDecoder().decode(result.value);
}

function workspace(revision: number) {
  const now = '2026-07-27T02:00:00.000Z';
  const currentUser = {
    id: 'workspace-user',
    username: 'workspace-user',
    displayName: '工作区用户',
    createdAt: now,
  };
  return {
    revision,
    currentUser,
    availableActions: [],
    repairQueue: {
      submissionId,
      version: 1,
      entries: [],
      availableActions: [],
    },
    bugs: [],
    submissions: [
      {
        submission: submission(revision, now),
        projectName: '工作区项目',
        tester: currentUser,
        itemCount: 1,
      },
    ],
    submission: {
      submission: submission(revision, now),
      projectName: '工作区项目',
      tester: currentUser,
      createdBy: currentUser,
      items: [],
      availableActions: ['EDIT_DETAILS'] as const,
    },
  };
}

function submission(revision: number, now: string) {
  return {
    id: submissionId,
    projectId: '00000000-0000-4000-8000-000000000502',
    title: '工作区提测',
    requirementDescription: '验证 SSE',
    testerUserId: 'workspace-user',
    status: 'ACTIVE' as const,
    version: revision,
    workspaceRevision: revision,
    createdByUserId: 'workspace-user',
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
}
