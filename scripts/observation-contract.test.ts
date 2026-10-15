import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  activityDurationBounds,
  calculateObservationReport,
  intersectIntervals,
  intervalLength,
  unionIntervals,
} from '../packages/execution-contract/src/observability/accounting';
import { classifyCommand } from '../packages/execution-contract/src/observability/classification';
import {
  ObservationBatchSchema,
  ObservationEventSchema,
  type ObservationEvent,
} from '../packages/execution-contract/src/observability/schema';

const executionId = randomUUID();
const segmentId = randomUUID();
function event(
  sequence: number,
  name: ObservationEvent['name'],
  time: number,
  rest: Partial<ObservationEvent> = {},
): ObservationEvent {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    executionId,
    segmentId,
    sequence,
    name,
    observedElapsedMs: time,
    observedAt: new Date(1_700_000_000_000 + time).toISOString(),
    source: 'xapt',
    ...rest,
  };
}
function report(events: ObservationEvent[]) {
  return calculateObservationReport(events, {
    reportId: randomUUID(),
    executionId,
    revision: 1,
    parentReportId: null,
    inputDigest: 'a'.repeat(64),
    calculatedAt: '2026-10-15T00:00:00.000Z',
  });
}
function command(
  seq: number,
  id: string,
  start: number,
  end: number,
  activity: ObservationEvent['activity'] = 'build',
) {
  return [
    event(seq, 'item.started', start, { activity, correlation: { sourceItemId: id } }),
    event(seq + 1, 'item.finished', end, {
      activity,
      status: 'succeeded',
      correlation: { sourceItemId: id },
    }),
  ];
}

describe('可信区间核算', () => {
  test('并行和嵌套按并集合并，输入排列不改变结果', () => {
    expect(
      unionIntervals([
        [20, 60],
        [0, 40],
        [10, 30],
      ]),
    ).toEqual([[0, 60]]);
    expect(
      intervalLength([
        [0, 60],
        [10, 30],
        [40, 50],
      ]),
    ).toBe(60);
    expect(
      intervalLength(
        intersectIntervals(
          [[0, 60]],
          [
            [10, 30],
            [40, 50],
          ],
        ),
      ),
    ).toBe(30);
    expect(() => unionIntervals([[20, 10]])).toThrow();
  });
  test('工具与交互的重叠不会重复累计，未知区间仍保留', () => {
    const result = report([
      event(1, 'execution.received', 0),
      ...command(2, 'a', 0, 40),
      ...command(4, 'b', 20, 60),
      event(6, 'interaction.requested', 30, {
        correlation: { intervalId: 'interaction' },
      }),
      event(7, 'interaction.responded', 70, {
        correlation: { intervalId: 'interaction' },
      }),
      event(8, 'delivery.accepted', 100),
    ]);
    expect(result.totalMs).toBe(100);
    expect(result.segments[0]).toMatchObject({
      toolMs: 60,
      cumulativeToolMs: 80,
      interactionMs: 40,
      overlapMs: 30,
      unassignedMs: 30,
    });
  });
  test('来源 duration 没有位置时不从未归因区间扣除', () => {
    const result = report([
      event(1, 'execution.received', 0),
      ...command(2, 'a', 20, 40),
      event(4, 'item.finished', 80, {
        sourceDurationMs: 30,
        correlation: { sourceItemId: 'unplaced' },
      }),
      event(5, 'delivery.accepted', 100),
    ]);
    expect(result.totalMs).toBe(100);
    expect(result.segments[0]!.unassignedMs).toBe(80);
    expect(result.unplaced[0]!.durationMs).toBe(30);
    expect(result.issues).toContain('missing_boundary');
  });
  test('总端点完整不因内部缺结束而变成未知', () => {
    const result = report([
      event(1, 'execution.received', 0),
      event(2, 'item.started', 10, { correlation: { sourceItemId: 'a' } }),
      event(3, 'delivery.accepted', 100),
    ]);
    expect(result.totalMs).toBe(100);
    expect(result.intervals).toHaveLength(0);
    expect(result.attributionQuality).toBe('partial');
  });
  test('同一事件重放不增加计数，冲突内容不会最后写入胜出', () => {
    const events = [
      event(1, 'execution.received', 0),
      ...command(2, 'a', 10, 20),
      event(4, 'delivery.accepted', 100),
    ];
    expect(report([...events, ...events]).eventCount).toBe(4);
    expect(report([...events, ...events]).segments[0]!.toolMs).toBe(10);
    const conflict = report([...events, { ...events[0]!, observedElapsedMs: 30 }]);
    expect(conflict.issues).toContain('conflict');
    expect(conflict.totalMs).toBeNull();
  });
  test('跨重启片段不拼出精确整体历时，墙上时间不参与区间计算', () => {
    const result = report([
      event(1, 'execution.received', 0),
      event(2, 'gap', 40),
      event(1, 'segment.opened', 0, {
        segmentId: randomUUID(),
        observedAt: '2025-01-01T00:00:00.000Z',
      }),
    ]);
    expect(result.totalMs).toBeNull();
    expect(result.envelopeQuality).toBe('fragmented');
    expect(result.issues).toContain('recording_gap');
  });
  test('上下界只能由显式存活/停止证据形成', () => {
    expect(activityDurationBounds(10)).toEqual({ lowerMs: 0, upperMs: null });
    expect(activityDurationBounds(10, 30, 100)).toEqual({ lowerMs: 20, upperMs: 90 });
    expect(() => activityDurationBounds(10, 30, 20)).toThrow();
  });
  test('不同执行的事件不能混入报告', () => {
    expect(() =>
      report([event(1, 'execution.received', 0, { executionId: randomUUID() })]),
    ).toThrow('执行关联');
  });
});

