import { expect, test } from 'bun:test';
import type { Execution } from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/platform/database';
import type { ExecutionProjectionEvent } from '@/platform/execution/projection';
import { cookingExecutionProjection } from './executionProjection';

test('Cooking execution projection 同时按 namespace 与 kind 路由', () => {
  const projected: ExecutionProjectionEvent[] = [];
  const hooks = cookingExecutionProjection({} as AppDatabase, {
    BUG_REPAIR: (event) => projected.push(event),
    UPDATE_BATCH: () => {},
    CLEANUP: () => {},
  });
  const execution = {
    owner: { namespace: 'external', kind: 'BUG_REPAIR', id: 'task-one' },
  } as Execution;

  hooks({ phase: 'APPLY', kind: 'STARTED', execution });
  expect(projected).toEqual([]);

  execution.owner = {
    namespace: 'cooking',
    kind: 'BUG_REPAIR',
    id: 'attempt-one',
  };
  hooks({ phase: 'APPLY', kind: 'STARTED', execution });
  expect(projected).toEqual([{ phase: 'APPLY', kind: 'STARTED', execution }]);

  hooks({ phase: 'APPLY', kind: 'RESUMED', execution });
  hooks({ phase: 'AFTER', kind: 'RESUMED', execution });
  expect(projected.slice(-2)).toEqual([
    { phase: 'APPLY', kind: 'RESUMED', execution },
    { phase: 'AFTER', kind: 'RESUMED', execution },
  ]);
});
