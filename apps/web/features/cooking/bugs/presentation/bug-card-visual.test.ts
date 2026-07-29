import { describe, expect, test } from 'bun:test';
import { bugCardVisualPresentation } from './bug-card-visual';

describe('bugCardVisualPresentation', () => {
  test('等待修复或更新交互时提示用户点击卡片', () => {
    expect(
      bugCardVisualPresentation({
        repairExecutionState: 'WAITING_FOR_INTERACTION',
      }),
    ).toEqual({
      state: 'attention',
      label: '等待用户操作 · 点击查看详情',
    });
    expect(
      bugCardVisualPresentation({ updateBatchState: 'WAITING_EXTERNAL' }),
    ).toEqual({
      state: 'attention',
      label: '等待用户操作 · 点击查看详情',
    });
    expect(bugCardVisualPresentation({ waitingForInteraction: true })).toEqual({
      state: 'attention',
      label: '等待用户操作 · 点击查看详情',
    });
  });

  test('修复或更新执行失败时提示查看异常详情', () => {
    expect(
      bugCardVisualPresentation({ repairExecutionState: 'FAILED' }),
    ).toEqual({
      state: 'failed',
      label: 'Codex 执行异常 · 点击查看详情',
    });
    expect(
      bugCardVisualPresentation({ updateExecutionState: 'FAILED' }),
    ).toEqual({
      state: 'failed',
      label: 'Codex 执行异常 · 点击查看详情',
    });
    expect(bugCardVisualPresentation({ updateBatchState: 'FAILED' })).toEqual({
      state: 'failed',
      label: 'Codex 执行异常 · 点击查看详情',
    });
  });

  test('正常运行继续使用阶段颜色和呼吸效果', () => {
    expect(
      bugCardVisualPresentation({ repairExecutionState: 'RUNNING' }),
    ).toEqual({ state: null, label: null });
    expect(
      bugCardVisualPresentation({ updateExecutionState: 'RUNNING' }),
    ).toEqual({ state: null, label: null });
  });
});
