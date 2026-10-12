import { expect, test } from 'bun:test';
import { testDatabases } from '@/testing/database';
import { repairFixture, startLatest } from '@/cooking/repair/server/repair-fixture';
import { initializeSchema, SERVER_SCHEMA_VERSION } from './schema';
import { PLATFORM_SCHEMA } from './platform-schema';

const setup = repairFixture(testDatabases());
test('27 升级保留执行、租约、交互及业务关联，并接受新交接状态', async () => {
  const f = await setup();
  const started = await startLatest(f, 'migration-session');
  const questions = ['确认权限范围？'];
  f.executions.openInteraction(f.runner.id, started.executionId, {
    leaseToken: started.leaseToken,
    kind: 'USER_INPUT',
    method: 'xapt/manualHandoff',
    payload: { questions },
  });
  const tables = f.database.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const snapshot = () =>
    tables.map(({ name }) => f.database.all(`SELECT * FROM "${name}" ORDER BY rowid`));
  const before = snapshot();
  // Rebuild the preceding CHECK constraint in this disposable fixture only.
  const definition = PLATFORM_SCHEMA.slice(
    PLATFORM_SCHEMA.indexOf('CREATE TABLE platform_execution ('),
    PLATFORM_SCHEMA.indexOf('CREATE TABLE platform_execution_attachment ('),
  );
  const split = definition.indexOf('CREATE UNIQUE INDEX');
  f.database.exec('PRAGMA foreign_keys=OFF');
  f.database.exec(
    definition
      .slice(0, split)
      .replace('CREATE TABLE platform_execution (', 'CREATE TABLE old_execution (')
      .replace(",\n    'HANDED_OFF'", ''),
  );
  f.database.exec(
    'INSERT INTO old_execution SELECT * FROM platform_execution; DROP TABLE platform_execution; ALTER TABLE old_execution RENAME TO platform_execution;',
  );
  f.database.exec(definition.slice(split));
  f.database.exec('PRAGMA user_version=27; PRAGMA foreign_keys=ON');
  expect(() =>
    f.database.run("UPDATE platform_execution SET state='HANDED_OFF' WHERE id=?", [
      started.executionId,
    ]),
  ).toThrow();
  initializeSchema(f.database);
  initializeSchema(f.database);
  expect(snapshot()).toEqual(before);
  expect(f.database.all('PRAGMA foreign_key_check')).toEqual([]);
  expect(f.database.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
  expect(f.database.get('PRAGMA user_version')).toEqual({
    user_version: SERVER_SCHEMA_VERSION,
  });
  f.executions.complete(f.runner.id, started.executionId, {
    leaseToken: started.leaseToken,
    sessionId: started.sessionId,
    outcome: { kind: 'HANDED_OFF', questions },
  });
  expect(f.executions.get(started.executionId).state).toBe('HANDED_OFF');
});
