import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { updateFixture } from '@/cooking/update/server/update-fixture';
import { testDatabases } from '@/testing/database';
import { initializeSchema } from '@/platform/database/schema';

const setup = updateFixture(testDatabases());

test('26 升级保留全部旧表记录，为已开始缺陷回填原配置，且可重复打开', async () => {
  const f = await setup();
  const started = f.createBug('迁移中的缺陷');
  const waiting = f.bugs.createBug(f.users.tester.id, f.submission.id, {
    mutationId: randomUUID(),
    submissionItemId: f.item.id,
    title: '尚未开始',
    actualResultAttachmentIds: [],
    expectedResultAttachmentIds: [],
  }).bug;
  f.database.run('UPDATE cooking_environment SET deployment_json = ?', [
    JSON.stringify({ kind: 'CI_CD' }),
  ]);
  // Reconstruct the preceding schema only inside this disposable test database.
  f.database.exec('DROP TABLE cooking_bug_deployment; PRAGMA user_version = 26');
  const tables = f.database.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const before = tables.map(({ name }) =>
    f.database.all(`SELECT * FROM "${name}" ORDER BY rowid`),
  );
  initializeSchema(f.database);
  initializeSchema(f.database);
  expect(
    tables.map(({ name }) => f.database.all(`SELECT * FROM "${name}" ORDER BY rowid`)),
  ).toEqual(before);
  expect(f.database.get('PRAGMA user_version')).toEqual({ user_version: 27 });
  expect(
    f.database.get<{ deployment_json: string }>(
      'SELECT deployment_json FROM cooking_bug_deployment WHERE bug_id = ?',
      started.id,
    )?.deployment_json,
  ).toBe(JSON.stringify({ kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' }));
  expect(
    f.database.get('SELECT * FROM cooking_bug_deployment WHERE bug_id = ?', waiting.id),
  ).toBeNull();
  expect(f.database.all('PRAGMA foreign_key_check')).toEqual([]);
});

test('迁移失败时事务回滚并保留版本与原记录', async () => {
  const f = await setup();
  const bug = f.createBug('迁移失败仍保留');
  f.database.exec('PRAGMA user_version = 26');
  expect(() => initializeSchema(f.database)).toThrow();
  expect(f.database.get('PRAGMA user_version')).toEqual({ user_version: 26 });
  expect(f.database.get('SELECT id FROM cooking_bug WHERE id = ?', bug.id)).toEqual({
    id: bug.id,
  });
});
