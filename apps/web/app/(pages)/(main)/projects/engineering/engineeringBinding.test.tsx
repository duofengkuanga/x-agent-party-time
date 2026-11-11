import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import type { AppDatabase } from '@/server/database';
import { BindingRequestService } from '@/server/platform/projects/engineering/bindingRequestService';
import { EngineeringService } from '@/server/platform/projects/engineering/engineeringService';
import { RunnerService } from '@/server/platform/runner/service';
import { createBindingService } from '@/server/runtime/projects';
import { testDatabases } from '@/testing/database';
import { projectScenario } from '@/testing/submissions/scenario';
import { EngineeringDetail } from './engineeringSettings';

const createDatabase = testDatabases();
const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

async function setup() {
  const { database } = await createDatabase();
  const { users, project } = await projectScenario(database, {
    name: '工程绑定界面验收',
    owner: 'owner',
    members: ['member'],
    people: {
      owner: ['binding-ui-owner', '项目负责人'],
      member: ['binding-ui-member', '工程成员'],
    },
  });
  const engineering = new EngineeringService(database);
  const source = engineering.createEngineering(users.owner.id, project.id, {
    mutationId: randomUUID(),
    name: '待绑定工程',
    type: 'FRONTEND',
    identifier: 'binding-ui',
  });
  engineering.addMember(users.owner.id, source.id, users.member.id, {
    mutationId: randomUUID(),
  });
  const runners = new RunnerService(database);
  const paired = runners.pair(
    runners.issuePairingCode(users.member.id).code,
    '成员的 Agent',
  );
  runners.heartbeat(paired.credential);
  const bindings = createBindingService(database);
  const requests = new BindingRequestService(database, bindings);

  function render(userId = users.member.id, bindingRequestId?: string) {
    const state = globalThis as typeof globalThis & {
      __agentPartyTimeDatabase?: AppDatabase;
    };
    const previous = state.__agentPartyTimeDatabase;
    state.__agentPartyTimeDatabase = database;
    try {
      return renderToStaticMarkup(
        <AppRouterContext.Provider value={router}>
          <EngineeringDetail
            workspace={engineering.getWorkspace(userId, source.id)}
            userId={userId}
            runners={runners.listRunners(userId).filter(({ online }) => online)}
            bindingRequestId={bindingRequestId}
          />
        </AppRouterContext.Provider>,
      );
    } finally {
      state.__agentPartyTimeDatabase = previous;
    }
  }
  return {
    database,
    users,
    engineering,
    source,
    runners,
    paired,
    bindings,
    requests,
    render,
  };
}

test('当前成员未绑定时提供 Agent 选择，其他成员已有绑定不阻挡入口', async () => {
  const { users, engineering, source, runners, bindings, render } =
    await setup();
  engineering.addMember(users.owner.id, source.id, users.owner.id, {
    mutationId: randomUUID(),
  });
  const ownerRunner = runners.pair(
    runners.issuePairingCode(users.owner.id).code,
    '其他成员的 Agent',
  );
  bindings.createBinding(
    users.owner.id,
    source.id,
    ownerRunner.runner.id,
    randomUUID(),
  );
  const html = render();
  expect(html).toContain('绑定本机 Agent');
  expect(html).toContain('name="runnerId"');
  expect(html).toContain('成员的 Agent');
  expect(html).not.toContain('其他成员的 Agent');
  expect(html).not.toContain('binding-delete-control');
});

test('绑定请求显示等待和失败状态，允许重试，成功后整个绑定区域隐藏', async () => {
  const { users, source, paired, requests, render } = await setup();
  const request = requests.createRequest(
    users.member.id,
    source.id,
    paired.runner.id,
    randomUUID(),
  );
  expect(render(users.member.id, request.id)).toContain('等待 Agent 响应');
  expect(render(users.member.id, request.id)).not.toContain('name="runnerId"');
  requests.claimNext(paired.runner.id);
  expect(render(users.member.id, request.id)).toContain('等待选择仓库');
  requests.complete(paired.runner.id, request.id, {
    outcome: 'FAILED',
    code: 'CANCELLED',
    message: '已取消选择仓库目录',
  });
  const failed = render(users.member.id, request.id);
  expect(failed).toContain('已取消选择仓库目录');
  expect(failed).toContain('绑定本机 Agent');
  const retry = requests.createRequest(
    users.member.id,
    source.id,
    paired.runner.id,
    randomUUID(),
  );
  requests.claimNext(paired.runner.id);
  requests.complete(paired.runner.id, retry.id, {
    outcome: 'SUCCEEDED',
    repositoryUrl: 'https://example.com/binding-ui.git',
  });
  const bound = render(users.member.id, retry.id);
  expect(bound).not.toContain('engineering-binding-strip');
  expect(bound).not.toContain('成员的 Agent');
  expect(bound).not.toContain('binding-delete-control');
});

test('没有在线 Agent 时保留连接提示，非工程成员与归档工程不显示绑定入口', async () => {
  const { database, users, source, paired, render } = await setup();
  database.run('UPDATE platform_runner SET last_seen_at = NULL WHERE id = ?', [
    paired.runner.id,
  ]);
  expect(render()).toContain('需要先连接本机 Agent');
  expect(render()).toContain('href="/agents"');
  expect(render(users.owner.id)).not.toContain('engineering-binding-strip');
  database.run('UPDATE platform_engineering SET archived_at = ? WHERE id = ?', [
    new Date().toISOString(),
    source.id,
  ]);
  expect(render()).not.toContain('engineering-binding-strip');
});
