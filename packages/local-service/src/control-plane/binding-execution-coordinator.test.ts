import { describe, expect, test } from 'bun:test';
import { BindingExecutionCoordinator } from './binding-execution-coordinator.js';

describe('BindingExecutionCoordinator', () => {
  test('同一个工程绑定始终串行并保留队列顺序', async () => {
    const coordinator = new BindingExecutionCoordinator(3);
    const events: string[] = [];
    const firstGate = deferred<void>();
    const first = coordinator.run('binding-a', async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
    });
    const second = coordinator.run('binding-a', async () => {
      events.push('second:start');
    });

    await tick();
    expect(events).toEqual(['first:start']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('等待用户交互时释放槽，同 binding 后续任务继续执行', async () => {
    const coordinator = new BindingExecutionCoordinator(1);
    const interaction = deferred<string>();
    const secondGate = deferred<void>();
    const events: string[] = [];
    const first = coordinator.run('binding-a', async (slot) => {
      events.push('first:turn');
      const answer = await slot.waitFor(interaction.promise);
      events.push(`first:resume:${answer}`);
    });
    await tick();
    expect(coordinator.availableSlots).toBe(1);

    const second = coordinator.run('binding-a', async () => {
      events.push('second:turn');
      await secondGate.promise;
      events.push('second:end');
    });
    await tick();
    expect(events).toEqual(['first:turn', 'second:turn']);

    interaction.resolve('approved');
    await tick();
    expect(events).toEqual(['first:turn', 'second:turn']);
    secondGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'first:turn',
      'second:turn',
      'second:end',
      'first:resume:approved',
    ]);
  });

  test('已回答的 continuation 在下一调度点优先于普通新任务', async () => {
    const coordinator = new BindingExecutionCoordinator(1);
    const interaction = deferred<void>();
    const blocker = deferred<void>();
    const events: string[] = [];
    const first = coordinator.run('binding-a', async (slot) => {
      events.push('waiting:start');
      await slot.waitFor(interaction.promise);
      events.push('waiting:resume');
    });
    await tick();
    const active = coordinator.run('binding-b', async () => {
      events.push('active:start');
      await blocker.promise;
      events.push('active:end');
    });
    const ordinary = coordinator.run(
      'binding-c',
      async () => {
        events.push('ordinary:start');
      },
      2,
    );
    interaction.resolve();
    await tick();
    blocker.resolve();
    await Promise.all([first, active, ordinary]);
    expect(events).toEqual([
      'waiting:start',
      'active:start',
      'active:end',
      'waiting:resume',
      'ordinary:start',
    ]);
  });

  test('不同工程绑定可并行，但不超过机器并发上限', async () => {
    const coordinator = new BindingExecutionCoordinator(2);
    const started: string[] = [];
    const gate = deferred<void>();
    const jobs = ['a', 'b', 'c'].map((bindingId) =>
      coordinator.run(bindingId, async () => {
        started.push(bindingId);
        await gate.promise;
      }),
    );

    await tick();
    expect(started).toEqual(['a', 'b']);
    gate.resolve();
    await Promise.all(jobs);
    expect(started).toEqual(['a', 'b', 'c']);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function tick() {
  await Bun.sleep(0);
}
