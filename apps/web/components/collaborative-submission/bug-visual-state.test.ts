import { expect, test } from 'bun:test';
import { bugVisualPresentation } from './bug-visual-state';

const bug = {
  status: 'UPDATING',
  repairActivity: null,
  updateActivity: 'RUNNING',
  latestRepairFailed: false,
} as const;

test('更新卡片区分运行、排队和等待人工介入', () => {
  expect(bugVisualPresentation(bug)).toEqual({
    state: 'running',
    label: 'Codex 正在更新',
  });

  expect(bugVisualPresentation({ ...bug, updateActivity: 'QUEUED' })).toEqual({
    state: 'queued',
    label: '等待更新',
  });

  expect(
    bugVisualPresentation({ ...bug, updateActivity: 'WAITING_INTERACTION' }),
  ).toEqual({
    state: 'waiting-interaction',
    label: '更新等待开发负责人处理',
  });
});
