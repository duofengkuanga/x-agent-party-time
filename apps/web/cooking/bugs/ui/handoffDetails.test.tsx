import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';
import { testDatabases } from '@/testing/database';
import { UpdateAttemptDetails } from './updateDetails';
import {
  completeNextRepair,
  completedUpdate,
  failedUpdate,
  freezeUpdate,
  startExecution,
  updateFixture,
} from '@/cooking/update/server/updateFixture';

const setup = updateFixture(testDatabases());

test.each(['COMPLETED', 'FAILED'] as const)(
  '%s 更新详情解释上下文采用与当前验收，测试负责人看不到技术内容',
  async (outcome) => {
    const f = await setup();
    f.createBug('交接详情');
    await completeNextRepair(f, 'details-repair', ['a'.repeat(40)]);
    const frozen = freezeUpdate(f);
    const started = await startExecution(
      f,
      frozen.executionId,
      'details-update',
    );
    const handoffUse = {
      adopted: ['沿用已确认的测试入口'],
      rechecked: [{ context: '打包参数', reason: '工具版本变化' }],
      validationCommands: [
        {
          validationIndex: 0,
          command: 'bun run check:delivery',
          workingDirectory: '.',
          reason: '一次覆盖测试与构建',
        },
      ],
    };
    f.executions.complete(f.runner.id, started.executionId, {
      leaseToken: started.leaseToken,
      sessionId: started.sessionId,
      outcome: {
        kind: 'SUCCEEDED',
        result: {
          result: {
            ...(outcome === 'COMPLETED'
              ? completedUpdate().result
              : failedUpdate('本次更新未完成').result),
            validations: [
              {
                name: '交付检查',
                status: outcome === 'COMPLETED' ? 'PASSED' : 'FAILED',
                detail: '',
              },
            ],
            handoffUse,
          },
        },
      },
    });
    const render = (userId: string) => {
      const batch = f.updates.batchView(userId, frozen.batchId);
      const node = batch.timeline.find(
        (entry) => entry.kind === 'UPDATE_ATTEMPT',
      )!;
      if (node.kind !== 'UPDATE_ATTEMPT') throw new Error('需要更新轮次');
      return renderToStaticMarkup(
        <UpdateAttemptDetails
          batch={batch}
          node={node}
          round={1}
          latest
          current
          pending={false}
          run={() => {}}
          currentSessionId={node.sessionId}
        />,
      );
    };
    const developer = render(f.users.developer.id);
    expect(developer).toContain('沿用已确认的测试入口');
    expect(developer).toContain('工具版本变化');
    expect(developer).toContain('一次覆盖测试与构建');
    expect(developer).toContain('历史上下文不代表本轮检查通过');
    expect(developer).toContain('bun run check:delivery');
    const tester = render(f.users.tester.id);
    expect(tester).not.toContain('bun run check:delivery');
    expect(tester).not.toContain('工具版本变化');
    expect(tester).toContain('交付检查');
  },
);
