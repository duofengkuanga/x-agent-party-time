import type { AppDatabase } from '@/server/database/index';

type AuditEvent = {
  id: string;
  projectId: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: unknown;
  createdAt: string;
};

export function insertAuditEvent(db: AppDatabase, event: AuditEvent): void {
  db.run(
    `INSERT INTO platform_audit_event(
       id, project_id, actor_user_id, action, target_type, target_id,
       details_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.projectId,
      event.actorUserId,
      event.action,
      event.targetType,
      event.targetId,
      JSON.stringify(event.details ?? {}),
      event.createdAt,
    ],
  );
}
