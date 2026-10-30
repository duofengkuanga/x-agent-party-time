import { expect, jest, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { RunnerHttpError } from '@agent-party-time/runner-contract/http-client';
import { codexUserInput } from '../codex/turnInput';
import { claimedExecution, createFixture, session } from './serviceFixture';
import { ExecutionRecovery } from './recovery';

const workspace = {
  key: 'lease-test',
  isolation: 'BRANCH_WORKTREE' as const,
  baseRef: 'main',
  branch: 'apt/lease-test',
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await readFile(import.meta.path);
  }
  throw new Error('condition timeout');
}

for (const phase of [
  'workspace',
  'codex-start',
  'start-ack',
  'session-read',
  'session-start-ack',
] as const) {
  test(`领取后在 ${phase} 等待超过租约也只启动一次`, async () => {
    const blocked = gate();
    let entered = false;
    const pause = async () => {
      entered = true;
      await blocked.promise;
    };
    const f = await createFixture({
      workspace,
      prepareWorkspace: phase === 'workspace' ? pause : undefined,
      readSessionId: phase.startsWith('session-') ? 'existing-session' : undefined,
    });
    const begin = f.executor.begin.bind(f.executor);
    if (phase === 'codex-start')
      f.executor.begin = async (input) => {
        await pause();
        return begin(input);
      };
    const read = f.executor.readLastCompletedTurn.bind(f.executor);
    if (phase === 'session-read')
      f.executor.readLastCompletedTurn = async () => {
        await pause();
        return read();
      };
    const start = f.http.startExecution.bind(f.http);
    let elapsed = 0;
    let expiry = 15_000;
    let renewals = 0;
    f.http.renewExecution = async () => {
      if (elapsed >= expiry) throw new RunnerHttpError('LEASE_EXPIRED', 'expired', 409);
      expiry = elapsed + 15_000;
      renewals++;
      return {
        expiresAt: new Date(Date.parse('2026-08-03T08:00:00Z') + expiry).toISOString(),
        cancellationRequested: false,
      };
    };
    f.http.startExecution = async (...args) => {
      if (phase.endsWith('start-ack')) await pause();
      if (elapsed >= expiry) throw new RunnerHttpError('LEASE_EXPIRED', 'expired', 409);
      return start(...args);
    };
    jest.useFakeTimers();
    try {
      await f.service.cycle(session);
      await waitFor(() => entered);
      for (let i = 1; i <= 4; i++) {
        elapsed = i * 5_000;
        jest.advanceTimersByTime(5_000);
        await waitFor(() => renewals === i && jest.getTimerCount() > 0);
      }
      blocked.resolve();
      await f.service.waitForIdle();
      expect(f.http.starts).toHaveLength(1);
      expect(f.http.starts[0]?.kind).toBe('STARTED');
      expect(f.executor.inputs).toHaveLength(phase.startsWith('session-') ? 0 : 1);
      expect(f.http.outcomes).toMatchObject([{ outcome: { kind: 'SUCCEEDED' } }]);
      expect(await f.state.loadExecutions()).toEqual([]);
      const finishedRenewals = renewals;
      jest.advanceTimersByTime(30_000);
      expect(renewals).toBe(finishedRenewals);
    } finally {
      blocked.resolve();
      await f.service.waitForIdle();
      await f.shutdownObservations();
      jest.useRealTimers();
    }
  });
}

test.each(['lease-lost', 'force-stop'] as const)(
  '准备阶段 %s 后不启动 Codex',
  async (reason) => {
    const blocked = gate();
    let entered = false;
    const f = await createFixture({
      workspace,
      prepareWorkspace: async () => {
        entered = true;
        await blocked.promise;
      },
    });
    let renewals = 0;
    f.http.renewExecution = async () => {
      renewals++;
      throw new RunnerHttpError('LEASE_EXPIRED', 'expired', 409);
    };
    jest.useFakeTimers();
    try {
      await f.service.cycle(session);
      await waitFor(() => entered);
      if (reason === 'force-stop') f.service.forceStop();
      else {
        jest.advanceTimersByTime(5_000);
        await waitFor(() => renewals === 1);
      }
      blocked.resolve();
      await f.service.waitForIdle();
      expect(f.executor.inputs).toEqual([]);
      expect(f.http.starts).toEqual([]);
      await f.shutdownObservations();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      blocked.resolve();
      await f.service.waitForIdle();
      await f.shutdownObservations();
      jest.useRealTimers();
    }
  },
);

