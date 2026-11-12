import { spawn } from 'node:child_process';
import { expect, test } from 'bun:test';
import type { Execution } from '@agent-party-time/execution-contract';
import {
  bindingId,
  claimedExecution,
  createFixture,
  executionId,
  session,
} from './serviceFixture';
import { RunnerHttpError } from '@agent-party-time/runner-contract/http-client';
import { CodexSessionReleaseError } from '../codex/errors';

test('已确认退出后清除持久进程归属，断网的结果回执不会被旧编号阻塞', async () => {
  const f = await createFixture({ failOutcome: true });
  const turn = f.http.claimed[0]!.codexTurn!;
  if (turn.kind === 'READ_SESSION') throw new Error('expected executable turn');
  turn.managedInteractions = true;
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const begin = f.executor.begin.bind(f.executor);
  f.executor.begin = async (input) => {
    await input.onProcessGroups?.([child.pid!]);
    const started = await begin(input);
    return {
      ...started,
      completion: started.completion.then(async (result) => {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('close', resolve));
        await input.onProcessGroups?.([]);
        return result;
      }),
    };
  };
  try {
    await f.service.cycle(session);
    await f.service.waitForIdle();
    expect(await f.state.loadOutbox()).toHaveLength(1);
    const pending = await f.state.loadExecutions();
    expect(pending).toHaveLength(1);
    expect(pending[0]).not.toHaveProperty('processGroups');
    f.setNow('2026-08-05T08:00:00.000Z');
    f.http.failOutcome = false;
    await f.restartedService().cycle(session);
    expect(await f.state.loadOutbox()).toHaveLength(0);
    expect(await f.state.loadExecutions()).toHaveLength(0);
  } finally {
    child.kill('SIGKILL');
    f.service.forceStop();
    await f.service.waitForIdle();
    await f.shutdownObservations();
  }
});

test('异常退出无法确认工具归属时保留恢复阻塞，根进程消失不自动放行', async () => {
  const f = await createFixture();
  const turn = f.http.claimed[0]!.codexTurn!;
  if (turn.kind === 'READ_SESSION') throw new Error('expected executable turn');
  turn.managedInteractions = true;
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const group = child.pid!;
  f.executor.begin = async (input) => {
    await input.onProcessGroups?.([group]);
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
    throw new CodexSessionReleaseError([group], undefined, true);
  };
  try {
    await f.service.cycle(session);
    for (let n = 0; n < 100 && !f.service.projection.recoveryRequired; n++)
      await new Promise((r) => setTimeout(r, 5));
    expect(f.service.projection.activeExecutionCount).toBe(1);
    expect(f.http.starts).toHaveLength(0);
    expect(f.http.outcomes).toHaveLength(0);
    f.service.forceStop();
    await f.service.waitForIdle();
    f.setNow('2026-08-03T10:00:00.000Z');
    expect(await f.restartedService().cycle(session)).toBe(false);
    expect(f.http.claimSlots).toEqual([3]);
    expect((await f.state.loadExecutions())[0]).toHaveProperty('processGroups', [group]);
  } finally {
    child.kill('SIGKILL');
    f.service.forceStop();
    await f.service.waitForIdle();
    await f.shutdownObservations();
  }
});

test('同一执行并发提问时只保存当前问题，让位后不会留下第二份阻塞回执', async () => {
  const f = await createFixture();
  const turn = f.http.claimed[0]!.codexTurn!;
  if (turn.kind === 'READ_SESSION') throw new Error('expected executable turn');
  turn.managedInteractions = true;
  f.executor.begin = async (input) => ({
    sessionId: 'parallel-questions',
    completion: Promise.resolve().then(async () => {
      await Promise.all(
        ['first', 'second'].map((id) =>
          input.onInteraction({
            method: 'item/tool/requestUserInput',
            payload: { questions: [{ id, header: '选择', question: id }] },
          }),
        ),
      );
      return { summary: 'done' };
    }),
  });
  const open = f.http.openInteraction.bind(f.http);
  let released: unknown;
  Object.assign(f.http, {
    openInteraction: async (...args: Parameters<typeof open>) => {
      if (f.http.openedInteractions.length)
        throw new RunnerHttpError('RESOURCE_CONFLICT', '已有待处理问题', 409);
      return open(...args);
    },
    waitInteraction: async () => ({
      interaction: { state: 'PENDING' },
      laneAcquired: false,
      yieldRequested: true,
    }),
    yieldInteraction: async (
      _origin: string,
      _credential: string,
      _id: string,
      request: unknown,
    ) => {
      released = request;
      return {} as Execution;
    },
  });
  try {
    await f.service.cycle(session);
    await f.service.waitForIdle();
    expect(released).toMatchObject({ payload: { questions: [{ id: 'first' }] } });
    expect(await f.state.loadOutbox()).toEqual([]);
    expect(f.http.outcomes).toEqual([]);
  } finally {
    f.service.forceStop();
    await f.service.waitForIdle();
    await f.shutdownObservations();
  }
});

