import type { AppDatabase } from '@/platform/database';
import type { Bug } from '../contract';

export class BugRelations {
  constructor(private readonly db: AppDatabase) {}

  add(input: {
    id: string;
    source: Bug;
    target: Bug;
    kind: 'JOINT' | 'TRANSFER' | 'COLLABORATION';
    handoffText: string;
    actorUserId: string;
    now: string;
  }): void {
    const { source, target } = input;
    this.db.run(
      `INSERT INTO cooking_bug_relation(
        id, source_bug_id, target_bug_id, kind, source_short_id, target_short_id,
        source_title, target_title, handoff_text, actor_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        source.id,
        target.id,
        input.kind,
        source.shortId,
        target.shortId,
        source.report.title,
        target.report.title,
        input.handoffText,
        input.actorUserId,
        input.now,
      ],
    );
  }

  list(bugId: string) {
    const rows = this.db.all<{
      id: string | null;
      short_id: number;
      title: string;
      kind: 'JOINT' | 'TRANSFER' | 'COLLABORATION';
      stage: Bug['stage'] | null;
      transferred_at: string | null;
      engineering_name: string | null;
      handoff_text: string;
    }>(
      `SELECT other.id, CASE WHEN link.source_bug_id = ? THEN link.target_short_id ELSE link.source_short_id END short_id,
        COALESCE(other.title, CASE WHEN link.source_bug_id = ? THEN link.target_title ELSE link.source_title END) title,
        link.kind, other.stage, other.transferred_at, item.engineering_name, link.handoff_text
       FROM cooking_bug_relation link
       LEFT JOIN cooking_bug other ON other.id = CASE WHEN link.source_bug_id = ? THEN link.target_bug_id ELSE link.source_bug_id END
       LEFT JOIN cooking_submission_item item ON item.id = other.submission_item_id
       WHERE link.source_bug_id = ? OR link.target_bug_id = ? ORDER BY link.created_at, link.id`,
      bugId,
      bugId,
      bugId,
      bugId,
      bugId,
    );
    return rows.map((row) => ({
      id: row.id,
      shortId: row.short_id,
      title: row.title,
      kind: row.kind,
      stageLabel: row.transferred_at
        ? '已关闭（转交）'
        : row.stage
          ? stageLabel(row.stage)
          : '已删除',
      engineeringName: row.engineering_name,
      handoffText: row.handoff_text,
    }));
  }
}

export function stageLabel(stage: Bug['stage']): string {
  return {
    WAITING_FOR_REPAIR: '待修复',
    REPAIRING: '修复中',
    WAITING_FOR_UPDATE: '待更新',
    UPDATING: '更新中',
    WAITING_FOR_VERIFICATION: '待验证',
    DONE: '已完成',
    CANCELLED: '已取消',
  }[stage];
}
