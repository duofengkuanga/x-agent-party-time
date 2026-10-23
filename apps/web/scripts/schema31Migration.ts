import type { Database } from 'bun:sqlite';
import type { ResultRewrite } from './migrateServerResults';

/** Offline-only mapping. Runtime code never reads historical table names. */
export const SCHEMA_31_TABLE_NAMES: Readonly<Record<string, string>> = {
  cooking_project: 'platform_project',
  cooking_project_membership: 'platform_project_membership',
  cooking_project_invitation: 'platform_project_invitation',
  cooking_mutation: 'platform_mutation',
  cooking_audit_event: 'platform_audit_event',
  cooking_engineering: 'platform_engineering',
  cooking_engineering_membership: 'platform_engineering_membership',
  cooking_environment: 'platform_environment',
  cooking_engineering_binding: 'platform_engineering_binding',
  cooking_binding_request: 'platform_binding_request',
  cooking_test_submission: 'test_submission',
  cooking_submission_item: 'submission_item',
  cooking_submission_environment_lock: 'submission_environment_lock',
  cooking_bug: 'submission_bug',
  cooking_bug_relation: 'submission_bug_relation',
  cooking_bug_lifecycle_event: 'submission_bug_lifecycle_event',
  cooking_bug_attachment: 'submission_bug_attachment',
  cooking_bug_repair_context: 'submission_bug_repair_context',
  cooking_repair_attempt: 'submission_repair_attempt',
  cooking_repair_session_sync: 'submission_repair_session_sync',
  cooking_pending_delivery: 'submission_pending_delivery',
  cooking_update_batch: 'submission_update_batch',
  cooking_update_batch_entry: 'submission_update_batch_entry',
  cooking_external_deployment_report: 'submission_external_deployment_report',
  cooking_external_deployment_report_attachment:
    'submission_external_deployment_report_attachment',
  cooking_update_attempt: 'submission_update_attempt',
  cooking_update_session_sync: 'submission_update_session_sync',
  cooking_verification_record: 'submission_verification_record',
  cooking_verification_attachment: 'submission_verification_attachment',
  cooking_reopen_record: 'submission_reopen_record',
  cooking_reopen_attachment: 'submission_reopen_attachment',
  cooking_cleanup: 'submission_cleanup',
  cooking_cleanup_attempt: 'submission_cleanup_attempt',
  cooking_bug_deployment: 'submission_bug_deployment',
};

export function migrateSchema31Names(db: Database, indexes: string[]): ResultRewrite[] {
  // Bun enables legacy ALTER behavior by default; rename foreign-key targets too.
  db.exec('PRAGMA legacy_alter_table=OFF');
  const changes = db
    .query<{ rowid: number }, []>(
      "SELECT rowid FROM platform_execution WHERE owner_namespace = 'cooking'",
    )
    .all()
    .map(({ rowid }) => ({
      table: 'platform_execution',
      rowid,
      column: 'owner_namespace',
      before: 'cooking',
      after: 'submissions',
    }));
  for (const [previous, current] of Object.entries(SCHEMA_31_TABLE_NAMES))
    db.exec(`ALTER TABLE "${previous}" RENAME TO "${current}"`);
  const oldIndexes = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB 'cooking_*' AND sql IS NOT NULL",
    )
    .all();
  for (const { name } of oldIndexes) db.exec(`DROP INDEX "${name}"`);
  for (const sql of indexes) db.exec(sql);
  db.exec(
    "UPDATE platform_execution SET owner_namespace = 'submissions' WHERE owner_namespace = 'cooking'",
  );
  return changes;
}
