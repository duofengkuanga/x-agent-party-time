import { expect, test } from 'bun:test';
import v8 from 'node:v8';
import { register } from '../../instrumentation';
import { installDevHeapStatisticsSampling } from './devHeapStatistics';

test('开发服务器一批请求只采样一次，并在一秒后读取新数据', () => {
  const baseline = v8.getHeapStatistics();
  let reads = 0;
  let time = 0;
  const target = { getHeapStatistics: () => ({ ...baseline, used_heap_size: ++reads }) };
  installDevHeapStatisticsSampling(target, () => time);
  for (let i = 0; i < 40; i++) expect(target.getHeapStatistics().used_heap_size).toBe(1);
  expect(reads).toBe(1);
  time = 999;
  expect(target.getHeapStatistics().used_heap_size).toBe(1);
  time = 1_000;
  expect(target.getHeapStatistics().used_heap_size).toBe(2);
  expect(reads).toBe(2);
});

test('重复注册不会叠加包装，调用者也不能修改缓存中的统计值', () => {
  const baseline = v8.getHeapStatistics();
  const target = { getHeapStatistics: () => ({ ...baseline }) };
  installDevHeapStatisticsSampling(target, () => 0);
  const reader = target.getHeapStatistics;
  installDevHeapStatisticsSampling(target, () => 0);
  expect(target.getHeapStatistics).toBe(reader);
  const result = target.getHeapStatistics();
  result.used_heap_size = -1;
  expect(target.getHeapStatistics().used_heap_size).toBe(baseline.used_heap_size);
});

test('耗时采样完成后才开始缓存有效期，避免大堆下每次请求都重新扫描', () => {
  const baseline = v8.getHeapStatistics();
  let time = 0;
  let reads = 0;
  const target = {
    getHeapStatistics: () => {
      reads++;
      time += 2_000;
      return { ...baseline };
    },
  };
  installDevHeapStatisticsSampling(target, () => time);
  for (let i = 0; i < 20; i++) target.getHeapStatistics();
  expect(reads).toBe(1);
  time += 1_000;
  target.getHeapStatistics();
  expect(reads).toBe(2);
});

test('启动钩子只在 Bun 开发运行时采样，不修改生产运行时', async () => {
  const mode = process.env.NODE_ENV;
  const runtime = process.env.NEXT_RUNTIME;
  const original = v8.getHeapStatistics;
  let reads = 0;
  const baseline = original();
  try {
    const reader = () => {
      reads++;
      return { ...baseline };
    };
    v8.getHeapStatistics = reader;
    process.env.NODE_ENV = 'production';
    process.env.NEXT_RUNTIME = 'nodejs';
    await register();
    expect(v8.getHeapStatistics).toBe(reader);
    process.env.NODE_ENV = 'development';
    await register();
    for (let i = 0; i < 20; i++) v8.getHeapStatistics();
    expect(reads).toBe(1);
  } finally {
    v8.getHeapStatistics = original;
    if (mode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = mode;
    if (runtime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = runtime;
  }
});
