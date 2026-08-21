import { expect, test } from 'bun:test';
import type { Execution } from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/server/database';
import {
  cookingExecutionProjection,
  type CookingExecutionProjectionEvent,
} from './execution-projection';

test('Cooking execution projection 同时按 namespace 与 kind 路由', () => {
  const projected: CookingExecutionProjectionEvent[] = [];
  const hooks = cookingExecutionProjection({} as AppDatabase, {
    BUG_REPAIR: { projectExecution: (event) => projected.push(event) },
    SESSION_SYNC: { projectExecution: () => {} },
    UPDATE_BATCH: { projectExecution: () => {} },
    CLEANUP: { projectExecution: () => {} },
  });
  const execution = {
    owner: { namespace: 'external', kind: 'BUG_REPAIR', id: 'task-one' },
  } as Execution;

  hooks.applyStarted(execution);
  expect(projected).toEqual([]);

  execution.owner = {
    namespace: 'cooking',
    kind: 'BUG_REPAIR',
    id: 'attempt-one',
  };
  hooks.applyStarted(execution);
  expect(projected).toEqual([{ phase: 'APPLY', kind: 'STARTED', execution }]);

  hooks.applyResumed(execution);
  hooks.afterResumed(execution);
  expect(projected.slice(-2)).toEqual([
    { phase: 'APPLY', kind: 'RESUMED', execution },
    { phase: 'AFTER', kind: 'RESUMED', execution },
  ]);
});
