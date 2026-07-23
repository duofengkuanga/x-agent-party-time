import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import {
  CollaborativeCommandSchema,
  CollaborativeCommandResultSchema,
  CollaborativeQuerySchema,
  CollaborativeQueryResultSchema,
  ERROR_CODES,
  CodexInteractionRequestSchema,
  SubmissionBugSchema,
  SubmissionCleanupTaskSchema,
  SubmissionRepairTaskSchema,
  SubmissionUpdateBatchSchema,
  TestSubmissionDetailSchema,
  TestSubmissionSummarySchema,
  createAppError,
  type CollaborativeCommand,
  type CollaborativeCommandResult,
  type CollaborativeQuery,
  type CollaborativeQueryResult,
  type ControlPlaneActor,
  type CodexInteractionRequest,
  type SubmissionBug,
  type SubmissionCleanupTask,
  type SubmissionRepairTask,
  type SubmissionUpdateBatch,
  type TestSubmissionDetail,
  type TestSubmissionSummary,
} from '@agent-party-time/shared';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS test_submission (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 title TEXT NOT NULL, requirement_description TEXT NOT NULL, tester_user_id TEXT NOT NULL,
 status TEXT NOT NULL, created_by_user_id TEXT NOT NULL, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, closed_at TEXT);
CREATE INDEX IF NOT EXISTS test_submission_project ON test_submission(project_id,status,created_at,id);
CREATE INDEX IF NOT EXISTS test_submission_tester ON test_submission(tester_user_id,status,created_at,id);
CREATE TABLE IF NOT EXISTS test_submission_item (
 id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES test_submission(id) ON DELETE CASCADE,
 engineering_id TEXT NOT NULL REFERENCES engineering(id), engineering_slug TEXT NOT NULL,
 engineering_display_name TEXT NOT NULL, engineering_type TEXT NOT NULL, repository_url TEXT NOT NULL,
 responsible_developer_user_id TEXT NOT NULL, binding_id TEXT NOT NULL REFERENCES engineering_binding(id),
 runner_id TEXT NOT NULL REFERENCES runner(id), target_branch TEXT NOT NULL,
 environment_id TEXT NOT NULL REFERENCES engineering_environment(id), environment_slug TEXT NOT NULL,
 environment_display_name TEXT NOT NULL, deployment_type TEXT NOT NULL, local_script_command TEXT,
 locked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(submission_id,engineering_id));
CREATE TABLE IF NOT EXISTS test_submission_environment_lock (
 engineering_id TEXT NOT NULL, environment_id TEXT NOT NULL, submission_id TEXT NOT NULL,
 submission_item_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(engineering_id,environment_id));
