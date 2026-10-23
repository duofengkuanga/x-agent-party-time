import { describe, expect, test } from 'bun:test';
import { SubmissionVisualPresentationSchema } from './shared';

describe('SubmissionVisualPresentationSchema', () => {
  test('只接受一个服务端判别状态', () => {
    for (const [state, symbol] of [
      ['IDLE', '·'],
      ['RUNNING', '●'],
      ['NEEDS_APPROVAL', '!'],
      ['NEEDS_INPUT', '?'],
      ['FAILED', '×'],
      ['WAITING_TO_RESUME', 'Ⅱ'],
      ['QUEUED_FOR_ENGINEERING', '…'],
    ] as const) {
      const value = {
        state,
        label: '状态',
        symbol,
        ...(state === 'QUEUED_FOR_ENGINEERING' ? { aheadCount: 2 } : {}),
      };
      expect(SubmissionVisualPresentationSchema.parse(value)).toEqual(value);
    }

    expect(() =>
      SubmissionVisualPresentationSchema.parse({
        state: 'RUNNING',
        label: '运行中',
        symbol: '●',
        waitingForInteraction: true,
      }),
    ).toThrow();
    expect(() =>
      SubmissionVisualPresentationSchema.parse({
        state: 'NEEDS_APPROVAL',
        label: '需要审批',
        symbol: '?',
      }),
    ).toThrow();
  });
});
