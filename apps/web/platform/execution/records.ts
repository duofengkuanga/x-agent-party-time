import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  ExecutionInteractionSchema,
  ExecutionSchema,
  type CodexTurn,
  type Execution,
  type ExecutionInteraction,
  type TaskSkillBinding,
} from '@agent-party-time/execution-contract';
export type ExecutionRow = {
  id: string;
  owner_namespace: string;
  owner_kind: string;
  owner_id: string;
  attempt: number;
  previous_execution_id: string | null;
  runner_id: string;
  binding_id: string;
  priority: number;
  approval_policy: Execution['approvalPolicy'];
  state: Execution['state'];
  codex_turn_json: string | null;
  skill_name: string | null;
  skill_bundle_hash: string | null;
  skill_source_revision: string | null;
  workspace_json: string | null;
  session_id: string | null;
  lease_token_hash: string | null;
  lease_expires_at: string | null;
  outcome_json: string | null;
  reported_outcome_json: string | null;
  cancellation_requested: number;
  resume_requested_at: string | null;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
};
export type AttachmentRow = {
  file_id: string;
  original_name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
};
export type InteractionRow = {
  id: string;
  execution_id: string;
  kind: ExecutionInteraction['kind'];
  method: string;
  payload_json: string;
  state: ExecutionInteraction['state'];
  resolution_json: string | null;
  created_at: string;
  resolved_at: string | null;
};
export type FileRow = AttachmentRow & {
  storage_key: string;
};
export class ExecutionRecords {
  constructor(private readonly db: AppDatabase) {}
  get(executionId: string): Execution {
    return this.mapExecution(this.getRow(executionId));
  }

  getRow(executionId: string): ExecutionRow {
    const row = this.db.get(
      'SELECT * FROM platform_execution WHERE id = ?',
      executionId,
    ) as ExecutionRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '处理任务不存在');
    return row;
  }

  mapExecution(row: ExecutionRow): Execution {
    const current = this.getRow(row.id);
    const attachments = this.db
      .all(
        `SELECT file_id, original_name, media_type, size_bytes, sha256
         FROM platform_execution_attachment
         WHERE execution_id = ? ORDER BY position`,
        current.id,
      )
      .map((attachment) => {
        const value = attachment as AttachmentRow;
        return {
          id: value.file_id,
          originalName: value.original_name,
          mediaType: value.media_type,
          sizeBytes: value.size_bytes,
          sha256: value.sha256,
        };
      });
    return ExecutionSchema.parse({
      id: current.id,
      owner: {
        namespace: current.owner_namespace,
        kind: current.owner_kind,
        id: current.owner_id,
      },
      attempt: current.attempt,
      previousExecutionId: current.previous_execution_id,
      runnerId: current.runner_id,
      bindingId: current.binding_id,
      priority: current.priority,
      approvalPolicy: current.approval_policy,
      state: current.state,
      codexTurn: mapCodexTurn(current),
      workspace: current.workspace_json
        ? JSON.parse(current.workspace_json)
        : null,
      attachments,
      sessionId: current.session_id,
      lease: current.lease_expires_at
        ? { expiresAt: current.lease_expires_at }
        : null,
      outcome: current.outcome_json ? JSON.parse(current.outcome_json) : null,
      cancellationRequested: Boolean(current.cancellation_requested),
      createdAt: current.created_at,
      claimedAt: current.claimed_at,
      startedAt: current.started_at,
      finishedAt: current.finished_at,
    });
  }

  findPendingInteraction(executionId: string): InteractionRow | undefined {
    return this.db.get(
      `SELECT * FROM platform_execution_interaction
         WHERE execution_id = ? AND state = 'PENDING'`,
      executionId,
    ) as InteractionRow | undefined;
  }

  latestInteraction(executionId: string): InteractionRow | undefined {
    return this.db.get(
      `SELECT * FROM platform_execution_interaction
         WHERE execution_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      executionId,
    ) as InteractionRow | undefined;
  }

  getInteractionRow(interactionId: string): InteractionRow {
    const row = this.db.get(
      'SELECT * FROM platform_execution_interaction WHERE id = ?',
      interactionId,
    ) as InteractionRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '任务操作请求不存在');
    return row;
  }

  getInteraction(interactionId: string): ExecutionInteraction {
    return mapInteraction(this.getInteractionRow(interactionId));
  }

  invalidatePendingInteractions(executionId: string, resolvedAt: string): void {
    this.db.run(
      `UPDATE platform_execution_interaction
         SET state = 'INVALIDATED', resolved_at = ?
         WHERE execution_id = ? AND state = 'PENDING'`,
      [resolvedAt, executionId],
    );
  }
}
export function mapInteraction(row: InteractionRow): ExecutionInteraction {
  return ExecutionInteractionSchema.parse({
    id: row.id,
    executionId: row.execution_id,
    kind: row.kind,
    method: row.method,
    payload: JSON.parse(row.payload_json),
    state: row.state,
    resolution: row.resolution_json ? JSON.parse(row.resolution_json) : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  });
}
export function mapCodexTurn(row: ExecutionRow): CodexTurn | null {
  if (!row.codex_turn_json) return null;
  const turn = JSON.parse(row.codex_turn_json) as CodexTurn;
  const taskSkillBinding = persistedSkillBinding(row);
  return taskSkillBinding && turn.kind === 'INITIAL'
    ? { ...turn, taskSkillBinding }
    : turn;
}
export function persistedSkillBinding(
  row: ExecutionRow,
): TaskSkillBinding | null {
  if (!row.skill_name || !row.skill_bundle_hash || !row.skill_source_revision)
    return null;
  return {
    skillName: row.skill_name,
    bundleHash: row.skill_bundle_hash,
    sourceRevision: row.skill_source_revision,
  };
}