test('另一个更新仍在运行时也重试已停止修复的让位回执', async () => {
  const f = await createFixture({
    interactionExecutor: true,
    workspace: {
      key: 'repair',
      isolation: 'BRANCH_WORKTREE',
      baseRef: 'main',
      branch: 'repair',
    },
  });
  const turn = f.http.claimed[0]!.codexTurn!;
  if (turn.kind === 'READ_SESSION') throw new Error('expected executable turn');
  turn.managedInteractions = true;
  f.http.claimed.push(
    claimedExecution(
      null,
      '00000000-0000-4000-8000-000000000399',
      bindingId,
      undefined,
      undefined,
      { key: 'update', isolation: 'DETACHED_WORKTREE', baseRef: 'main' },
    ),
  );
  const begin = f.executor.begin.bind(f.executor);
  let finishUpdate!: (value: { summary: string }) => void;
  f.executor.begin = async (input) =>
    input.executionId === executionId
      ? begin(input)
      : {
          sessionId: 'long-update',
          completion: new Promise((resolve) => {
            finishUpdate = resolve;
          }),
        };
  let offline = true;
  let attempts = 0;
  Object.assign(f.http, {
    waitInteraction: async () => ({
      interaction: { state: 'PENDING' },
      laneAcquired: false,
      yieldRequested: true,
    }),
    yieldInteraction: async () => {
      attempts++;
      if (offline) throw new Error('暂时断网');
      return {} as Execution;
    },
  });
  try {
    await f.service.cycle(session);
    for (
      let n = 0;
      n < 100 && (!attempts || f.service.projection.activeExecutionCount !== 1);
      n++
    )
      await new Promise((r) => setTimeout(r, 5));
    expect(f.service.projection.activeExecutionCount).toBe(1);
    offline = false;
    await f.service.cycle(session);
    expect(attempts).toBe(2);
    expect(await f.state.loadOutbox()).toEqual([]);
    expect(f.service.projection.activeExecutionCount).toBe(1);
  } finally {
    finishUpdate?.({ summary: 'done' });
    f.service.forceStop();
    await f.service.waitForIdle();
    await f.shutdownObservations();
  }
});

for (const phase of ['start', 'start-ack', 'completion', 'interaction'] as const)
  test(`${phase} 释放失败保持本机槽位，重启也不能越过尚存的进程组`, async () => {
    const f = await createFixture({ interactionExecutor: phase === 'interaction' });
    const turn = f.http.claimed[0]!.codexTurn!;
    if (turn.kind === 'READ_SESSION') throw new Error('expected executable turn');
    turn.managedInteractions = true;
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const group = child.pid!;
    const begin = f.executor.begin.bind(f.executor);
    if (phase === 'start-ack')
      f.http.startExecution = async () => {
        throw new Error('启动回执未送达');
      };
    f.executor.begin = async (input) => {
      await input.onProcessGroups?.([group]);
      if (phase === 'start') throw new CodexSessionReleaseError([group]);
      const started = await begin(input);
      return {
        ...started,
        completion: started.completion.finally(() => {
          throw new CodexSessionReleaseError([group]);
        }),
      };
    };
    let released = false;
    Object.assign(f.http, {
      waitInteraction: async () => ({
        interaction: { state: 'PENDING' },
        laneAcquired: false,
        yieldRequested: true,
      }),
      yieldInteraction: async () => {
        released = true;
        return {} as Execution;
      },
    });
    try {
      await f.service.cycle(session);
      for (let n = 0; n < 100 && !f.service.projection.recoveryRequired; n++)
        await new Promise((r) => setTimeout(r, 5));
      expect(f.service.projection.activeExecutionCount).toBe(1);
      expect(released).toBe(false);
      expect(f.http.outcomes).toEqual([]);
      expect((await f.state.loadExecutions())[0]).toHaveProperty('processGroups', [
        group,
      ]);
      f.setNow('2026-08-03T10:00:00.000Z');
      expect(await f.restartedService().cycle(session)).toBe(false);
      expect(f.http.claimSlots).toEqual([3]);
      child.kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => child.once('close', resolve));
      await f.service.waitForIdle();
      if (phase === 'interaction') expect(released).toBe(true);
      else if (phase === 'completion')
        expect(f.http.outcomes[0]?.outcome.kind).toBe('FAILED');
      else if (phase === 'start') expect(f.http.starts[0]?.kind).toBe('START_FAILED');
      else expect((await f.state.loadOutbox())[0]?.kind).toBe('START');
    } finally {
      child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => child.once('close', resolve));
      f.service.forceStop();
      await f.service.waitForIdle();
      await f.shutdownObservations();
    }
  });