describe('保守分类和证据', () => {
  test('不以脚本名字、echo、动态展开证明构建或测试', () => {
    expect(classifyCommand('pnpm run build:test')).toBe('unknown');
    expect(classifyCommand('echo "npm test"')).toBe('unknown');
    expect(classifyCommand('$(get-command) build')).toBe('unknown');
    expect(classifyCommand('node --test --help')).toBe('read');
    expect(classifyCommand('umi build')).toBe('build');
    expect(classifyCommand('/bin/zsh -lc "node --test tests/a.test.js"')).toBe('test');
    expect(classifyCommand('git status && npm test')).toBe('unknown');
    expect(classifyCommand('deploy-cli-service deploy --mode dev84')).toBe('deploy');
  });
  test('相同类别但缺少范围依据时只报告重复调用', () => {
    const result = report([
      event(1, 'execution.received', 0),
      ...command(2, 'a', 10, 20),
      ...command(4, 'b', 30, 40),
      event(6, 'delivery.accepted', 50),
    ]);
    const finding = result.findings.find((f) => f.kind === 'repeated_invocation');
    expect(result.findings.some((f) => f.kind === 'potential_duplicate_work')).toBe(
      false,
    );
    expect(finding?.equivalence).toBe('unknown');
    expect(finding?.estimatedSavingMs).toBeNull();
    expect(finding?.missing).toContain('phase_requirements');
  });
  test('安全事件拒绝原始输出、命令、路径和未知配置字段', () => {
    const valid = event(1, 'execution.received', 0);
    for (const extra of [
      { command: 'secret' },
      { output: 'secret' },
      { path: '/private' },
      { configuration: { password: 'secret' } },
    ])
      expect(ObservationEventSchema.safeParse({ ...valid, ...extra }).success).toBe(
        false,
      );
    expect(
      ObservationBatchSchema.safeParse({
        schemaVersion: 1,
        batchId: randomUUID(),
        executionId,
        digest: 'a'.repeat(64),
        events: [event(1, 'execution.received', 0, { executionId: randomUUID() })],
        report: null,
      }).success,
    ).toBe(false);
  });
});

test('内部活动冲突不抹掉可靠整体端点，并保留活动未知边界', () => {
  const result = report([
    event(1, 'execution.received', 0),
    ...command(2, 'broken', 40, 20),
    event(4, 'delivery.accepted', 100),
  ]);
  expect(result.totalMs).toBe(100);
  expect(result.envelopeQuality).toBe('complete');
  expect(result.attributionQuality).toBe('conflict');
  expect(result.incompleteActivities[0]).toMatchObject({
    boundary: 'conflict',
    lowerMs: 0,
    upperMs: null,
  });
});