for (const resumed of [false, true]) {
  test(`继续会话的附件仅在新执行发送：resumed=${resumed}`, async () => {
    const attachments = [
      {
        fileId: 'file-one',
        originalName: 'image.png',
        path: '/tmp/lease-test/image.png',
      },
    ];
    const f = await createFixture({ taskId: 'existing-session', attachments });
    if (resumed) f.http.claimed[0]!.sessionId = 'existing-session';
    await f.service.cycle(session);
    await f.service.waitForIdle();
    expect(f.executor.inputs[0]?.attachments).toEqual(resumed ? [] : attachments);
    expect(f.executor.inputs[0]?.taskId).toBe('existing-session');
    const message = JSON.stringify(codexUserInput(f.executor.inputs[0]!));
    if (resumed) {
      expect(message).not.toContain('新增附件本机路径');
      expect(message).not.toContain(attachments[0]!.path);
    } else {
      expect(message).toContain('新增附件本机路径');
      expect(message).toContain(attachments[0]!.path);
    }
    await f.shutdownObservations();
  });
}

test('同 Binding 排队期间也续租，前一任务结束后只启动一次', async () => {
  const f = await createFixture({ deferredExecutor: true });
  const second = claimedExecution(null, '00000000-0000-4000-8000-000000000311');
  f.http.claimed.push(second);
  const renewed: string[] = [];
  const renew = f.http.renewExecution.bind(f.http);
  Object.assign(f.http, {
    renewExecution: async (_origin: string, _credential: string, id: string) => {
      renewed.push(id);
      return renew();
    },
  });
  jest.useFakeTimers();
  try {
    await f.service.cycle(session);
    await waitFor(() => f.executor.inputs.length === 1);
    jest.advanceTimersByTime(5_000);
    await waitFor(() => renewed.includes(second.id));
    expect(f.executor.inputs).toHaveLength(1);
    f.executor.resolveNext();
    await waitFor(() => f.executor.inputs.length === 2);
    f.executor.resolveNext();
    await f.service.waitForIdle();
    expect(f.http.outcomes).toHaveLength(2);
  } finally {
    f.service.forceStop();
    f.executor.resolveAll();
    await f.service.waitForIdle();
    await f.shutdownObservations();
    jest.useRealTimers();
  }
});

test('结束等待进行中的续租落盘，随后清理不被旧续租复活', async () => {
  const f = await createFixture();
  const execution = claimedExecution(null);
  const recovery = new ExecutionRecovery(f.http, f.state, () => new Date());
  await recovery.recordPhase(execution, 'CLAIMED', null);
  const blocked = gate();
  let entered = false;
  f.http.renewExecution = async () => {
    entered = true;
    await blocked.promise;
    return { expiresAt: '2026-08-03T10:00:00.000Z', cancellationRequested: false };
  };
  jest.useFakeTimers();
  const lease = recovery.keepLease(session, execution, new AbortController());
  try {
    jest.advanceTimersByTime(5_000);
    await waitFor(() => entered);
    let stopped = false;
    const stopping = lease.stop().then(() => {
      stopped = true;
    });
    await readFile(import.meta.path);
    expect(stopped).toBe(false);
    blocked.resolve();
    await stopping;
    await f.state.removeExecution(execution.id);
    jest.advanceTimersByTime(30_000);
    expect(await f.state.loadExecutions()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    blocked.resolve();
    await lease.stop();
    await f.shutdownObservations();
    jest.useRealTimers();
  }
});

test('准备期续租落盘与 RUNNING 切换串行，不覆盖较新的执行阶段', async () => {
  const f = await createFixture();
  const execution = claimedExecution(null);
  const recovery = new ExecutionRecovery(f.http, f.state, () => new Date());
  await recovery.recordPhase(execution, 'CLAIMED', null);
  const blocked = gate();
  let entered = false;
  const save = f.state.saveExecution.bind(f.state);
  f.state.saveExecution = async (record) => {
    if (record.phase === 'CLAIMED') {
      entered = true;
      await blocked.promise;
    }
    await save(record);
  };
  const renewing = recovery.renew(session, execution);
  await waitFor(() => entered);
  const running = recovery.recordPhase(execution, 'RUNNING', 'existing-session');
  blocked.resolve();
  await Promise.all([renewing, running]);
  expect(await f.state.loadExecutions()).toMatchObject([
    { phase: 'RUNNING', sessionId: 'existing-session' },
  ]);
  await f.shutdownObservations();
});
