import type { Database } from 'bun:sqlite';
import { PLATFORM_SCHEMA } from './platform-schema';

/** Rebuild only the CHECK constraint; retain every execution and dependent row. */
export function migrateManualHandoff(database: Database): void {
  const definition = PLATFORM_SCHEMA.slice(
    PLATFORM_SCHEMA.indexOf('CREATE TABLE platform_execution ('),
    PLATFORM_SCHEMA.indexOf('CREATE TABLE platform_execution_attachment ('),
  );
  const split = definition.indexOf('CREATE UNIQUE INDEX');
  database.exec('PRAGMA foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.exec(
        definition
          .slice(0, split)
          .replace(
            'CREATE TABLE platform_execution (',
            'CREATE TABLE platform_execution_new (',
          ),
      );
      database.exec(
        'INSERT INTO platform_execution_new SELECT * FROM platform_execution',
      );
      database.exec('DROP TABLE platform_execution');
      database.exec('ALTER TABLE platform_execution_new RENAME TO platform_execution');
      database.exec(definition.slice(split));
      if (database.query('PRAGMA foreign_key_check').all().length)
        throw new Error('人工接管升级的关联完整性检查失败');
      database.exec('PRAGMA user_version = 28');
    })();
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}