test('来源回执按独立发生与范围线索识别候选，内部未知时长保持未知', () => {
  const workId = randomUUID();
  const entries = [
    event(1, 'execution.received', 0),
    event(2, 'activity.observed', 20, {
      activity: 'build',
      reason: 'source_reported',
      workId,
      status: 'succeeded',
      correlation: { sourceItemId: 'one', parentIntervalId: 'outer-one' },
    }),
    event(3, 'activity.observed', 40, {
      activity: 'build',
      reason: 'source_reported',
      workId,
      status: 'succeeded',
      correlation: { sourceItemId: 'two', parentIntervalId: 'outer-two' },
    }),
    event(4, 'delivery.accepted', 100),
  ];
  const result = report(entries);
  expect(result.unplaced.map((entry) => entry.durationMs)).toEqual([null, null]);
  expect(result.segments[0]!.unassignedMs).toBe(100);
  expect(result.findings[0]).toMatchObject({
    kind: 'potential_duplicate_work',
    strength: 'source_reported',
    equivalence: 'unknown',
    estimatedSavingMs: null,
  });
  expect(
    report(
      entries.map((entry, i) => (i === 2 ? { ...entry, workId: randomUUID() } : entry)),
    ).findings[0]!.kind,
  ).toBe('repeated_invocation');
  expect(
    report(entries.map((entry, i) => (i === 2 ? { ...entry, status: 'failed' } : entry)))
      .findings[0]!.kind,
  ).toBe('repeated_invocation');
});

test('同一终态多个接受回执取首次可靠端点，不把清理重试当作整体冲突', () => {
  const result = report([
    event(1, 'execution.received', 0),
    event(2, 'delivery.accepted', 100, { correlation: { intervalId: 'first' } }),
    event(3, 'delivery.accepted', 120, { correlation: { intervalId: 'retry' } }),
  ]);
  expect(result.totalMs).toBe(100);
  expect(result.envelopeQuality).toBe('complete');
});

test('父子工具累计只计外层，跨连接同名父活动不会吞掉独立来源事实', () => {
  const connectionId = randomUUID();
  const other = randomUUID();
  const workId = randomUUID();
  const outer = command(2, 'a', 10, 60).map((entry) => ({
    ...entry,
    correlation: { ...entry.correlation, connectionId },
  }));
  const inner = command(4, 'b', 20, 40).map((entry) => ({
    ...entry,
    correlation: { ...entry.correlation, connectionId, parentIntervalId: 'a' },
  }));
  const result = report([
    event(1, 'execution.received', 0),
    ...outer,
    ...inner,
    event(6, 'activity.observed', 70, {
      activity: 'build',
      reason: 'source_reported',
      status: 'succeeded',
      workId,
      correlation: { connectionId: other, parentIntervalId: 'a', sourceItemId: 'new' },
    }),
    event(7, 'delivery.accepted', 100),
  ]);
  expect(result.segments[0]!.cumulativeToolMs).toBe(50);
  expect(
    result.findings.some(
      (finding) => finding.kind === 'repeated_invocation' && finding.activity === 'build',
    ),
  ).toBe(true);
});

test('相同来源发生身份跨连接重放不增加构建次数，内容冲突隔离该发生', () => {
  const sourceItemId = randomUUID();
  const workId = randomUUID();
  const first = event(2, 'activity.observed', 20, {
    activity: 'build',
    reason: 'source_reported',
    status: 'succeeded',
    workId,
    correlation: { sourceItemId, connectionId: randomUUID() },
  });
  const replay = {
    ...first,
    eventId: randomUUID(),
    sequence: 3,
    correlation: { sourceItemId, connectionId: randomUUID() },
  };
  const base = [
    event(1, 'execution.received', 0),
    first,
    replay,
    event(4, 'delivery.accepted', 100),
  ];
  expect(report(base).unplaced).toHaveLength(1);
  expect(
    report(base).findings.some((entry) => entry.kind === 'potential_duplicate_work'),
  ).toBe(false);
  const conflict = report(
    base.map((entry) => (entry === replay ? { ...entry, sourceDurationMs: 25 } : entry)),
  );
  expect(conflict.unplaced).toHaveLength(0);
  expect(conflict.attributionQuality).toBe('conflict');
  expect(conflict.totalMs).toBe(100);
});