test('让位回执在重启后先核实旧会话释放，响应丢失时重复投递同一回执', async () => {
  const f = await createFixture({ interactionExecutor: true });
  const turn = f.http.claimed[0]!.codexTurn!;
  if (turn.kind === 'READ_SESSION') throw new Error('expected executable turn');
  turn.managedInteractions = true;
  let offline = true;
  Object.assign(f.http, {
    waitInteraction: async () => ({
      interaction: { state: 'PENDING' },
      laneAcquired: false,
      yieldRequested: true,
    }),
    yieldInteraction: async () => {
      if (offline) throw new Error('网络不可用');
      return {} as Execution;
    },
  });
  try {
    await f.service.cycle(session);
    await f.service.waitForIdle();
    const saved = (await f.state.loadOutbox())[0]!;
    expect(saved.kind).toBe('INTERACTION_YIELD');
    if (saved.kind !== 'INTERACTION_YIELD') throw new Error('missing release receipt');
    await f.state.saveOutbox({ ...saved, sessionReleased: undefined });
    let releaseChecks = 0;
    Object.assign(f.executor, {
      releaseSession: async () => {
        releaseChecks++;
        throw new Error('旧会话仍有持有者');
      },
    });
    const restarted = f.restartedService();
    expect(await restarted.cycle(session)).toBe(false);
    expect(f.http.claimSlots).toEqual([3]);
    Object.assign(f.executor, {
      releaseSession: async (id: string) => {
        releaseChecks++;
        expect(id).toBe('thread-new');
      },
    });
    expect(await restarted.cycle(session)).toBe(false);
    expect(await f.state.loadOutbox()).toMatchObject([
      { id: saved.id, sessionReleased: true },
    ]);
    offline = false;
    await restarted.cycle(session);
    expect(releaseChecks).toBe(2);
    expect(await f.state.loadOutbox()).toEqual([]);
    expect(await f.state.loadExecutions()).toEqual([]);
    expect(f.http.outcomes).toEqual([]);
  } finally {
    f.service.forceStop();
    await f.service.waitForIdle();
    await f.shutdownObservations();
  }
});

test('等待让位先持久化并关闭会话，再释放本机槽位，且不提交失败结果', async () => {
  const f = await createFixture({ interactionExecutor: true });
  const turn = f.http.claimed[0]!.codexTurn!;
  if (turn.kind === 'READ_SESSION') throw new Error('expected executable turn');
  turn.managedInteractions = true;
  let stopped = false;
  const begin = f.executor.begin.bind(f.executor);
  f.executor.begin = async (...args) => {
    const started = await begin(...args);
    return {
      ...started,
      completion: started.completion.finally(() => {
        stopped = true;
      }),
    };
  };
  let released = false;
  let polls = 0;
  Object.assign(f.http, {
    waitInteraction: async () => {
      if (++polls > 1) throw new Error('让位指令未被处理');
      return {
        interaction: { state: 'PENDING' },
        laneAcquired: false,
        yieldRequested: true,
      };
    },
    yieldInteraction: async () => {
      expect(stopped).toBe(true);
      expect(await f.state.loadOutbox()).toMatchObject([
        { kind: 'INTERACTION_YIELD', sessionReleased: true },
      ]);
      released = true;
      return {} as Execution;
    },
  });
  try {
    await f.service.cycle(session);
    await f.service.waitForIdle();
    expect(released).toBe(true);
    expect(f.http.outcomes).toEqual([]);
    expect(f.service.projection.activeExecutionCount).toBe(0);
    expect(await f.state.loadExecutions()).toEqual([]);
    expect(await f.state.loadOutbox()).toEqual([]);
    await f.service.cycle(session);
    expect(f.http.claimSlots).toEqual([3, 3]);
  } finally {
    f.service.forceStop();
    await f.service.waitForIdle();
    await f.shutdownObservations();
  }
});
