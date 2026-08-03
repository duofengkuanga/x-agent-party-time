import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { XAPT_IDENTIFIER, XAPT_LAUNCH_AGENT_LABEL, xaptPaths } from './paths';

test('xapt 路径按生命周期分层且版本入口稳定', () => {
  const home = '/tmp/xapt-test-home';
  const paths = xaptPaths(home);

  expect(paths.commandLink).toBe(join(home, '.local/bin/xapt'));
  expect(paths.currentExecutable).toBe(
    join(home, '.local/share/xapt/current/xapt'),
  );
  expect(paths.versionExecutable('0.2.0')).toBe(
    join(home, '.local/share/xapt/versions/0.2.0/xapt'),
  );
  expect(paths.applicationSupport).toBe(
    join(home, 'Library/Application Support', XAPT_IDENTIFIER),
  );
  expect(paths.outbox).toContain('/Application Support/');
  expect(paths.outbox).not.toContain('/Caches/');
  expect(paths.workspaces).not.toContain('/Caches/');
  expect(paths.controlSocket).toEndWith('/run/control.sock');
  expect(paths.launchAgentPlist).toBe(
    join(home, 'Library/LaunchAgents', `${XAPT_LAUNCH_AGENT_LABEL}.plist`),
  );
  expect(() => paths.versionExecutable('../escape')).toThrow(
    'xapt 版本格式无效',
  );
  expect(() => xaptPaths('relative/home')).toThrow('xapt Home 必须是绝对路径');
});
