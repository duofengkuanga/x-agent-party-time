import { describe, expect, test } from 'bun:test';
import type { InteractiveActionResult } from '@/app/actions/actionTransport';
import { createAutoSaveQueue, type AutoSaveState } from './autoSaveQueue';

type Result = InteractiveActionResult<{ version: number }>;
function deferred() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(save: (data: FormData) => Promise<Result>) {
  const states: AutoSaveState[] = [];
  const queue = createAutoSaveQueue({
    initial: { name: '原名称' },
    version: 1,
    save,
    onState: (state) => states.push(state),
    describeError: () => '网络中断，输入已保留',
  });
  return { queue, states };
}

describe('Automatic project saving', () => {
  test('未修改字段不写入，也不会被无关刷新触发保存', async () => {
    let calls = 0;
    const { queue } = setup(async () => {
      calls++;
      return { ok: true, result: { version: 2 } };
    });
    expect(await queue.flush()).toBe(true);
    expect(calls).toBe(0);
  });

  test('保存期间保留后续输入，串行使用新版本，只发送最后一份草稿', async () => {
    const first = deferred();
    const calls: FormData[] = [];
    const { queue } = setup(async (data) => {
      calls.push(data);
      return calls.length === 1 ? first.promise : { ok: true, result: { version: 3 } };
    });
    queue.update({ name: '第一次输入' });
    const pending = queue.flush();
    queue.update({ name: '中间输入' });
    queue.update({ name: '最后输入' });
    expect(queue.flush()).toBe(pending);
    expect(calls.length).toBe(1);
    first.resolve({ ok: true, result: { version: 2 } });
    expect(await pending).toBe(true);
    expect(calls.map((data) => [data.get('name'), data.get('expectedVersion')])).toEqual([
      ['第一次输入', '1'],
      ['最后输入', '2'],
    ]);
    expect(calls[0]!.get('mutationId')).not.toBe(calls[1]!.get('mutationId'));
    expect(queue.hasChanges()).toBe(false);
  });

  test('保存期间改回旧值也会正确写回', async () => {
    const first = deferred();
    const names: string[] = [];
    const { queue } = setup(async (data) => {
      names.push(String(data.get('name')));
      return names.length === 1 ? first.promise : { ok: true, result: { version: 3 } };
    });
    queue.update({ name: '改名' });
    const pending = queue.flush();
    queue.update({ name: '原名称' });
    first.resolve({ ok: true, result: { version: 2 } });
    await pending;
    expect(names).toEqual(['改名', '原名称']);
  });

  test('结果未知时重试同一次操作，确认后再保存最新输入', async () => {
    const calls: FormData[] = [];
    const { queue, states } = setup(async (data) => {
      calls.push(data);
      if (calls.length === 1) throw new TypeError('Failed to fetch');
      return { ok: true, result: { version: calls.length } };
    });
    queue.update({ name: '已发送' });
    expect(await queue.flush()).toBe(false);
    queue.update({ name: '后续输入' });
    expect(await queue.flush()).toBe(false);
    expect(calls.length).toBe(1);
    expect(states.at(-1)?.message).toContain('输入已保留');
    expect(await queue.flush(true)).toBe(true);
    expect(calls[0]!.get('mutationId')).toBe(calls[1]!.get('mutationId'));
    expect(calls[2]!.get('expectedVersion')).toBe('2');
    expect(calls[2]!.get('name')).toBe('后续输入');
  });

  test('版本冲突保留草稿并阻止导航，不用陈旧版本覆盖他人修改', async () => {
    const { queue, states } = setup(async () => ({
      ok: false,
      error: { code: 'STALE_STATE', message: '工程已更新，请刷新后重试' },
    }));
    queue.update({ name: '本地草稿' });
    expect(await queue.flush()).toBe(false);
    expect(queue.hasChanges()).toBe(true);
    expect(states.at(-1)?.message).toContain('工程已更新');
  });

  test('不完整配置不提交，补齐后自动恢复保存', async () => {
    let calls = 0;
    const { queue } = setup(async () => {
      calls++;
      return { ok: true, result: { version: 2 } };
    });
    queue.update({ name: '' }, '名称不能为空');
    expect(await queue.flush()).toBe(false);
    expect(calls).toBe(0);
    queue.update({ name: '完整名称' });
    expect(await queue.flush()).toBe(true);
    expect(calls).toBe(1);
  });
});
