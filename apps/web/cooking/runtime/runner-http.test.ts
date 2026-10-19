import { expect, test } from 'bun:test';
import { handleRunnerRequest } from './runner-http';

test('Next.js 耗时补报入口接入生产 Runner HTTP 处理器', async () => {
  const route =
    await import('../../app/api/runner/executions/[executionId]/observations/route');
  expect(route.POST).toBe(handleRunnerRequest);
});
