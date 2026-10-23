import { expect, test } from 'bun:test';
import { RunnerHttpError } from '@agent-party-time/runner-contract/http-client';
import { CodexManualHandoff } from '../codex/manualHandoff';
import { createFixture, session } from './serviceFixture';

for (const lostPreparationAck of [false, true])
  test(`接管回执持久化、释放与恢复；准备响应${lostPreparationAck ? '丢失' : '正常'}`, async () => {
    const f = await createFixture({
      failOutcome: true,
      owner: { namespace: 'cooking', kind: 'BUG_REPAIR', id: 'bug' },
    });
    const turn = f.http.claimed[0]!.codexTurn!;
    if (turn.kind === 'READ_SESSION') throw new Error('expected executable turn');
    turn.manualHandoff = 'EXTERNAL_SESSION';
    const open = f.http.openInteraction.bind(f.http);
    if (lostPreparationAck)
      f.http.openInteraction = async (...args) => {
        f.http.openInteraction = open;
        await open(...args);
        throw new Error('acknowledgement lost');
      };
    const complete = f.http.completeExecution.bind(f.http);
    f.http.completeExecution = async (...args) => {
      const receipt = (await f.state.loadOutbox())[0]!;
      expect(receipt.kind === 'OUTCOME' && receipt.sessionReleased).toBe(true);
      if (!f.http.openedInteractions.length)
        throw new RunnerHttpError('INVALID_TRANSITION', '人工接管尚未准备', 409);
      return complete(...args);
    };
    f.executor.begin = async (input) => ({
      sessionId: 'manual-thread',
      completion: new Promise((_resolve, reject) =>
        setTimeout(async () => {
          try {
            await input.onManualHandoff!([
              '确认修改 /Users/example/private/file 的权限？',
            ]);
            expect(f.http.outcomes).toHaveLength(0);
            expect(f.http.openedInteractions).toHaveLength(1);
            const entries = await f.state.loadOutbox();
            expect(entries).toHaveLength(1);
            expect(JSON.stringify(entries)).not.toContain('/Users/example');
            reject(new CodexManualHandoff(['确认修改权限？']));
          } catch (error) {
            reject(error);
          }
        }, 0),
      ),
    });
    await f.service.cycle(session);
    await f.service.waitForIdle();
    expect(await f.state.loadOutbox()).toHaveLength(1);
    expect(f.verifiedBaselines).toHaveLength(0);
    const saved = (await f.state.loadOutbox())[0]!;
    expect(saved.kind === 'OUTCOME' && saved.sessionReleased).toBe(true);
    // Reconstruct a crash after the write-ahead record but before exit proof.
    if (saved.kind !== 'OUTCOME') throw new Error('expected outcome journal');
    await f.state.saveOutbox({ ...saved, sessionReleased: undefined });
    let releaseChecks = 0;
    Object.assign(f.executor, {
      releaseSession: async () => {
        releaseChecks++;
        throw new Error('仍有持有者');
      },
    });
    const restarted = f.restartedService();
    expect(await restarted.cycle(session)).toBe(false);
    expect(await f.state.loadOutbox()).toHaveLength(1);
    Object.assign(f.executor, {
      releaseSession: async (id: string) => {
        expect(id).toBe('manual-thread');
        releaseChecks++;
      },
    });
    f.http.failOutcome = false;
    f.http.openedInteractions.length = 0;
    f.http.openInteraction = async () => {
      throw new Error('network');
    };
    expect(await restarted.cycle(session)).toBe(false);
    expect(await f.state.loadOutbox()).toMatchObject([{ sessionReleased: true }]);
    f.http.openInteraction = open;
    await restarted.cycle(session);
    expect(releaseChecks).toBe(2);
    expect(await f.state.loadOutbox()).toEqual([]);
    expect(await f.state.loadExecutions()).toEqual([]);
    expect(f.http.outcomes).toMatchObject([{ outcome: { kind: 'HANDED_OFF' } }]);
    expect(f.http.outcomes).toHaveLength(1);
    // A lost HTTP acknowledgement after confirmed release must not load the
    // user's now-open session again, or block replay on its new writer lock.
    await f.state.saveOutbox({ ...saved, sessionReleased: true });
    Object.assign(f.executor, {
      releaseSession: async () => {
        throw new Error('不应重新加载已交给用户的会话');
      },
    });
    const remove = f.state.removeExecution.bind(f.state);
    f.state.removeExecution = async () => {
      throw new Error('disk unavailable');
    };
    expect(await f.restartedService().cycle(session)).toBe(false);
    expect(await f.state.loadOutbox()).toHaveLength(1);
    f.state.removeExecution = remove;
    await f.restartedService().cycle(session);
    expect(await f.state.loadOutbox()).toEqual([]);
    expect(f.http.outcomes).toHaveLength(3);
    expect(f.http.openedInteractions).toHaveLength(1);
  });