CREATE TABLE IF NOT EXISTS submission_bug (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 submission_id TEXT NOT NULL REFERENCES test_submission(id) ON DELETE CASCADE,
 submission_item_id TEXT REFERENCES test_submission_item(id), status TEXT NOT NULL,
 title TEXT NOT NULL, operation_path TEXT NOT NULL, actual_result TEXT NOT NULL,
 expected_result TEXT NOT NULL, supplemental_description TEXT, latest_feedback TEXT,
 candidate_commit TEXT, repair_session_id TEXT, created_by_user_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS submission_bug_board ON submission_bug(submission_id,status,sequence);
CREATE TABLE IF NOT EXISTS submission_bug_attachment (
 id TEXT PRIMARY KEY, bug_id TEXT NOT NULL REFERENCES submission_bug(id) ON DELETE CASCADE,
 file_name TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 content_base64 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submission_repair_task (
 id TEXT PRIMARY KEY, bug_id TEXT NOT NULL REFERENCES submission_bug(id),
 submission_item_id TEXT NOT NULL REFERENCES test_submission_item(id), binding_id TEXT NOT NULL,
 runner_id TEXT NOT NULL, state TEXT NOT NULL, position INTEGER NOT NULL,
 lease_token TEXT, lease_expires_at TEXT, resume_session_id TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
CREATE INDEX IF NOT EXISTS submission_repair_queue ON submission_repair_task(binding_id,state,position,created_at,id);
CREATE TABLE IF NOT EXISTS submission_repair_attempt (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES submission_repair_task(id),
 bug_id TEXT NOT NULL REFERENCES submission_bug(id), session_id TEXT, outcome TEXT NOT NULL,
 summary TEXT NOT NULL, candidate_commit TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submission_update_batch (
 id TEXT PRIMARY KEY, submission_item_id TEXT NOT NULL REFERENCES test_submission_item(id),
 binding_id TEXT NOT NULL, runner_id TEXT NOT NULL, state TEXT NOT NULL,
 deployment_type TEXT NOT NULL, eligible_at TEXT NOT NULL, immediate_requested_at TEXT,
 session_id TEXT, lease_token TEXT, lease_expires_at TEXT, external_failure TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
CREATE INDEX IF NOT EXISTS submission_update_queue ON submission_update_batch(binding_id,state,eligible_at,created_at,id);
CREATE TABLE IF NOT EXISTS submission_update_batch_member (
 batch_id TEXT NOT NULL REFERENCES submission_update_batch(id) ON DELETE CASCADE,
 bug_id TEXT NOT NULL REFERENCES submission_bug(id), candidate_commit TEXT NOT NULL,
 PRIMARY KEY(batch_id,bug_id));
CREATE TABLE IF NOT EXISTS submission_update_feedback_attachment (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES submission_update_batch(id) ON DELETE CASCADE,
 file_name TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 content_base64 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submission_cleanup_task (
 id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES test_submission(id),
 submission_item_id TEXT NOT NULL REFERENCES test_submission_item(id), binding_id TEXT NOT NULL,
 runner_id TEXT NOT NULL, state TEXT NOT NULL, session_ids_json TEXT NOT NULL,
 summary TEXT, lease_token TEXT, lease_expires_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(submission_id,submission_item_id));
CREATE INDEX IF NOT EXISTS submission_cleanup_queue ON submission_cleanup_task(runner_id,state,created_at,id);
CREATE TABLE IF NOT EXISTS codex_interaction_request (
 id TEXT PRIMARY KEY, execution_kind TEXT NOT NULL, execution_id TEXT NOT NULL,
 submission_item_id TEXT NOT NULL REFERENCES test_submission_item(id), binding_id TEXT NOT NULL,
 kind TEXT NOT NULL, method TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
 item_id TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
 resolution_json TEXT, created_at TEXT NOT NULL, resolved_at TEXT,
 UNIQUE(thread_id,turn_id,item_id,method));
CREATE INDEX IF NOT EXISTS codex_interaction_pending ON codex_interaction_request(submission_item_id,state,created_at,id);
CREATE TABLE IF NOT EXISTS submission_event (
 id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, bug_id TEXT, event_type TEXT NOT NULL,
 actor_user_id TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
`;

const USERS = new Map([
  [
    'user-xujiequan',
    {
      id: 'user-xujiequan',
      username: 'xujiequan',
      displayName: '徐捷泉',
      accountType: 'DEVELOPER' as const,
    },
  ],
  [
    'user-zhoumingbo',
    {
      id: 'user-zhoumingbo',
      username: 'zhoumingbo',
      displayName: '周明波',
      accountType: 'DEVELOPER' as const,
    },
  ],
  [
    'user-tianguohui',
    {
      id: 'user-tianguohui',
      username: 'tianguohui',
      displayName: '田国会',
      accountType: 'TESTER' as const,
    },
  ],
]);

type Row = Record<string, string | number | null>;

export interface CollaborativeSubmissionStoreOptions {
  now: () => Date;
  runnerOfflineAfterMs: number;
  automaticUpdateDelayMs?: number;
  repairInfrastructureRetries?: number;
}

/**
 * Deep workflow module for CTS-005..CTS-011. Callers only need one command
 * interface and one query interface; ordering, authorization and state-machine
 * invariants remain local to this implementation.
 */
export class CollaborativeSubmissionStore {
  readonly #automaticUpdateDelayMs: number;
  readonly #repairInfrastructureRetries: number;

  constructor(
    private readonly database: Database,
    private readonly options: CollaborativeSubmissionStoreOptions,
  ) {
    this.#automaticUpdateDelayMs = options.automaticUpdateDelayMs ?? 120_000;
    this.#repairInfrastructureRetries =
      options.repairInfrastructureRetries ?? 2;
    database.exec(SCHEMA);
  }

  command(
    raw: CollaborativeCommand,
    actor: ControlPlaneActor,
  ): CollaborativeCommandResult {
    const command = CollaborativeCommandSchema.parse(raw);
    const result = this.executeCommand(command, actor);
    return CollaborativeCommandResultSchema.parse(result);
  }

  query(
    raw: CollaborativeQuery,
    actor: ControlPlaneActor,
  ): CollaborativeQueryResult {
    const query = CollaborativeQuerySchema.parse(raw);
    const result = this.executeQuery(query, actor);
    return CollaborativeQueryResultSchema.parse(result);
  }

  private executeCommand(
    command: CollaborativeCommand,
    actor: ControlPlaneActor,
  ): CollaborativeCommandResult {
    switch (command.kind) {
      case 'submission.create':
        return {
          kind: command.kind,
          submission: this.createSubmission(command, actor),
        };
      case 'submission.item.update':
        return {
          kind: command.kind,
          submission: this.updateSubmissionItem(command, actor),
        };
      case 'bug.create':
        return { kind: command.kind, bug: this.createBug(command, actor) };
      case 'bug.triage':
        return { kind: command.kind, bug: this.triageBug(command, actor) };
      case 'bug.move':
        return { kind: command.kind, bug: this.moveBug(command, actor) };
      case 'repair_queue.reorder':
        return {
          kind: command.kind,
          repairTask: this.reorderQueue(command, actor),
        };
      case 'repair_task.claim':
        return {
          kind: command.kind,
          repairTask: this.claimRepairTask(command, actor),
        };
      case 'repair_task.renew':
        return {
          kind: command.kind,
          repairTask: this.renewRepairTask(command, actor),
        };
      case 'repair_task.finish':
        return {
          kind: command.kind,
          bug: this.finishRepairTask(command, actor),
        };
      case 'update.trigger':
        return {
          kind: command.kind,
          updateBatch: this.triggerUpdate(command, actor),
        };
      case 'update.continue':
        return {
          kind: command.kind,
          updateBatch: this.continueUpdate(command, actor),
        };
      case 'interaction.open':
        return {
          kind: command.kind,
          interaction: this.openInteraction(command, actor),
        };
      case 'interaction.resolve':
        return {
          kind: command.kind,
          interaction: this.resolveInteraction(command, actor),
        };
      case 'interaction.invalidate':
        return {
          kind: command.kind,
          interaction: this.invalidateInteraction(command, actor),
        };
      case 'update_task.claim':
        return {
          kind: command.kind,
          updateBatch: this.claimUpdateTask(command, actor),
        };
      case 'update_task.renew':
        return {
          kind: command.kind,
          updateBatch: this.renewUpdateTask(command, actor),
        };
      case 'update_task.finish':
        return {
          kind: command.kind,
          updateBatch: this.finishUpdateTask(command, actor),
        };
      case 'update.external_failure':
        return {
          kind: command.kind,
          updateBatch: this.reportExternalFailure(command, actor),
        };
      case 'update.external_confirm':
        return {
          kind: command.kind,
          updateBatch: this.confirmExternalUpdate(command, actor),
        };
      case 'submission.close':
        return {
          kind: command.kind,
          submission: this.closeSubmission(command, actor),
        };
      case 'cleanup_task.claim':
        return {
          kind: command.kind,
          cleanupTask: this.claimCleanupTask(command, actor),
        };
      case 'cleanup_task.renew':
        return {
          kind: command.kind,
          cleanupTask: this.renewCleanupTask(command, actor),
        };
      case 'cleanup_task.finish':
        return {
          kind: command.kind,
          cleanupTask: this.finishCleanupTask(command, actor),
        };
    }
  }

  private executeQuery(
    query: CollaborativeQuery,
    actor: ControlPlaneActor,
  ): CollaborativeQueryResult {
    switch (query.kind) {
      case 'submission.list':
        return {
          kind: query.kind,
          submissions: this.listSubmissions(
            query.projectId,
            query.includeClosed,
            actor,
          ),
        };
      case 'submission.get':
        return {
          kind: query.kind,
          submission: this.submissionDetail(query.submissionId, actor),
        };
      case 'bug.board':
        this.requireSubmissionAccess(query.submissionId, actor);
        return {
          kind: query.kind,
          bugs: this.listBugs(query.submissionId, actor),
        };
      case 'bug.get':
        return { kind: query.kind, bug: this.bugDetail(query.bugId, actor) };
      case 'bug.attachment.get':
        return {
          kind: query.kind,
          ...this.getAttachment(query.attachmentId, actor),
        };
      case 'repair_queue.get':
        this.requireItemDeveloper(query.submissionItemId, actor, true);
        return {
          kind: query.kind,
          repairTasks: this.repairQueue(query.submissionItemId),
        };
      case 'update_batches.list':
        this.requireItemAccess(query.submissionItemId, actor);
        return {
          kind: query.kind,
          updateBatches: this.updateBatches(query.submissionItemId, actor),
        };
      case 'cleanup_tasks.list':
        this.requireRunnerActor(actor);
        return {
          kind: query.kind,
          cleanupTasks: this.cleanupTasks(query.runnerId),
        };
      case 'interaction.get': {
        const interaction = this.interaction(query.interactionId);
        this.requireItemAccess(interaction.submissionItemId, actor);
        return { kind: query.kind, interaction };
      }
      case 'interactions.list':
        this.requireItemAccess(query.submissionItemId, actor);
        return {
          kind: query.kind,
          interactions: this.interactions(
            query.submissionItemId,
            query.pendingOnly,
          ),
        };
    }
  }

  private createSubmission(
    command: Extract<CollaborativeCommand, { kind: 'submission.create' }>,
    actor: ControlPlaneActor,
  ) {
    const creator = this.requireDeveloper(actor);
    this.requireProjectMember(command.projectId, creator);
    const tester = this.user(command.testerUserId);
    if (tester.accountType !== 'TESTER')
      throw this.validation('提测单只能指定已注册测试人员');
    if (
      new Set(command.items.map((item) => item.engineeringId)).size !==
      command.items.length
    )
      throw this.validation('一张提测单不能重复选择同一工程');
    const id = randomUUID();
    const now = this.iso();
    this.database.transaction(() => {
      this.database
        .query(
          `INSERT INTO test_submission(id,project_id,title,requirement_description,tester_user_id,status,created_by_user_id,created_at,updated_at,closed_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?,NULL)`,
        )
        .run(
          id,
          command.projectId,
          command.title,
          command.requirementDescription,
          tester.id,
          creator,
          now,
          now,
        );
      for (const input of command.items) {
        const snapshot = this.validateItemInput(command.projectId, input);
        const itemId = randomUUID();
        try {
          this.database
            .query(
              `INSERT INTO test_submission_environment_lock(engineering_id,environment_id,submission_id,submission_item_id,created_at) VALUES(?,?,?,?,?)`,
            )
            .run(
              snapshot.engineering_id,
              snapshot.environment_id,
              id,
              itemId,
              now,
            );
        } catch (error) {
          if (String(error).includes('UNIQUE constraint failed'))
            throw this.conflict(
              `工程 ${snapshot.engineering_display_name} 的 ${snapshot.environment_display_name} 环境已有进行中的提测单`,
            );
          throw error;
        }
        this.database
          .query(
            `INSERT INTO test_submission_item(id,submission_id,engineering_id,engineering_slug,engineering_display_name,engineering_type,repository_url,responsible_developer_user_id,binding_id,runner_id,target_branch,environment_id,environment_slug,environment_display_name,deployment_type,local_script_command,locked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
          )
          .run(
            itemId,
            id,
            snapshot.engineering_id,
            snapshot.engineering_slug,
            snapshot.engineering_display_name,
            snapshot.engineering_type,
            snapshot.repository_url,
            input.responsibleDeveloperUserId,
            input.bindingId,
            snapshot.runner_id,
            input.targetBranch,
            snapshot.environment_id,
            snapshot.environment_slug,
            snapshot.environment_display_name,
            snapshot.deployment_type,
            snapshot.local_script_command,
            now,
            now,
          );
      }
      this.event(id, null, 'submission.created', creator, now);
    })();
    return this.submissionDetail(id, actor);
  }

  private updateSubmissionItem(
    command: Extract<CollaborativeCommand, { kind: 'submission.item.update' }>,
    actor: ControlPlaneActor,
  ) {
    const item = this.itemRow(command.submissionItemId);
    const developer = this.requireDeveloper(actor);
    this.requireProjectMember(String(item.project_id), developer);
    this.requireSubmissionActive(String(item.submission_id));
    if (
      item.locked_at ||
      this.count(
        'SELECT COUNT(*) count FROM submission_bug WHERE submission_id=?',
        item.submission_id,
      ) > 0
    )
      throw this.conflict('首个 Bug 已创建，提测项技术配置已锁定');
    const snapshot = this.validateItemInput(String(item.project_id), {
      engineeringId: String(item.engineering_id),
      responsibleDeveloperUserId: command.responsibleDeveloperUserId,
      bindingId: command.bindingId,
      targetBranch: command.targetBranch,
      environmentId: command.environmentId,
    });
    const now = this.iso();
    this.database.transaction(() => {
      this.database
        .query(
          'DELETE FROM test_submission_environment_lock WHERE submission_item_id=?',
        )
        .run(command.submissionItemId);
      try {
        this.database
          .query(
            'INSERT INTO test_submission_environment_lock(engineering_id,environment_id,submission_id,submission_item_id,created_at) VALUES(?,?,?,?,?)',
          )
          .run(
            snapshot.engineering_id,
            snapshot.environment_id,
            item.submission_id,
            command.submissionItemId,
            now,
          );
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed'))
          throw this.conflict('所选工程环境已有进行中的提测单');
        throw error;
      }
      this.database
        .query(
          `UPDATE test_submission_item SET responsible_developer_user_id=?,binding_id=?,runner_id=?,target_branch=?,environment_id=?,environment_slug=?,environment_display_name=?,deployment_type=?,local_script_command=?,updated_at=? WHERE id=?`,
        )
        .run(
          command.responsibleDeveloperUserId,
          command.bindingId,
          snapshot.runner_id,
          command.targetBranch,
          snapshot.environment_id,
          snapshot.environment_slug,
          snapshot.environment_display_name,
          snapshot.deployment_type,
          snapshot.local_script_command,
          now,
          command.submissionItemId,
        );
      this.database
        .query('UPDATE test_submission SET updated_at=? WHERE id=?')
        .run(now, item.submission_id);
      this.event(
        String(item.submission_id),
        null,
        'submission.item_updated',
        developer,
        now,
      );
    })();
    return this.submissionDetail(String(item.submission_id), actor);
  }

  private createBug(
    command: Extract<CollaborativeCommand, { kind: 'bug.create' }>,
    actor: ControlPlaneActor,
  ) {
    const tester = this.requireTesterForSubmission(command.submissionId, actor);
    this.requireSubmissionActive(command.submissionId);
    if (command.submissionItemId)
      this.requireItemBelongsToSubmission(
        command.submissionItemId,
        command.submissionId,
      );
    const id = randomUUID();
    const now = this.iso();
    this.database.transaction(() => {
      this.database
        .query(
          `INSERT INTO submission_bug(id,submission_id,submission_item_id,status,title,operation_path,actual_result,expected_result,supplemental_description,latest_feedback,candidate_commit,repair_session_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,'WAITING_FOR_REPAIR',?,?,?,?,?,NULL,NULL,NULL,?,?,?)`,
        )
        .run(
          id,
          command.submissionId,
          command.submissionItemId,
          command.title,
          command.operationPath,
          command.actualResult,
          command.expectedResult,
          command.supplementalDescription ?? null,
          tester,
          now,
          now,
        );
      for (const attachment of command.attachments)
        this.database
          .query(
            'INSERT INTO submission_bug_attachment(id,bug_id,file_name,media_type,size_bytes,content_base64,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            id,
            attachment.fileName,
            attachment.mediaType,
            attachment.sizeBytes,
            attachment.contentBase64,
            now,
          );
      this.database
        .query(
          'UPDATE test_submission_item SET locked_at=COALESCE(locked_at,?),updated_at=? WHERE submission_id=?',
        )
        .run(now, now, command.submissionId);
      this.database
        .query('UPDATE test_submission SET updated_at=? WHERE id=?')
        .run(now, command.submissionId);
      this.event(command.submissionId, id, 'bug.created', tester, now);
    })();
    return this.bugDetail(id, actor);
  }

  private triageBug(
    command: Extract<CollaborativeCommand, { kind: 'bug.triage' }>,
    actor: ControlPlaneActor,
  ) {
    const bug = this.bugRow(command.bugId);
    const developer = this.requireDeveloper(actor);
    this.requireProjectMember(String(bug.project_id), developer);
    if (bug.status !== 'WAITING_FOR_REPAIR')
      throw this.invalidTransition('只有待修复 Bug 可以改派工程');
    this.requireItemBelongsToSubmission(
      command.submissionItemId,
      String(bug.submission_id),
    );
    const now = this.iso();
    this.database
      .query(
        'UPDATE submission_bug SET submission_item_id=?,repair_session_id=NULL,updated_at=? WHERE id=?',
      )
      .run(command.submissionItemId, now, command.bugId);
    this.event(
      String(bug.submission_id),
      command.bugId,
      'bug.triaged',
      developer,
      now,
    );
    return this.bugDetail(command.bugId, actor);
  }

  private moveBug(
    command: Extract<CollaborativeCommand, { kind: 'bug.move' }>,
    actor: ControlPlaneActor,
  ) {
    const bug = this.bugRow(command.bugId);
    this.requireSubmissionActive(String(bug.submission_id));
    const source = String(bug.status);
    const target = command.targetStatus;
    if (target === source) return this.bugDetail(command.bugId, actor);
    if (target === 'REPAIRING') {
      this.requireSubmissionAccess(String(bug.submission_id), actor);
      if (!bug.submission_item_id)
        throw this.invalidTransition('暂不确定工程的 Bug 必须先完成分诊');
      if (
        !['WAITING_FOR_REPAIR', 'WAITING_FOR_VERIFICATION', 'DONE'].includes(
          source,
        )
      )
        throw this.invalidTransition('当前状态不能进入修复中');
      if (source !== 'WAITING_FOR_REPAIR' && !command.feedback)
        throw this.validation('验证失败或重新打开必须填写反馈');
      this.enqueueRepair(
        command.bugId,
        String(bug.submission_item_id),
        command.insertAtFront || source !== 'WAITING_FOR_REPAIR',
        command.feedback ?? null,
        actor,
      );
    } else if (target === 'WAITING_FOR_REPAIR') {
      this.requireSubmissionAccess(String(bug.submission_id), actor);
      if (source === 'REPAIRING') {
        const running = this.database
          .query<Row, [string]>(
            `SELECT id FROM submission_repair_task WHERE bug_id=? AND state='RUNNING'`,
          )
          .get(command.bugId);
        if (running) throw this.invalidTransition('正在修复的 Bug 不能撤回');
        this.database
          .query(
            `UPDATE submission_repair_task SET state='WITHDRAWN',completed_at=? WHERE bug_id=? AND state='QUEUED'`,
          )
          .run(this.iso(), command.bugId);
      } else if (['WAITING_FOR_VERIFICATION', 'DONE'].includes(source)) {
        this.requireTesterForSubmission(String(bug.submission_id), actor);
        if (!command.feedback)
          throw this.validation('验证失败或重新打开必须填写反馈');
      } else throw this.invalidTransition('当前状态不能回到待修复');
      const now = this.iso();
      this.database
        .query(
          `UPDATE submission_bug SET status='WAITING_FOR_REPAIR',latest_feedback=?,candidate_commit=NULL,updated_at=? WHERE id=?`,
        )
        .run(command.feedback ?? bug.latest_feedback, now, command.bugId);
      this.event(
        String(bug.submission_id),
        command.bugId,
        'bug.returned_to_waiting',
        this.actorId(actor),
        now,
      );
    } else if (target === 'DONE') {
      this.requireTesterForSubmission(String(bug.submission_id), actor);
      if (source !== 'WAITING_FOR_VERIFICATION')
        throw this.invalidTransition('只有待验证 Bug 可以直接完成');
      const now = this.iso();
      this.database
        .query(
          `UPDATE submission_bug SET status='DONE',updated_at=? WHERE id=?`,
        )
        .run(now, command.bugId);
      this.event(
        String(bug.submission_id),
        command.bugId,
        'bug.verified',
        this.actorId(actor),
        now,
      );
    } else {
      throw this.invalidTransition('该状态只能由 Runner 或更新批次推进');
    }
    return this.bugDetail(command.bugId, actor);
  }

  private reorderQueue(
    command: Extract<CollaborativeCommand, { kind: 'repair_queue.reorder' }>,
    actor: ControlPlaneActor,
  ) {
    const item = this.itemRow(command.submissionItemId);
    this.requireSubmissionAccess(String(item.submission_id), actor);
    const tasks = this.database
      .query<Row, [string]>(
        `SELECT id,bug_id,state FROM submission_repair_task WHERE submission_item_id=? AND state IN ('QUEUED','RUNNING') ORDER BY position,created_at,id`,
      )
      .all(command.submissionItemId);
    const running = tasks.find((task) => task.state === 'RUNNING');
    const queuedIds = tasks
      .filter((task) => task.state === 'QUEUED')
      .map((task) => String(task.bug_id));
    if (
      command.bugIds.length !== queuedIds.length ||
      new Set(command.bugIds).size !== command.bugIds.length ||
      command.bugIds.some((id) => !queuedIds.includes(id))
    )
      throw this.validation(
        '重排列表必须完整包含当前所有排队 Bug，且不能包含运行中 Bug',
      );
    this.database.transaction(() => {
      command.bugIds.forEach((bugId, index) =>
        this.database
          .query(
            `UPDATE submission_repair_task SET position=? WHERE bug_id=? AND state='QUEUED'`,
          )
          .run(index + (running ? 1 : 0), bugId),
      );
    })();
    return tasks.length ? this.repairTask(String(tasks[0]!.id)) : null;
  }

  private claimRepairTask(
    command: Extract<CollaborativeCommand, { kind: 'repair_task.claim' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireRunnerActor(actor);
    if (!this.runnerOnline(command.runnerId)) return null;
    const now = this.iso();
    const expires = new Date(
      this.options.now().getTime() + command.leaseDurationMs,
    ).toISOString();
    const expired = this.database
      .query<Row, [string, string]>(
        `SELECT * FROM submission_repair_task
         WHERE runner_id=? AND state='RUNNING' AND lease_expires_at<=?
         ORDER BY started_at,created_at,id LIMIT 1`,
      )
      .get(command.runnerId, now);
    if (expired) {
      const token = randomUUID();
      this.database
        .query(
          `UPDATE submission_repair_task
           SET lease_token=?,lease_expires_at=?
           WHERE id=? AND state='RUNNING' AND lease_expires_at<=?`,
        )
        .run(token, expires, expired.id, now);
      return this.repairTask(String(expired.id));
    }
    const task = this.database
      .query<Row, [string, string]>(
        `SELECT t.* FROM submission_repair_task t
         WHERE t.runner_id=? AND t.state='QUEUED'
           AND NOT EXISTS (
             SELECT 1 FROM submission_repair_task active
             WHERE active.binding_id=t.binding_id AND active.state='RUNNING'
               AND NOT EXISTS (
                 SELECT 1 FROM codex_interaction_request interaction
                 WHERE interaction.execution_kind='REPAIR'
                   AND interaction.execution_id=active.id
                   AND interaction.state='PENDING'
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM submission_update_batch u
             WHERE u.binding_id=t.binding_id AND u.state='RUNNING'
               AND NOT EXISTS (
                 SELECT 1 FROM codex_interaction_request interaction
                 WHERE interaction.execution_kind='UPDATE'
                   AND interaction.execution_id=u.id
                   AND interaction.state='PENDING'
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM submission_update_batch priority
             WHERE priority.binding_id=t.binding_id
               AND priority.state='QUEUED'
               AND priority.immediate_requested_at IS NOT NULL
               AND priority.eligible_at<=?
           )
         ORDER BY t.position,t.created_at,t.id LIMIT 1`,
      )
      .get(command.runnerId, now);
    if (!task) return null;
    const token = randomUUID();
    this.database.transaction(() => {
      this.database
        .query(
          `UPDATE submission_repair_task
           SET state='RUNNING',lease_token=?,lease_expires_at=?,started_at=COALESCE(started_at,?)
           WHERE id=? AND state='QUEUED'`,
        )
        .run(token, expires, now, task.id);
      this.database
        .query(
          `UPDATE submission_bug SET status='REPAIRING',updated_at=? WHERE id=?`,
        )
        .run(now, task.bug_id);
    })();
    return this.repairTask(String(task.id));
  }

  private renewRepairTask(
    command: Extract<CollaborativeCommand, { kind: 'repair_task.renew' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireRunnerActor(actor);
    const task = this.taskRow(command.taskId);
    if (
      task.runner_id !== command.runnerId ||
      task.lease_token !== command.leaseToken
    )
      throw this.permission('修复任务租约不匹配');
    if (task.state !== 'RUNNING')
      throw this.invalidTransition('修复任务不在运行中');
    const expires = new Date(
      this.options.now().getTime() + command.leaseDurationMs,
    ).toISOString();
    this.database
      .query('UPDATE submission_repair_task SET lease_expires_at=? WHERE id=?')
      .run(expires, command.taskId);
    return this.repairTask(command.taskId);
  }

  private finishRepairTask(
    command: Extract<CollaborativeCommand, { kind: 'repair_task.finish' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireRunnerActor(actor);
    const task = this.taskRow(command.taskId);
    if (task.runner_id !== command.runnerId)
      throw this.permission('修复任务不属于当前 Runner');
    if (task.state === 'COMPLETED' || task.state === 'FAILED')
      return this.bugDetail(String(task.bug_id), actor);
    if (
      task.state === 'QUEUED' &&
      this.count(
        `SELECT COUNT(*) count FROM submission_repair_attempt
         WHERE task_id=? AND outcome=? AND summary=?
           AND COALESCE(session_id,'')=COALESCE(?,'')
           AND COALESCE(candidate_commit,'')=COALESCE(?,'')`,
        command.taskId,
        command.outcome,
        command.summary,
        command.sessionId,
        command.candidateCommit,
      ) > 0
    )
      return this.bugDetail(String(task.bug_id), actor);
    if (task.lease_token !== command.leaseToken)
      throw this.permission('修复任务租约不匹配');
    if (task.state !== 'RUNNING')
      throw this.invalidTransition('修复任务不在运行中');
    const now = this.iso();
    this.database.transaction(() => {
      this.database
        .query(
          'INSERT INTO submission_repair_attempt(id,task_id,bug_id,session_id,outcome,summary,candidate_commit,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          command.taskId,
          task.bug_id,
          command.sessionId,
          command.outcome,
          command.summary,
          command.candidateCommit,
          now,
        );
      if (
        command.outcome === 'INFRASTRUCTURE_ERROR' &&
        Number(task.retry_count) < this.#repairInfrastructureRetries
      ) {
        this.database
          .query(
            `UPDATE submission_repair_task
             SET state='QUEUED',lease_token=NULL,lease_expires_at=NULL,
                 resume_session_id=?,retry_count=retry_count+1,position=0
             WHERE id=?`,
          )
          .run(command.sessionId, command.taskId);
        this.database
          .query(
            `UPDATE submission_bug
             SET status='REPAIRING',repair_session_id=?,latest_feedback=?,updated_at=?
             WHERE id=?`,
          )
          .run(command.sessionId, command.summary, now, task.bug_id);
      } else if (command.outcome === 'READY') {
        if (!command.candidateCommit)
          throw this.validation('修复成功必须返回候选提交');
        this.database
          .query(
            `UPDATE submission_repair_task
             SET state='COMPLETED',resume_session_id=?,completed_at=?,
                 lease_token=NULL,lease_expires_at=NULL WHERE id=?`,
          )
          .run(command.sessionId, now, command.taskId);
        this.database
          .query(
            `UPDATE submission_bug
             SET status='WAITING_FOR_UPDATE',candidate_commit=?,repair_session_id=?,
                 latest_feedback=NULL,updated_at=? WHERE id=?`,
          )
          .run(command.candidateCommit, command.sessionId, now, task.bug_id);
      } else {
        this.database
          .query(
            `UPDATE submission_repair_task
             SET state='FAILED',resume_session_id=?,completed_at=?,
                 lease_token=NULL,lease_expires_at=NULL WHERE id=?`,
          )
          .run(command.sessionId, now, command.taskId);
        this.database
          .query(
            `UPDATE submission_bug
             SET status='WAITING_FOR_REPAIR',repair_session_id=?,latest_feedback=?,updated_at=?
             WHERE id=?`,
          )
          .run(command.sessionId, command.summary, now, task.bug_id);
      }
    })();
    return this.bugDetail(String(task.bug_id), actor);
  }

  private triggerUpdate(
    command: Extract<CollaborativeCommand, { kind: 'update.trigger' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireResponsibleDeveloper(command.submissionItemId, actor);
    const now = this.iso();
    const batch = this.freezeUpdateBatch(command.submissionItemId, now, true);
    if (!batch) return null;
    return this.updateBatch(String(batch.id), actor);
  }

  private continueUpdate(
    command: Extract<CollaborativeCommand, { kind: 'update.continue' }>,
    actor: ControlPlaneActor,
  ) {
    const batch = this.updateBatchRow(command.batchId);
    this.requireResponsibleDeveloper(String(batch.submission_item_id), actor);
    if (batch.state !== 'FAILED')
      throw this.invalidTransition('只有失败的更新批次可以继续处理');
    const now = this.iso();
    this.database
      .query(
        `UPDATE submission_update_batch
         SET state='QUEUED',eligible_at=?,external_failure=?,updated_at=?
         WHERE id=?`,
      )
      .run(now, command.feedback, now, command.batchId);
    return this.updateBatch(command.batchId, actor);
  }

  private openInteraction(
    command: Extract<CollaborativeCommand, { kind: 'interaction.open' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireRunnerActor(actor);
    this.requireExecutionIdentity(
      command.executionKind,
      command.executionId,
      command.submissionItemId,
      command.bindingId,
    );
    const existing = this.database
      .query<Row, [string, string, string, string]>(
        `SELECT id FROM codex_interaction_request
         WHERE thread_id=? AND turn_id=? AND item_id=? AND method=?`,
      )
      .get(command.threadId, command.turnId, command.itemId, command.method);
    if (existing) return this.interaction(String(existing.id));
    const id = randomUUID();
    const now = this.iso();
    this.database
      .query(
        `INSERT INTO codex_interaction_request(
          id,execution_kind,execution_id,submission_item_id,binding_id,kind,method,
          thread_id,turn_id,item_id,payload_json,state,resolution_json,created_at,resolved_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'PENDING',NULL,?,NULL)`,
      )
      .run(
        id,
        command.executionKind,
        command.executionId,
        command.submissionItemId,
        command.bindingId,
        command.interactionKind,
        command.method,
        command.threadId,
        command.turnId,
        command.itemId,
        JSON.stringify(command.payload),
        now,
      );
    return this.interaction(id);
  }

  private resolveInteraction(
    command: Extract<CollaborativeCommand, { kind: 'interaction.resolve' }>,
    actor: ControlPlaneActor,
  ) {
    const interaction = this.interaction(command.interactionId);
    this.requireResponsibleDeveloper(interaction.submissionItemId, actor);
    if (interaction.state !== 'PENDING') return interaction;
    if (interaction.kind === 'USER_INPUT' && command.action !== 'ANSWER')
      throw this.validation('用户输入请求必须提交答案');
    if (interaction.kind === 'PERMISSION' && command.action === 'ANSWER')
      throw this.validation('权限请求不能提交文本答案');
    const resolution = {
      action: command.action,
      ...(command.answers ? { answers: command.answers } : {}),
    };
    const now = this.iso();
    this.database
      .query(
        `UPDATE codex_interaction_request
         SET state='RESOLVED',resolution_json=?,resolved_at=?
         WHERE id=? AND state='PENDING'`,
      )
      .run(JSON.stringify(resolution), now, command.interactionId);
    return this.interaction(command.interactionId);
  }

  private invalidateInteraction(
    command: Extract<CollaborativeCommand, { kind: 'interaction.invalidate' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireRunnerActor(actor);
    const row = this.database
      .query<Row, [string, string]>(
        `SELECT id FROM codex_interaction_request
         WHERE execution_kind=? AND execution_id=? AND state='PENDING'
         ORDER BY created_at,id LIMIT 1`,
      )
      .get(command.executionKind, command.executionId);
    if (!row) return null;
    this.database
      .query(
        `UPDATE codex_interaction_request
         SET state='INVALIDATED',resolved_at=? WHERE id=?`,
      )
      .run(this.iso(), row.id);
    return this.interaction(String(row.id));
  }

  private claimUpdateTask(
    command: Extract<CollaborativeCommand, { kind: 'update_task.claim' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireRunnerActor(actor);
    if (!this.runnerOnline(command.runnerId)) return null;
    const now = this.iso();
    this.freezeEligibleUpdateBatches(command.runnerId, now);
    const expires = new Date(
      this.options.now().getTime() + command.leaseDurationMs,
    ).toISOString();
    const expired = this.database
      .query<Row, [string, string]>(
        `SELECT * FROM submission_update_batch
         WHERE runner_id=? AND state='RUNNING' AND lease_expires_at<=?
         ORDER BY updated_at,created_at,id LIMIT 1`,
      )
      .get(command.runnerId, now);
    if (expired) {
      const token = randomUUID();
      this.database
        .query(
          `UPDATE submission_update_batch SET lease_token=?,lease_expires_at=?,updated_at=?
           WHERE id=? AND state='RUNNING' AND lease_expires_at<=?`,
        )
        .run(token, expires, now, expired.id, now);
      return this.updateBatch(String(expired.id), actor);
    }
    const batch = this.database
      .query<Row, [string, string]>(
        `SELECT u.* FROM submission_update_batch u
         WHERE u.runner_id=? AND u.state='QUEUED' AND u.eligible_at<=?
           AND NOT EXISTS (
             SELECT 1 FROM submission_repair_task running
             WHERE running.binding_id=u.binding_id AND running.state='RUNNING'
               AND NOT EXISTS (
                 SELECT 1 FROM codex_interaction_request interaction
                 WHERE interaction.execution_kind='REPAIR'
                   AND interaction.execution_id=running.id
                   AND interaction.state='PENDING'
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM submission_update_batch active
             WHERE active.binding_id=u.binding_id
               AND active.id<>u.id
               AND active.state IN ('RUNNING','WAITING_EXTERNAL','FAILED')
           )
         ORDER BY u.eligible_at,u.created_at,u.id LIMIT 1`,
      )
      .get(command.runnerId, now);
    if (!batch) return null;
    const token = randomUUID();
    this.database
      .query(
        `UPDATE submission_update_batch
         SET state='RUNNING',lease_token=?,lease_expires_at=?,updated_at=?
         WHERE id=? AND state='QUEUED'`,
      )
      .run(token, expires, now, batch.id);
    return this.updateBatch(String(batch.id), actor);
  }

  private renewUpdateTask(
    command: Extract<CollaborativeCommand, { kind: 'update_task.renew' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireRunnerActor(actor);
    const batch = this.updateBatchRow(command.batchId);
    if (
      batch.runner_id !== command.runnerId ||
      batch.lease_token !== command.leaseToken
    )
      throw this.permission('更新任务租约不匹配');
    if (batch.state !== 'RUNNING')
      throw this.invalidTransition('更新任务不在运行中');
    const now = this.iso();
    const expires = new Date(
      this.options.now().getTime() + command.leaseDurationMs,
    ).toISOString();
    this.database
      .query(
        'UPDATE submission_update_batch SET lease_expires_at=?,updated_at=? WHERE id=?',
      )
      .run(expires, now, command.batchId);
    return this.updateBatch(command.batchId, actor);
  }

  private finishUpdateTask(
    command: Extract<CollaborativeCommand, { kind: 'update_task.finish' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireRunnerActor(actor);
    const batch = this.updateBatchRow(command.batchId);
    if (batch.runner_id !== command.runnerId)
      throw this.permission('更新任务不属于当前 Runner');
    if (batch.state === 'COMPLETED' || batch.state === 'WAITING_EXTERNAL')
      return this.updateBatch(command.batchId, actor);
    if (
      batch.state === 'QUEUED' &&
      batch.session_id === command.sessionId &&
      batch.external_failure === command.summary
    )
      return this.updateBatch(command.batchId, actor);
    if (batch.lease_token !== command.leaseToken)
      throw this.permission('更新任务租约不匹配');
    if (batch.state !== 'RUNNING')
      throw this.invalidTransition('更新任务不在运行中');
    const now = this.iso();
    if (command.outcome === 'FAILED') {
      this.database
        .query(
          `UPDATE submission_update_batch
           SET state='FAILED',session_id=?,external_failure=?,
               lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`,
        )
        .run(command.sessionId, command.summary, now, command.batchId);
    } else if (
      batch.deployment_type === 'CI_CD' ||
      command.outcome === 'PUSHED'
    ) {
      this.database
        .query(
          `UPDATE submission_update_batch
           SET state='WAITING_EXTERNAL',session_id=?,external_failure=NULL,
               lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`,
        )
        .run(command.sessionId, now, command.batchId);
    } else {
      this.completeBatch(command.batchId, command.sessionId, now);
    }
    return this.updateBatch(command.batchId, actor);
  }

  private reportExternalFailure(
    command: Extract<CollaborativeCommand, { kind: 'update.external_failure' }>,
    actor: ControlPlaneActor,
  ) {
    const batch = this.updateBatchRow(command.batchId);
    this.requireResponsibleDeveloper(String(batch.submission_item_id), actor);
    if (batch.deployment_type !== 'CI_CD' || batch.state !== 'WAITING_EXTERNAL')
      throw this.invalidTransition('只有等待外部更新的 CI/CD 批次可以反馈失败');
    const now = this.iso();
    this.database.transaction(() => {
      this.database
        .query(
          `UPDATE submission_update_batch
           SET state='QUEUED',eligible_at=?,external_failure=?,updated_at=?
           WHERE id=?`,
        )
        .run(now, command.feedback, now, command.batchId);
      this.database
        .query(
          'DELETE FROM submission_update_feedback_attachment WHERE batch_id=?',
        )
        .run(command.batchId);
      for (const attachment of command.attachments)
        this.database
          .query(
            `INSERT INTO submission_update_feedback_attachment
             (id,batch_id,file_name,media_type,size_bytes,content_base64,created_at)
             VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            command.batchId,
            attachment.fileName,
            attachment.mediaType,
            attachment.sizeBytes,
            attachment.contentBase64,
            now,
          );
    })();
    return this.updateBatch(command.batchId, actor);
  }

  private confirmExternalUpdate(
    command: Extract<CollaborativeCommand, { kind: 'update.external_confirm' }>,
    actor: ControlPlaneActor,
  ) {
    const batch = this.updateBatchRow(command.batchId);
    this.requireResponsibleDeveloper(String(batch.submission_item_id), actor);
    if (batch.state === 'COMPLETED')
      return this.updateBatch(command.batchId, actor);
    if (batch.deployment_type !== 'CI_CD' || batch.state !== 'WAITING_EXTERNAL')
      throw this.invalidTransition('当前批次不能确认外部更新完成');
    this.completeBatch(
      command.batchId,
      batch.session_id ? String(batch.session_id) : null,
      this.iso(),
    );
    return this.updateBatch(command.batchId, actor);
  }

  private closeSubmission(
    command: Extract<CollaborativeCommand, { kind: 'submission.close' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireTesterForSubmission(command.submissionId, actor);
    const submission = this.submissionRow(command.submissionId);
    if (submission.status === 'CLOSED')
      return this.submissionDetail(command.submissionId, actor);
    const unfinished = this.count(
      `SELECT COUNT(*) count FROM submission_bug WHERE submission_id=? AND status!='DONE'`,
      command.submissionId,
    );
    if (unfinished > 0) throw this.conflict('仍有未完成 Bug，不能关闭提测单');
    const active =
      this.count(
        `SELECT COUNT(*) count FROM submission_repair_task t JOIN test_submission_item i ON i.id=t.submission_item_id WHERE i.submission_id=? AND t.state IN ('QUEUED','RUNNING')`,
        command.submissionId,
      ) +
      this.count(
        `SELECT COUNT(*) count FROM submission_update_batch u JOIN test_submission_item i ON i.id=u.submission_item_id WHERE i.submission_id=? AND u.state IN ('QUEUED','RUNNING','WAITING_EXTERNAL')`,
        command.submissionId,
      );
    if (active > 0) throw this.conflict('仍有修复或更新任务，不能关闭提测单');
    const now = this.iso();
    this.database.transaction(() => {
      this.database
        .query(
          `UPDATE test_submission SET status='CLOSED',closed_at=?,updated_at=? WHERE id=?`,
        )
        .run(now, now, command.submissionId);
      this.database
        .query(
          'DELETE FROM test_submission_environment_lock WHERE submission_id=?',
        )
        .run(command.submissionId);
      for (const item of this.itemRows(command.submissionId)) {
        const itemId = String(item.id);
        const sessionIds = this.database
          .query<Row, [string, string, string]>(
            `SELECT repair_session_id session_id FROM submission_bug WHERE submission_id=? AND submission_item_id=? AND repair_session_id IS NOT NULL UNION SELECT session_id FROM submission_update_batch WHERE submission_item_id=? AND session_id IS NOT NULL`,
          )
          .all(command.submissionId, itemId, itemId)
          .map((row) => String(row.session_id));
        this.database
          .query(
            `INSERT OR IGNORE INTO submission_cleanup_task(id,submission_id,submission_item_id,binding_id,runner_id,state,session_ids_json,summary,lease_token,lease_expires_at,retry_count,created_at,updated_at) VALUES(?,?,?,?,?,'QUEUED',?,NULL,NULL,NULL,0,?,?)`,
          )
          .run(
            randomUUID(),
            command.submissionId,
            itemId,
            String(item.binding_id),
            String(item.runner_id),
            JSON.stringify([...new Set(sessionIds)]),
            now,
            now,
          );
      }
      this.event(
        command.submissionId,
        null,
        'submission.closed',
        this.actorId(actor),
        now,
      );
    })();
    return this.submissionDetail(command.submissionId, actor);
  }

  private claimCleanupTask(
    command: Extract<CollaborativeCommand, { kind: 'cleanup_task.claim' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireRunnerActor(actor);
    if (!this.runnerOnline(command.runnerId)) return null;
    const now = this.iso();
    const expires = new Date(
      this.options.now().getTime() + command.leaseDurationMs,
    ).toISOString();
    const expired = this.database
      .query<Row, [string, string]>(
        `SELECT * FROM submission_cleanup_task
         WHERE runner_id=? AND state='RUNNING' AND lease_expires_at<=?
         ORDER BY updated_at,created_at,id LIMIT 1`,
      )
      .get(command.runnerId, now);
    if (expired) {
      const token = randomUUID();
      this.database
        .query(
          `UPDATE submission_cleanup_task
           SET lease_token=?,lease_expires_at=?,updated_at=? WHERE id=?`,
        )
        .run(token, expires, now, expired.id);
      return this.cleanupTask(String(expired.id));
    }
    const row = this.database
      .query<Row, [string]>(
        `SELECT * FROM submission_cleanup_task
         WHERE runner_id=? AND state IN ('QUEUED','FAILED')
         ORDER BY created_at,id LIMIT 1`,
      )
      .get(command.runnerId);
    if (!row) return null;
    const token = randomUUID();
    this.database
      .query(
        `UPDATE submission_cleanup_task
         SET state='RUNNING',lease_token=?,lease_expires_at=?,
             retry_count=retry_count+CASE WHEN state='FAILED' THEN 1 ELSE 0 END,
             updated_at=? WHERE id=?`,
      )
      .run(token, expires, now, row.id);
    return this.cleanupTask(String(row.id));
  }

  private renewCleanupTask(
    command: Extract<CollaborativeCommand, { kind: 'cleanup_task.renew' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireRunnerActor(actor);
    const row = this.cleanupRow(command.taskId);
    if (
      row.runner_id !== command.runnerId ||
      row.lease_token !== command.leaseToken
    )
      throw this.permission('清理任务租约不匹配');
    if (row.state !== 'RUNNING')
      throw this.invalidTransition('清理任务不在运行中');
    const now = this.iso();
    const expires = new Date(
      this.options.now().getTime() + command.leaseDurationMs,
    ).toISOString();
    this.database
      .query(
        'UPDATE submission_cleanup_task SET lease_expires_at=?,updated_at=? WHERE id=?',
      )
      .run(expires, now, command.taskId);
    return this.cleanupTask(command.taskId);
  }

  private finishCleanupTask(
    command: Extract<CollaborativeCommand, { kind: 'cleanup_task.finish' }>,
    actor: ControlPlaneActor,
  ) {
    this.requireRunnerActor(actor);
    const row = this.cleanupRow(command.taskId);
    if (row.runner_id !== command.runnerId)
      throw this.permission('清理任务不属于当前 Runner');
    if (row.state === 'COMPLETED' && command.success)
      return this.cleanupTask(command.taskId);
    if (row.lease_token !== command.leaseToken)
      throw this.permission('清理任务租约不匹配');
    if (row.state !== 'RUNNING')
      throw this.invalidTransition('清理任务不在运行中');
    this.database
      .query(
        `UPDATE submission_cleanup_task
         SET state=?,summary=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
         WHERE id=?`,
      )
      .run(
        command.success ? 'COMPLETED' : 'FAILED',
        command.summary,
        this.iso(),
        command.taskId,
      );
    return this.cleanupTask(command.taskId);
  }

  private enqueueRepair(
    bugId: string,
    itemId: string,
    front: boolean,
    feedback: string | null,
    actor: ControlPlaneActor,
  ) {
    const item = this.itemRow(itemId);
    const existing = this.database
      .query<Row, [string]>(
        `SELECT id FROM submission_repair_task WHERE bug_id=? AND state IN ('QUEUED','RUNNING')`,
      )
      .get(bugId);
    if (existing) return;
    const runningCount = this.count(
      `SELECT COUNT(*) count FROM submission_repair_task WHERE binding_id=? AND state='RUNNING'`,
      item.binding_id,
    );
    const position = front
      ? runningCount
      : this.count(
          `SELECT COUNT(*) count FROM submission_repair_task WHERE binding_id=? AND state IN ('QUEUED','RUNNING')`,
          item.binding_id,
        );
    if (front)
      this.database
        .query(
          `UPDATE submission_repair_task SET position=position+1 WHERE binding_id=? AND state='QUEUED'`,
        )
        .run(item.binding_id);
    const now = this.iso();
    const bug = this.bugRow(bugId);
    this.database.transaction(() => {
      this.database
        .query(
          `INSERT INTO submission_repair_task(id,bug_id,submission_item_id,binding_id,runner_id,state,position,lease_token,lease_expires_at,resume_session_id,retry_count,created_at,started_at,completed_at) VALUES(?,?,?,?,?,'QUEUED',?,NULL,NULL,?,0,?,NULL,NULL)`,
        )
        .run(
          randomUUID(),
          bugId,
          itemId,
          item.binding_id,
          item.runner_id,
          position,
          bug.submission_item_id === itemId ? bug.repair_session_id : null,
          now,
        );
      this.database
        .query(
          `UPDATE submission_bug SET submission_item_id=?,status='REPAIRING',latest_feedback=?,candidate_commit=NULL,updated_at=? WHERE id=?`,
        )
        .run(itemId, feedback ?? bug.latest_feedback, now, bugId);
      this.event(
        String(bug.submission_id),
        bugId,
        'bug.repair_enqueued',
        this.actorId(actor),
        now,
      );
    })();
  }

  private freezeEligibleUpdateBatches(runnerId: string, now: string) {
    const cutoff = new Date(
      this.options.now().getTime() - this.#automaticUpdateDelayMs,
    ).toISOString();
    const items = this.database
      .query<Row, [string, string]>(
        `SELECT submission_item_id
         FROM submission_bug
         WHERE status='WAITING_FOR_UPDATE' AND candidate_commit IS NOT NULL
           AND submission_item_id IN (
             SELECT id FROM test_submission_item WHERE runner_id=?
           )
         GROUP BY submission_item_id
         HAVING MAX(updated_at)<=?`,
      )
      .all(runnerId, cutoff);
    for (const item of items)
      this.freezeUpdateBatch(String(item.submission_item_id), now, false);
  }

  private freezeUpdateBatch(itemId: string, now: string, immediate: boolean) {
    const active = this.database
      .query<Row, [string]>(
        `SELECT id FROM submission_update_batch
         WHERE submission_item_id=?
           AND state IN ('QUEUED','RUNNING','WAITING_EXTERNAL','FAILED')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(itemId);
    if (active) return active;
    const candidates = this.database
      .query<Row, [string]>(
        `SELECT id,candidate_commit,updated_at FROM submission_bug
         WHERE submission_item_id=? AND status='WAITING_FOR_UPDATE'
           AND candidate_commit IS NOT NULL
         ORDER BY sequence`,
      )
      .all(itemId);
    if (!candidates.length) return null;
    const latestCandidateAt = Math.max(
      ...candidates.map((candidate) =>
        new Date(String(candidate.updated_at)).getTime(),
      ),
    );
    if (
      !immediate &&
      latestCandidateAt + this.#automaticUpdateDelayMs >
        this.options.now().getTime()
    )
      return null;
    const item = this.itemRow(itemId);
    const id = randomUUID();
    this.database.transaction(() => {
      this.database
        .query(
          `INSERT INTO submission_update_batch(id,submission_item_id,binding_id,runner_id,state,deployment_type,eligible_at,immediate_requested_at,session_id,lease_token,lease_expires_at,external_failure,created_at,updated_at,completed_at) VALUES(?,?,?,?, 'QUEUED',?,?,?,NULL,NULL,NULL,NULL,?,?,NULL)`,
        )
        .run(
          id,
          itemId,
          item.binding_id,
          item.runner_id,
          item.deployment_type,
          now,
          immediate ? now : null,
          now,
          now,
        );
      for (const candidate of candidates)
        this.database
          .query(
            'INSERT INTO submission_update_batch_member(batch_id,bug_id,candidate_commit) VALUES(?,?,?)',
          )
          .run(id, candidate.id, candidate.candidate_commit);
      this.database
        .query(
          `UPDATE submission_bug SET status='UPDATING',updated_at=?
           WHERE id IN (SELECT bug_id FROM submission_update_batch_member WHERE batch_id=?)`,
        )
        .run(now, id);
    })();
    return { id } as Row;
  }

  private completeBatch(
    batchId: string,
    sessionId: string | null,
    now: string,
  ) {
    this.database.transaction(() => {
      this.database
        .query(
          `UPDATE submission_update_batch SET state='COMPLETED',session_id=?,lease_token=NULL,lease_expires_at=NULL,external_failure=NULL,updated_at=?,completed_at=? WHERE id=?`,
        )
        .run(sessionId, now, now, batchId);
      this.database
        .query(
          `UPDATE submission_bug SET status='WAITING_FOR_VERIFICATION',updated_at=? WHERE id IN (SELECT bug_id FROM submission_update_batch_member WHERE batch_id=?)`,
        )
        .run(now, batchId);
    })();
  }

  private listSubmissions(
    projectId: string | undefined,
    includeClosed: boolean,
    actor: ControlPlaneActor,
  ) {
    const conditions: string[] = [];
    const params: string[] = [];
    if (projectId) {
      conditions.push('project_id=?');
      params.push(projectId);
    }
    if (!includeClosed) conditions.push(`status='ACTIVE'`);
    if (actor.kind === 'user' && actor.accountType === 'TESTER') {
      conditions.push('tester_user_id=?');
      params.push(actor.userId);
    } else if (actor.kind === 'user') {
      conditions.push(
        `EXISTS (SELECT 1 FROM project_member pm WHERE pm.project_id=test_submission.project_id AND pm.user_id=?)`,
      );
      params.push(actor.userId);
    }
    const rows = this.database
      .query<Row, string[]>(
        `SELECT * FROM test_submission${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC,id`,
      )
      .all(...params);
    return rows.map((row) => this.submissionSummary(row));
  }

  private submissionDetail(
    id: string,
    actor: ControlPlaneActor,
  ): TestSubmissionDetail {
    const row = this.submissionRow(id);
    this.requireSubmissionAccess(id, actor);
    const canSeeTechnical =
      actor.kind === 'system' ||
      (actor.kind === 'user' && actor.accountType === 'DEVELOPER');
    return TestSubmissionDetailSchema.parse({
      ...this.submissionSummary(row),
      items: this.itemRows(id).map((item) =>
        this.itemSummary(item, canSeeTechnical),
      ),
    });
  }

  private submissionSummary(row: Row): TestSubmissionSummary {
    const counts = Object.fromEntries(
      this.database
        .query<Row, [string]>(
          `SELECT status,COUNT(*) count FROM submission_bug WHERE submission_id=? GROUP BY status`,
        )
        .all(String(row.id))
        .map((item) => [String(item.status), Number(item.count)]),
    );
    return TestSubmissionSummarySchema.parse({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      requirementDescription: row.requirement_description,
      tester: this.user(String(row.tester_user_id)),
      status: row.status,
      itemCount: this.count(
        'SELECT COUNT(*) count FROM test_submission_item WHERE submission_id=?',
        row.id,
      ),
      bugCounts: {
        waitingForRepair: counts.WAITING_FOR_REPAIR ?? 0,
        repairing: counts.REPAIRING ?? 0,
        waitingForUpdate: counts.WAITING_FOR_UPDATE ?? 0,
        updating: counts.UPDATING ?? 0,
        waitingForVerification: counts.WAITING_FOR_VERIFICATION ?? 0,
        done: counts.DONE ?? 0,
      },
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
    });
  }

  private itemSummary(row: Row, canSeeTechnical: boolean) {
    return {
      id: row.id,
      submissionId: row.submission_id,
      engineeringId: row.engineering_id,
      engineeringSlug: row.engineering_slug,
      engineeringDisplayName: row.engineering_display_name,
      engineeringType: row.engineering_type,
      responsibleDeveloper: this.user(
        String(row.responsible_developer_user_id),
      ),
      technical: canSeeTechnical
        ? {
            repositoryUrl: row.repository_url,
            bindingId: row.binding_id,
            runnerId: row.runner_id,
            targetBranch: row.target_branch,
            environment: {
              id: row.environment_id,
              slug: row.environment_slug,
              displayName: row.environment_display_name,
              deploymentType: row.deployment_type,
              localScriptCommand: row.local_script_command,
              manualConfirmationRequired: row.deployment_type === 'CI_CD',
            },
          }
        : null,
      lockedAt: row.locked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private listBugs(submissionId: string, actor: ControlPlaneActor) {
    return this.database
      .query<Row, [string]>(
        'SELECT b.*,i.engineering_display_name FROM submission_bug b LEFT JOIN test_submission_item i ON i.id=b.submission_item_id WHERE b.submission_id=? ORDER BY b.sequence',
      )
      .all(submissionId)
      .map((row) => this.bugFromRow(row, actor));
  }

  private bugDetail(id: string, actor: ControlPlaneActor) {
    const row = this.bugRow(id);
    this.requireSubmissionAccess(String(row.submission_id), actor);
    return this.bugFromRow(row, actor);
  }

  private bugFromRow(row: Row, actor: ControlPlaneActor): SubmissionBug {
    const attempts = this.database
      .query<Row, [string]>(
        `SELECT * FROM submission_repair_attempt WHERE bug_id=? ORDER BY created_at,id`,
      )
      .all(String(row.id))
      .map((attempt) => ({
        id: attempt.id,
        bugId: attempt.bug_id,
        taskId: attempt.task_id,
        sessionId: attempt.session_id,
        outcome: attempt.outcome,
        summary: attempt.summary,
        candidateCommit: attempt.candidate_commit,
        createdAt: attempt.created_at,
      }));
    const attachments = this.database
      .query<Row, [string]>(
        'SELECT * FROM submission_bug_attachment WHERE bug_id=? ORDER BY created_at,id',
      )
      .all(String(row.id))
      .map((attachment) => ({
        id: attachment.id,
        bugId: attachment.bug_id,
        fileName: attachment.file_name,
        mediaType: attachment.media_type,
        sizeBytes: Number(attachment.size_bytes),
        createdAt: attachment.created_at,
      }));
    const item = row.submission_item_id
      ? this.itemRow(String(row.submission_item_id))
      : null;
    return SubmissionBugSchema.parse({
      id: row.id,
      shortId: `BUG-${String(row.sequence).padStart(4, '0')}`,
      submissionId: row.submission_id,
      submissionItemId: row.submission_item_id,
      engineeringDisplayName: item?.engineering_display_name ?? null,
      status: row.status,
      title: row.title,
      operationPath: row.operation_path,
      actualResult: row.actual_result,
      expectedResult: row.expected_result,
      supplementalDescription: row.supplemental_description,
      latestFeedback: row.latest_feedback,
      attachments,
      attempts,
      candidateCommit:
        actor.kind === 'user' && actor.accountType === 'TESTER'
          ? null
          : row.candidate_commit,
      repairSessionId:
        actor.kind === 'user' && actor.accountType === 'TESTER'
          ? null
          : row.repair_session_id,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private repairQueue(itemId: string) {
    return this.database
      .query<Row, [string]>(
        `SELECT id FROM submission_repair_task WHERE submission_item_id=? AND state IN ('QUEUED','RUNNING') ORDER BY position,created_at,id`,
      )
      .all(itemId)
      .map((row) => this.repairTask(String(row.id)));
  }

  private repairTask(id: string): SubmissionRepairTask {
    const row = this.taskRow(id);
    return SubmissionRepairTaskSchema.parse({
      id: row.id,
      bugId: row.bug_id,
      submissionItemId: row.submission_item_id,
      bindingId: row.binding_id,
      runnerId: row.runner_id,
      state: row.state,
      position: Number(row.position),
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      resumeSessionId: row.resume_session_id,
      retryCount: Number(row.retry_count),
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    });
  }

  private updateBatches(itemId: string, actor: ControlPlaneActor) {
    return this.database
      .query<Row, [string]>(
        'SELECT id FROM submission_update_batch WHERE submission_item_id=? ORDER BY created_at,id',
      )
      .all(itemId)
      .map((row) => this.updateBatch(String(row.id), actor));
  }

  private updateBatch(
    id: string,
    actor: ControlPlaneActor,
  ): SubmissionUpdateBatch {
    const row = this.updateBatchRow(id);
    const members = this.database
      .query<Row, [string]>(
        'SELECT bug_id,candidate_commit FROM submission_update_batch_member WHERE batch_id=? ORDER BY rowid',
      )
      .all(id);
    const attachments = this.database
      .query<Row, [string]>(
        'SELECT * FROM submission_update_feedback_attachment WHERE batch_id=? ORDER BY created_at,id',
      )
      .all(id);
    const canSeeTechnical =
      actor.kind === 'system' ||
      (actor.kind === 'user' && actor.accountType === 'DEVELOPER');
    return SubmissionUpdateBatchSchema.parse({
      id: row.id,
      submissionItemId: row.submission_item_id,
      bindingId: row.binding_id,
      runnerId: row.runner_id,
      state: row.state,
      deploymentType: row.deployment_type,
      bugIds: members.map((member) => member.bug_id),
      candidateCommits: canSeeTechnical
        ? members.map((member) => member.candidate_commit)
        : [],
      eligibleAt: row.eligible_at,
      immediateRequestedAt: row.immediate_requested_at,
      sessionId: canSeeTechnical ? row.session_id : null,
      leaseToken: actor.kind === 'system' ? row.lease_token : null,
      leaseExpiresAt: actor.kind === 'system' ? row.lease_expires_at : null,
      externalFailure: canSeeTechnical ? row.external_failure : null,
      externalFailureAttachments: canSeeTechnical
        ? attachments.map((attachment) => ({
            id: attachment.id,
            batchId: attachment.batch_id,
            fileName: attachment.file_name,
            mediaType: attachment.media_type,
            sizeBytes: Number(attachment.size_bytes),
            contentBase64: attachment.content_base64,
            createdAt: attachment.created_at,
          }))
        : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    });
  }

  private cleanupTasks(runnerId: string) {
    return this.database
      .query<Row, [string]>(
        'SELECT id FROM submission_cleanup_task WHERE runner_id=? ORDER BY created_at,id',
      )
      .all(runnerId)
      .map((row) => this.cleanupTask(String(row.id)));
  }

  private cleanupTask(id: string): SubmissionCleanupTask {
    const row = this.cleanupRow(id);
    return SubmissionCleanupTaskSchema.parse({
      id: row.id,
      submissionId: row.submission_id,
      submissionItemId: row.submission_item_id,
      bindingId: row.binding_id,
      runnerId: row.runner_id,
      state: row.state,
      sessionIds: JSON.parse(String(row.session_ids_json)),
      summary: row.summary,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      retryCount: Number(row.retry_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private getAttachment(id: string, actor: ControlPlaneActor) {
    const row = this.database
      .query<Row, [string]>(
        'SELECT a.*,b.submission_id FROM submission_bug_attachment a JOIN submission_bug b ON b.id=a.bug_id WHERE a.id=?',
      )
      .get(id);
    if (!row) throw this.notFound('附件不存在');
    this.requireSubmissionAccess(String(row.submission_id), actor);
    return {
      attachment: {
        id: String(row.id),
        bugId: String(row.bug_id),
        fileName: String(row.file_name),
        mediaType: String(row.media_type) as
          | 'image/png'
          | 'image/jpeg'
          | 'image/webp'
          | 'text/plain'
          | 'application/json',
        sizeBytes: Number(row.size_bytes),
        createdAt: String(row.created_at),
      },
      contentBase64: String(row.content_base64),
    };
  }

  private validateItemInput(
    projectId: string,
    input: {
      engineeringId: string;
      responsibleDeveloperUserId: string;
      bindingId: string;
      targetBranch: string;
      environmentId: string;
    },
  ) {
    const row = this.database
      .query<Row, [string, string, string, string, string, string]>(
        `SELECT e.id engineering_id,e.slug engineering_slug,e.display_name engineering_display_name,e.type engineering_type,e.repository_url,env.id environment_id,env.slug environment_slug,env.display_name environment_display_name,env.deployment_type,env.local_script_command,b.id binding_id,b.runner_id FROM engineering e JOIN engineering_environment env ON env.engineering_id=e.id JOIN engineering_member em ON em.engineering_id=e.id AND em.user_id=? JOIN engineering_binding b ON b.engineering_id=e.id AND b.developer_user_id=? WHERE e.id=? AND e.project_id=? AND e.archived_at IS NULL AND env.id=? AND b.id=?`,
      )
      .get(
        input.responsibleDeveloperUserId,
        input.responsibleDeveloperUserId,
        input.engineeringId,
        projectId,
        input.environmentId,
        input.bindingId,
      );
    if (!row)
      throw this.validation('工程负责人、有效绑定、目标环境或部署配置不完整');
    if (!input.targetBranch.trim()) throw this.validation('目标分支不能为空');
    return row;
  }

  private requireSubmissionAccess(
    submissionId: string,
    actor: ControlPlaneActor,
  ) {
    if (actor.kind === 'system') return;
    const row = this.submissionRow(submissionId);
    if (actor.accountType === 'TESTER') {
      if (row.tester_user_id !== actor.userId)
        throw this.permission('只能访问分配给自己的提测单');
      return;
    }
    this.requireProjectMember(String(row.project_id), actor.userId);
  }

  private requireItemAccess(itemId: string, actor: ControlPlaneActor) {
    const item = this.itemRow(itemId);
    this.requireSubmissionAccess(String(item.submission_id), actor);
  }

  private requireItemDeveloper(
    itemId: string,
    actor: ControlPlaneActor,
    anyProjectDeveloper = false,
  ) {
    const item = this.itemRow(itemId);
    const developer = this.requireDeveloper(actor);
    if (anyProjectDeveloper)
      this.requireProjectMember(String(item.project_id), developer);
    else if (item.responsible_developer_user_id !== developer)
      throw this.permission('只有负责开发人员可以操作该工程任务');
  }

  private requireResponsibleDeveloper(
    itemId: string,
    actor: ControlPlaneActor,
  ) {
    this.requireItemDeveloper(itemId, actor, false);
  }

  private requireTesterForSubmission(
    submissionId: string,
    actor: ControlPlaneActor,
  ) {
    if (actor.kind !== 'user' || actor.accountType !== 'TESTER')
      throw this.permission('只有指定测试人员可以执行该操作');
    const row = this.submissionRow(submissionId);
    if (row.tester_user_id !== actor.userId)
      throw this.permission('只能操作分配给自己的提测单');
    return actor.userId;
  }

  private requireProjectMember(projectId: string, userId: string) {
    const row = this.database
      .query<Row, [string, string]>(
        'SELECT 1 ok FROM project_member WHERE project_id=? AND user_id=?',
      )
      .get(projectId, userId);
    if (!row) throw this.permission('只有项目开发人员可以执行该操作');
  }

  private requireDeveloper(actor: ControlPlaneActor) {
    if (actor.kind !== 'user' || actor.accountType !== 'DEVELOPER')
      throw this.permission('该操作仅限开发人员');
    return actor.userId;
  }

  private requireRunnerActor(actor: ControlPlaneActor) {
    if (actor.kind !== 'system')
      throw this.permission('Runner 工作接口仅允许系统身份调用');
  }

  private requireSubmissionActive(id: string) {
    if (this.submissionRow(id).status !== 'ACTIVE')
      throw this.conflict('提测单已关闭，永久只读');
  }

  private requireItemBelongsToSubmission(itemId: string, submissionId: string) {
    if (this.itemRow(itemId).submission_id !== submissionId)
      throw this.validation('工程提测项不属于该提测单');
  }

  private runnerOnline(runnerId: string) {
    const row = this.database
      .query<Row, [string]>('SELECT last_seen_at FROM runner WHERE id=?')
      .get(runnerId);
    return (
      !!row &&
      this.options.now().getTime() -
        new Date(String(row.last_seen_at)).getTime() <=
        this.options.runnerOfflineAfterMs
    );
  }

  private submissionRow(id: string) {
    const row = this.database
      .query<Row, [string]>('SELECT * FROM test_submission WHERE id=?')
      .get(id);
    if (!row) throw this.notFound('提测单不存在');
    return row;
  }

  private itemRow(id: string) {
    const row = this.database
      .query<Row, [string]>(
        `SELECT i.*,s.project_id,s.tester_user_id,s.status submission_status FROM test_submission_item i JOIN test_submission s ON s.id=i.submission_id WHERE i.id=?`,
      )
      .get(id);
    if (!row) throw this.notFound('工程提测项不存在');
    return row;
  }

  private itemRows(submissionId: string) {
    return this.database
      .query<Row, [string]>(
        'SELECT * FROM test_submission_item WHERE submission_id=? ORDER BY created_at,id',
      )
      .all(submissionId);
  }

  private bugRow(id: string) {
    const row = this.database
      .query<Row, [string]>(
        `SELECT b.*,s.project_id,s.tester_user_id FROM submission_bug b JOIN test_submission s ON s.id=b.submission_id WHERE b.id=?`,
      )
      .get(id);
    if (!row) throw this.notFound('Bug 不存在');
    return row;
  }

  private taskRow(id: string) {
    const row = this.database
      .query<Row, [string]>('SELECT * FROM submission_repair_task WHERE id=?')
      .get(id);
    if (!row) throw this.notFound('修复任务不存在');
    return row;
  }

  private updateBatchRow(id: string) {
    const row = this.database
      .query<Row, [string]>('SELECT * FROM submission_update_batch WHERE id=?')
      .get(id);
    if (!row) throw this.notFound('更新批次不存在');
    return row;
  }

  private cleanupRow(id: string) {
    const row = this.database
      .query<Row, [string]>('SELECT * FROM submission_cleanup_task WHERE id=?')
      .get(id);
    if (!row) throw this.notFound('清理任务不存在');
    return row;
  }

  private requireExecutionIdentity(
    kind: 'REPAIR' | 'UPDATE' | 'CLEANUP',
    executionId: string,
    itemId: string,
    bindingId: string,
  ) {
    const table = {
      REPAIR: 'submission_repair_task',
      UPDATE: 'submission_update_batch',
      CLEANUP: 'submission_cleanup_task',
    }[kind];
    const row = this.database
      .query<Row, [string]>(
        `SELECT submission_item_id,binding_id FROM ${table} WHERE id=?`,
      )
      .get(executionId);
    if (!row) throw this.notFound('Codex 执行不存在');
    if (row.submission_item_id !== itemId || row.binding_id !== bindingId)
      throw this.validation('Codex 交互与执行上下文不匹配');
  }

  private interactions(itemId: string, pendingOnly: boolean) {
    return this.database
      .query<Row, [string]>(
        `SELECT id FROM codex_interaction_request
         WHERE submission_item_id=? ${pendingOnly ? "AND state='PENDING'" : ''}
         ORDER BY created_at,id`,
      )
      .all(itemId)
      .map((row) => this.interaction(String(row.id)));
  }

  private interaction(id: string): CodexInteractionRequest {
    const row = this.database
      .query<Row, [string]>(
        'SELECT * FROM codex_interaction_request WHERE id=?',
      )
      .get(id);
    if (!row) throw this.notFound('Codex 交互请求不存在');
    return CodexInteractionRequestSchema.parse({
      id: row.id,
      executionKind: row.execution_kind,
      executionId: row.execution_id,
      submissionItemId: row.submission_item_id,
      bindingId: row.binding_id,
      kind: row.kind,
      method: row.method,
      threadId: row.thread_id,
      turnId: row.turn_id,
      itemId: row.item_id,
      payload: JSON.parse(String(row.payload_json)),
      state: row.state,
      resolution: row.resolution_json
        ? JSON.parse(String(row.resolution_json))
        : null,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    });
  }

  private user(id: string) {
    const user = USERS.get(id);
    if (!user) throw this.notFound('账号不存在');
    return user;
  }

  private count(sql: string, ...params: Array<string | number | null>) {
    return Number(
      this.database
        .query<Row, Array<string | number | null>>(sql)
        .get(...params)?.count ?? 0,
    );
  }

  private event(
    submissionId: string,
    bugId: string | null,
    type: string,
    actorId: string | null,
    now: string,
  ) {
    this.database
      .query(
        'INSERT INTO submission_event(id,submission_id,bug_id,event_type,actor_user_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(randomUUID(), submissionId, bugId, type, actorId, '{}', now);
  }

  private actorId(actor: ControlPlaneActor) {
    return actor.kind === 'user' ? actor.userId : null;
  }

  private iso() {
    return this.options.now().toISOString();
  }
  private notFound(message: string) {
    return createAppError({
      code: ERROR_CODES.entityNotFound,
      category: 'not_found',
      message,
      retryable: false,
    });
  }
  private validation(message: string) {
    return createAppError({
      code: ERROR_CODES.configInvalid,
      category: 'validation',
      message,
      retryable: false,
    });
  }
  private permission(message: string) {
    return createAppError({
      code: ERROR_CODES.projectAccessDenied,
      category: 'permission',
      message,
      retryable: false,
    });
  }
  private conflict(message: string) {
    return createAppError({
      code: ERROR_CODES.storeConstraintConflict,
      category: 'conflict',
      message,
      retryable: false,
    });
  }
  private invalidTransition(message: string) {
    return createAppError({
      code: ERROR_CODES.bugTransitionInvalid,
      category: 'conflict',
      message,
      retryable: false,
    });
  }
}
