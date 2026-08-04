import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const agentsRoot = import.meta.dir;

test('已停用 Agent 提供重新启用入口', async () => {
  const form = await readFile(
    join(agentsRoot, 'agent-revoke-form.tsx'),
    'utf8',
  );
  expect(form).toContain('reactivateRunnerAction');
  expect(form).toContain('重新启用');
});

test('Agent 授权通过后主动刷新连接状态', async () => {
  const connectPage = await readFile(
    join(agentsRoot, 'connect/page.tsx'),
    'utf8',
  );
  const refresh = await readFile(
    join(agentsRoot, 'connect/agent-authorization-refresh.tsx'),
    'utf8',
  ).catch(() => '');
  expect(connectPage).toMatch(
    /<AgentAuthorizationRefresh\s+active=\{approval\?\.state === 'APPROVED'\}\s*\/>/u,
  );
  expect(refresh).toContain('router.refresh()');
});

test('Agent 台账页持续刷新连接状态', async () => {
  const page = await readFile(join(agentsRoot, 'page.tsx'), 'utf8');
  const refresh = await readFile(
    join(agentsRoot, 'agent-status-refresh.tsx'),
    'utf8',
  ).catch(() => '');
  expect(page).toContain('<AgentStatusRefresh />');
  expect(refresh).toContain('setInterval');
  expect(refresh).toContain('router.refresh()');
});
