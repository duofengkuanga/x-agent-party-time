import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  BUG_REPAIR_OUTPUT_JSON_SCHEMA,
  DEPLOYMENT_OUTPUT_JSON_SCHEMA,
  PROMPT_TEMPLATES,
  CreateBugCommandSchema,
  CreateProjectCommandSchema,
  ERROR_CODES,
  RegisterRunnerCommandSchema,
  RenameProjectCommandSchema,
  RepairResultSchema,
  createAppError,
  getPromptTemplate,
  type BugAttachmentMetadata,
  type BugDetail,
  type BugEvent,
  type BugSummary,
  type CleanupTarget,
  type CreateBugCommand,
  type CreateProjectCommand,
  type DeploymentBatchSummary,
  type DeploymentBatchState,
  type DeploymentConfigSnapshot,
  type DeploymentResult,
  type DeploymentWorkClaim,
  type ProjectSummary,
  type RepairAttemptOutcome,
  type RepairAttemptState,
  type RepairAttemptSummary,
  type RepairDispatchClaim,
  type RepairDispatchConfigSnapshot,
  type RepairDispatchState,
  type RepairDispatchSummary,
  type RepairPrompt,
  type RepairResult,
  type RepairWorkItem,
  type RegisterRunnerCommand,
  type RunnerSummary,
} from '@agent-party-time/shared';
import * as Contract from '@agent-party-time/shared';
import { CollaborativeSubmissionStore } from './collaborative-submission-store.js';
import {
  decodeBugAttachment,
  safeAttachmentName,
} from './attachment-policy.js';

interface ProjectRow {
  id: string;
  slug: string;
  title: string | null;
  default_runner_id: string | null;
  created_at: string;
  updated_at: string;
}
interface ProjectMemberRow {
  project_id: string;
  user_id: string;
  role: 'OWNER' | 'DEVELOPER';
  created_at: string;
  updated_at: string;
}
interface ProjectInvitationRow {
  id: string;
  project_id: string;
  invitee_user_id: string;
  invited_by_user_id: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REVOKED';
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}
interface ProjectAuditEventRow {
  id: string;
  project_id: string;
  actor_user_id: string;
  event_type: Contract.ProjectAuditEventSummary['type'];
  subject_user_id: string | null;
  created_at: string;
}
interface EngineeringRow {
  id: string;
  project_id: string;
  slug: string;
  display_name: string;
  type: Contract.EngineeringSummary['type'];
  repository_url: string;
  archived_at: string | null;
  first_referenced_at: string | null;
  created_at: string;
  updated_at: string;
}
interface EngineeringMemberRow {
  engineering_id: string;
  user_id: string;
  role: Contract.EngineeringMemberSummary['role'];
  created_at: string;
  updated_at: string;
}
interface EngineeringEnvironmentRow {
  id: string;
  engineering_id: string;
  slug: string;
  display_name: string;
  deployment_type: Contract.EngineeringEnvironmentSummary['deploymentType'];
  local_script_command: string | null;
  created_at: string;
  updated_at: string;
}
interface EngineeringBindingTicketRow {
  id: string;
  engineering_id: string;
  developer_user_id: string;
  expires_at: string;
  consumed_at: string | null;
}
interface EngineeringBindingRow {
  id: string;
  engineering_id: string;
  developer_user_id: string;
  runner_id: string;
  repository_name: string | null;
  created_at: string;
  updated_at: string;
}
interface RunnerRow {
  id: string;
  name: string;
  last_seen_at: string;
}
interface IdempotencyRow {
  request_json: string;
  entity_id: string;
}
interface BugRow {
  sequence: number;
  id: string;
  project_id: string;
  status: BugSummary['status'];
  repair_state: BugSummary['repairState'];
  repair_dispatch_id: string | null;
  deployment_batch_id: string | null;
  deployment_state: BugSummary['deploymentState'];
  title: string;
  operation_path: string;
  actual_result: string;
  expected_result: string;
  supplemental_description: string | null;
  created_at: string;
  updated_at: string;
}
interface RepairDispatchRow {
  sequence: number;
  id: string;
  project_id: string;
  runner_id: string;
  state: RepairDispatchState | 'cancelled' | 'completed';
  closes_at: string;
  max_bugs: number;
  delay_ms: number;
  max_infrastructure_retries: number;
  resume_session_id: string | null;
  feedback: string | null;
  source_deployment_batch_id: string | null;
  source_deployed_commit: string | null;
  created_at: string;
  updated_at: string;
  queued_at: string | null;
  claimed_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  completed_at: string | null;
}
interface RepairDispatchMemberContextRow {
  resume_session_id: string | null;
  feedback: string | null;
  source_deployment_batch_id: string | null;
  source_deployed_commit: string | null;
}
interface RepairAttemptRow {
  id: string;
  bug_id: string;
  dispatch_id: string;
  runner_id: string;
  template_name: string;
  template_version: string;
  state: RepairAttemptState;
  session_id: string | null;
  result_json: string | null;
  failure_message: string | null;
  retry_number: number;
  max_infrastructure_retries: number;
  cancel_requested: number;
  source_deployment_batch_id: string | null;
  source_deployed_commit: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
interface AttachmentRow {
  id: string;
  bug_id: string;
  verification_feedback_id: string | null;
  file_name: string;
  media_type: BugAttachmentMetadata['mediaType'];
  size_bytes: number;
  storage_key: string;
  created_at: string;
}
interface EventRow {
  id: string;
  bug_id: string;
  event_type: BugEvent['type'];
  created_at: string;
}
interface DeploymentBatchRow {
  sequence: number;
  id: string;
  project_id: string;
  runner_id: string;
  state: DeploymentBatchState;
  closes_at: string;
  max_bugs: number;
  delay_ms: number;
  template_name: string | null;
  template_version: string | null;
  feedback: string | null;
  summary: string | null;
  reason: string | null;
  deployed_commit: string | null;
  created_at: string;
  updated_at: string;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
}
interface DeploymentAttemptRow {
  id: string;
  batch_id: string;
  runner_id: string;
  state: string;
  session_id: string | null;
  cancel_requested: number;
  result_json: string | null;
  failure_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ControlPlaneStoreOptions {
  now?: () => Date;
  runnerOfflineAfterMs?: number;
  attachmentsDirectory?: string;
  repairDispatchConfig?: RepairDispatchConfigSnapshot;
  repairInfrastructureRetries?: number;
  collaborativeAutomaticUpdateDelayMs?: number;
  repairLeaseDurationMs?: number;
  deploymentBatchConfig?: DeploymentConfigSnapshot;
  deploymentLeaseDurationMs?: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS runner (id TEXT PRIMARY KEY, name TEXT NOT NULL, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT, default_runner_id TEXT REFERENCES runner(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_member (
 project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE, user_id TEXT NOT NULL, role TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,user_id));
CREATE TABLE IF NOT EXISTS project_invitation (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE, invitee_user_id TEXT NOT NULL, invited_by_user_id TEXT NOT NULL,
 status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS project_invitation_pending ON project_invitation(project_id,invitee_user_id) WHERE status='PENDING';
CREATE TABLE IF NOT EXISTS project_audit_event (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE, actor_user_id TEXT NOT NULL,
 event_type TEXT NOT NULL, subject_user_id TEXT, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_audit_project ON project_audit_event(project_id,created_at,id);
CREATE TABLE IF NOT EXISTS engineering (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 slug TEXT NOT NULL, display_name TEXT NOT NULL, type TEXT NOT NULL, repository_url TEXT NOT NULL,
 archived_at TEXT, first_referenced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(project_id,slug));
CREATE INDEX IF NOT EXISTS engineering_project ON engineering(project_id,type,created_at,id);
CREATE TABLE IF NOT EXISTS engineering_member (
 engineering_id TEXT NOT NULL REFERENCES engineering(id) ON DELETE CASCADE, user_id TEXT NOT NULL, role TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(engineering_id,user_id));
CREATE UNIQUE INDEX IF NOT EXISTS engineering_single_owner ON engineering_member(engineering_id) WHERE role='OWNER';
CREATE TABLE IF NOT EXISTS engineering_environment (
 id TEXT PRIMARY KEY, engineering_id TEXT NOT NULL REFERENCES engineering(id) ON DELETE CASCADE,
 slug TEXT NOT NULL, display_name TEXT NOT NULL, deployment_type TEXT NOT NULL, local_script_command TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(engineering_id,slug));
CREATE TABLE IF NOT EXISTS engineering_binding_ticket (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, engineering_id TEXT NOT NULL REFERENCES engineering(id) ON DELETE CASCADE,
 developer_user_id TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS engineering_binding (
 id TEXT PRIMARY KEY, engineering_id TEXT NOT NULL REFERENCES engineering(id) ON DELETE CASCADE,
 developer_user_id TEXT NOT NULL, runner_id TEXT NOT NULL REFERENCES runner(id), repository_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(engineering_id,developer_user_id));
CREATE INDEX IF NOT EXISTS engineering_binding_runner ON engineering_binding(runner_id,engineering_id);
CREATE TABLE IF NOT EXISTS idempotency_record (operation TEXT NOT NULL, key TEXT NOT NULL, request_json TEXT NOT NULL, entity_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(operation,key));
CREATE TABLE IF NOT EXISTS bug (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES project(id),
 status TEXT NOT NULL, repair_state TEXT, repair_dispatch_id TEXT, deployment_batch_id TEXT, deployment_state TEXT,
 title TEXT NOT NULL, environment TEXT NOT NULL, operation_path TEXT NOT NULL, actual_result TEXT NOT NULL, expected_result TEXT NOT NULL,
 supplemental_description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bug_attachment (
 id TEXT PRIMARY KEY, bug_id TEXT NOT NULL REFERENCES bug(id) ON DELETE CASCADE, verification_feedback_id TEXT,
 file_name TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, storage_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bug_event (id TEXT PRIMARY KEY, bug_id TEXT NOT NULL REFERENCES bug(id) ON DELETE CASCADE, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repair_dispatch (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES project(id), runner_id TEXT NOT NULL REFERENCES runner(id), state TEXT NOT NULL,
 closes_at TEXT NOT NULL, max_bugs INTEGER NOT NULL, delay_ms INTEGER NOT NULL, max_infrastructure_retries INTEGER NOT NULL DEFAULT 2,
 resume_session_id TEXT, feedback TEXT, source_deployment_batch_id TEXT, source_deployed_commit TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, queued_at TEXT, claimed_at TEXT, lease_token TEXT, lease_expires_at TEXT, completed_at TEXT);
CREATE TABLE IF NOT EXISTS repair_dispatch_member (
 dispatch_id TEXT NOT NULL REFERENCES repair_dispatch(id), bug_id TEXT NOT NULL REFERENCES bug(id),
 position INTEGER NOT NULL, created_at TEXT NOT NULL, removed_at TEXT,
 resume_session_id TEXT, feedback TEXT, source_deployment_batch_id TEXT, source_deployed_commit TEXT,
 PRIMARY KEY(dispatch_id,bug_id));
CREATE TABLE IF NOT EXISTS repair_attempt (
 id TEXT PRIMARY KEY, bug_id TEXT NOT NULL REFERENCES bug(id), dispatch_id TEXT NOT NULL REFERENCES repair_dispatch(id), runner_id TEXT NOT NULL REFERENCES runner(id),
 template_name TEXT NOT NULL, template_version TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT, result_json TEXT, failure_message TEXT,
 retry_number INTEGER NOT NULL DEFAULT 0, max_infrastructure_retries INTEGER NOT NULL DEFAULT 2, cancel_requested INTEGER NOT NULL DEFAULT 0,
 source_deployment_batch_id TEXT, source_deployed_commit TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS repair_attempt_bug ON repair_attempt(bug_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS repair_dispatch_collecting_project ON repair_dispatch(project_id) WHERE state='collecting';
CREATE UNIQUE INDEX IF NOT EXISTS repair_dispatch_claimed_runner ON repair_dispatch(runner_id) WHERE state='claimed';
CREATE INDEX IF NOT EXISTS repair_dispatch_queue ON repair_dispatch(runner_id,state,queued_at,sequence);
CREATE TABLE IF NOT EXISTS verification_feedback (
 id TEXT PRIMARY KEY, bug_id TEXT NOT NULL REFERENCES bug(id), deployment_batch_id TEXT NOT NULL, feedback TEXT NOT NULL, deployed_commit TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deployment_batch (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES project(id), runner_id TEXT NOT NULL REFERENCES runner(id), state TEXT NOT NULL,
 closes_at TEXT NOT NULL, max_bugs INTEGER NOT NULL, delay_ms INTEGER NOT NULL, template_name TEXT, template_version TEXT, feedback TEXT,
 summary TEXT, reason TEXT, deployed_commit TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, queued_at TEXT, started_at TEXT, finished_at TEXT,
 lease_token TEXT, lease_expires_at TEXT);
CREATE TABLE IF NOT EXISTS deployment_batch_member (
 batch_id TEXT NOT NULL REFERENCES deployment_batch(id), bug_id TEXT NOT NULL REFERENCES bug(id), candidate_commit TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(batch_id,bug_id));
CREATE TABLE IF NOT EXISTS deployment_attempt (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES deployment_batch(id), runner_id TEXT NOT NULL REFERENCES runner(id), state TEXT NOT NULL,
 session_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, result_json TEXT, failure_message TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS deployment_attempt_batch ON deployment_attempt(batch_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS deployment_batch_collecting_project ON deployment_batch(project_id) WHERE state='collecting';
CREATE INDEX IF NOT EXISTS deployment_batch_queue ON deployment_batch(runner_id,state,queued_at,sequence);
CREATE TABLE IF NOT EXISTS cleanup_record (
 id TEXT PRIMARY KEY, runner_id TEXT NOT NULL REFERENCES runner(id), target_kind TEXT NOT NULL, target_id TEXT NOT NULL, success INTEGER NOT NULL,
 summary TEXT NOT NULL, session_id TEXT, generation_token TEXT, created_at TEXT NOT NULL);
`;

const BUG_SELECT = `SELECT sequence,id,project_id,status,repair_state,repair_dispatch_id,deployment_batch_id,deployment_state,title,operation_path,actual_result,expected_result,supplemental_description,created_at,updated_at FROM bug`;
const REPAIR_DISPATCH_SELECT = `SELECT sequence,id,project_id,runner_id,state,closes_at,max_bugs,delay_ms,max_infrastructure_retries,resume_session_id,feedback,source_deployment_batch_id,source_deployed_commit,created_at,updated_at,queued_at,claimed_at,lease_token,lease_expires_at,completed_at FROM repair_dispatch`;
const REPAIR_ATTEMPT_SELECT = `SELECT id,bug_id,dispatch_id,runner_id,template_name,template_version,state,session_id,result_json,failure_message,retry_number,max_infrastructure_retries,cancel_requested,source_deployment_batch_id,source_deployed_commit,created_at,started_at,finished_at FROM repair_attempt`;
const DEPLOYMENT_BATCH_SELECT = `SELECT sequence,id,project_id,runner_id,state,closes_at,max_bugs,delay_ms,template_name,template_version,feedback,summary,reason,deployed_commit,created_at,updated_at,queued_at,started_at,finished_at,lease_token,lease_expires_at FROM deployment_batch`;
const DEPLOYMENT_ATTEMPT_SELECT = `SELECT id,batch_id,runner_id,state,session_id,cancel_requested,result_json,failure_message,created_at,started_at,finished_at FROM deployment_attempt`;

const SYSTEM_ACTOR = { kind: 'system' } as const;
const LEGACY_OWNER_USER_ID = 'user-xujiequan';
const REGISTERED_USERS: readonly Contract.RegisteredUserSummary[] = [
  {
    id: 'user-xujiequan',
    username: 'xujiequan',
    displayName: '徐捷泉',
    accountType: 'DEVELOPER',
  },
  {
    id: 'user-zhoumingbo',
    username: 'zhoumingbo',
    displayName: '周明波',
    accountType: 'DEVELOPER',
  },
  {
    id: 'user-tianguohui',
    username: 'tianguohui',
    displayName: '田国会',
    accountType: 'TESTER',
  },
] as const;

export class ControlPlaneStore {
  private readonly now: () => Date;
  private readonly runnerOfflineAfterMs: number;
  private readonly attachmentsDirectory: string;
  private readonly repairDispatchConfig: RepairDispatchConfigSnapshot;
  private readonly repairInfrastructureRetries: number;
  private readonly repairLeaseDurationMs: number;
  private readonly deploymentBatchConfig: DeploymentConfigSnapshot;
  private readonly deploymentLeaseDurationMs: number;
  private readonly collaborative: CollaborativeSubmissionStore;

  private constructor(
    private readonly database: Database,
    options: ControlPlaneStoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.runnerOfflineAfterMs = options.runnerOfflineAfterMs ?? 20_000;
    this.attachmentsDirectory = options.attachmentsDirectory!;
    this.repairDispatchConfig = options.repairDispatchConfig ?? {
      maxBugs: 5,
      delayMs: 120_000,
    };
    this.repairInfrastructureRetries = options.repairInfrastructureRetries ?? 2;
    this.repairLeaseDurationMs = options.repairLeaseDurationMs ?? 60_000;
    this.deploymentBatchConfig = options.deploymentBatchConfig ?? {
      maxBugs: 5,
      delayMs: 120_000,
    };
    this.deploymentLeaseDurationMs =
      options.deploymentLeaseDurationMs ?? 60_000;
    this.collaborative = new CollaborativeSubmissionStore(database, {
      now: this.now,
      runnerOfflineAfterMs: this.runnerOfflineAfterMs,
      repairInfrastructureRetries: this.repairInfrastructureRetries,
      automaticUpdateDelayMs: options.collaborativeAutomaticUpdateDelayMs,
    });
  }

  static async open(
    databasePath: string,
    options: ControlPlaneStoreOptions = {},
  ) {
    if (databasePath !== ':memory:')
      await mkdir(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath, { create: true, strict: true });
    database.exec(SCHEMA);
    database.exec(
      `INSERT OR IGNORE INTO project_member(project_id,user_id,role,created_at,updated_at)
       SELECT id,'user-xujiequan','OWNER',created_at,updated_at FROM project`,
    );
    ensureColumn(database, 'runner', 'owner_user_id', 'TEXT');
    ensureColumn(database, 'engineering_binding', 'repository_name', 'TEXT');
    ensureColumn(database, 'bug', 'repair_state', 'TEXT');
    ensureColumn(database, 'bug', 'repair_dispatch_id', 'TEXT');
    ensureColumn(database, 'bug', 'deployment_batch_id', 'TEXT');
    ensureColumn(database, 'bug', 'deployment_state', 'TEXT');
    ensureColumn(
      database,
      'bug_attachment',
      'verification_feedback_id',
      'TEXT',
    );
    for (const [column, declaration] of [
      ['lease_token', 'TEXT'],
      ['lease_expires_at', 'TEXT'],
      ['completed_at', 'TEXT'],
      ['max_infrastructure_retries', 'INTEGER NOT NULL DEFAULT 2'],
      ['resume_session_id', 'TEXT'],
      ['feedback', 'TEXT'],
      ['source_deployment_batch_id', 'TEXT'],
      ['source_deployed_commit', 'TEXT'],
    ] as const)
      ensureColumn(database, 'repair_dispatch', column, declaration);
    for (const [column, declaration] of [
      ['resume_session_id', 'TEXT'],
      ['feedback', 'TEXT'],
      ['source_deployment_batch_id', 'TEXT'],
      ['source_deployed_commit', 'TEXT'],
    ] as const)
      ensureColumn(database, 'repair_dispatch_member', column, declaration);
    migrateRepairDispatchMemberContext(database);
    migrateRepairAttempt(database);
    ensureColumn(database, 'cleanup_record', 'generation_token', 'TEXT');
    migrateCleanupGeneration(database);
    const attachmentsDirectory =
      options.attachmentsDirectory ??
      (databasePath === ':memory:'
        ? join(process.cwd(), '.tmp-control-plane-attachments')
        : join(dirname(databasePath), 'attachments'));
    await mkdir(attachmentsDirectory, { recursive: true });
    return new ControlPlaneStore(database, {
      ...options,
      attachmentsDirectory,
    });
  }

  status() {
    const projects = this.database
      .query<{ count: number }, []>('SELECT COUNT(*) count FROM project')
      .get()!.count;
    const runners = this.database
      .query<{ count: number }, []>('SELECT COUNT(*) count FROM runner')
      .get()!.count;
    return { status: 'ready' as const, projects, runners };
  }

  createProject(
    raw: CreateProjectCommand,
    key: string,
    actor: Contract.ControlPlaneActor = SYSTEM_ACTOR,
  ): ProjectSummary {
    const input = CreateProjectCommandSchema.parse(raw);
    const ownerUserId = this.projectActorUserId(actor);
    const request = JSON.stringify(input);
    const existing = this.idempotencyRecord('project.create', key, request);
    if (existing) return this.getProject(existing.entity_id, actor);
    const id = randomUUID(),
      now = this.iso();
    try {
      this.database.transaction(() => {
        this.database
          .query(
            'INSERT INTO project(id,slug,title,default_runner_id,created_at,updated_at) VALUES(?,?,?,NULL,?,?)',
          )
          .run(id, input.slug, input.title ?? null, now, now);
        this.database
          .query(
            'INSERT INTO project_member(project_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)',
          )
          .run(id, ownerUserId, 'OWNER', now, now);
        this.appendProjectAudit(
          id,
          ownerUserId,
          'project.created',
          ownerUserId,
          now,
        );
        this.recordIdempotency('project.create', key, request, id, now);
      })();
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed: project.slug'))
        throw createAppError({
          code: ERROR_CODES.projectSlugConflict,
          category: 'conflict',
          message: `项目标识 ${input.slug} 已存在`,
          retryable: false,
        });
      throw error;
    }
    return this.getProject(id, actor);
  }
  listProjects(actor: Contract.ControlPlaneActor = SYSTEM_ACTOR) {
    if (actor.kind === 'user') {
      this.requireDeveloper(actor);
      return this.database
        .query<ProjectRow & { member_role: 'OWNER' | 'DEVELOPER' }, [string]>(
          `SELECT p.id,p.slug,p.title,p.default_runner_id,p.created_at,p.updated_at,m.role member_role
           FROM project p JOIN project_member m ON m.project_id=p.id
           WHERE m.user_id=? ORDER BY p.created_at,p.id`,
        )
        .all(actor.userId)
        .map((row) => this.projectSummary(row, row.member_role));
    }
    return this.database
      .query<ProjectRow, []>(
        `SELECT id,slug,title,default_runner_id,created_at,updated_at FROM project ORDER BY created_at,id`,
      )
      .all()
      .map((row) => this.projectSummary(row, null));
  }
  getProject(
    identifier: string,
    actor: Contract.ControlPlaneActor = SYSTEM_ACTOR,
  ) {
    const row = this.database
      .query<ProjectRow, [string, string]>(
        'SELECT id,slug,title,default_runner_id,created_at,updated_at FROM project WHERE id=? OR slug=? LIMIT 1',
      )
      .get(identifier, identifier);
    if (!row) throw this.notFound('项目不存在');
    if (actor.kind === 'system') return this.projectSummary(row, null);
    this.requireDeveloper(actor);
    const role = this.projectRole(row.id, actor.userId);
    if (!role) throw this.projectPermission('你不是该项目成员');
    return this.projectSummary(row, role);
  }
  renameProject(
    projectId: string,
    title: string,
    actor: Contract.ControlPlaneActor = SYSTEM_ACTOR,
  ) {
    const parsed = RenameProjectCommandSchema.parse({ projectId, title });
    this.requireProjectOwner(projectId, actor);
    const now = this.iso();
    const result = this.database
      .query('UPDATE project SET title=?,updated_at=? WHERE id=?')
      .run(parsed.title, now, projectId);
    if (!result.changes) throw this.notFound('项目不存在');
    return this.getProject(projectId, actor);
  }

  getProjectCollaboration(
    projectId: string,
    actor: Contract.ControlPlaneActor,
  ) {
    this.requireProjectMember(projectId, actor);
    const members = this.database
      .query<ProjectMemberRow, [string]>(
        `SELECT project_id,user_id,role,created_at,updated_at FROM project_member
         WHERE project_id=? ORDER BY CASE role WHEN 'OWNER' THEN 0 ELSE 1 END,created_at,user_id`,
      )
      .all(projectId)
      .map((row) => this.projectMemberSummary(row));
    const invitations = this.database
      .query<ProjectInvitationRow, [string]>(
        `SELECT id,project_id,invitee_user_id,invited_by_user_id,status,created_at,updated_at,resolved_at
         FROM project_invitation WHERE project_id=? ORDER BY created_at,id`,
      )
      .all(projectId)
      .map((row) => this.projectInvitationSummary(row));
    const auditEvents = this.database
      .query<ProjectAuditEventRow, [string]>(
        `SELECT id,project_id,actor_user_id,event_type,subject_user_id,created_at
         FROM project_audit_event WHERE project_id=? ORDER BY rowid`,
      )
      .all(projectId)
      .map((row) => this.projectAuditSummary(row));
    return { members, invitations, auditEvents };
  }

  createProjectInvitation(
    raw: Contract.CreateProjectInvitationCommand,
    key: string,
    actor: Contract.ControlPlaneActor,
  ) {
    const input = Contract.CreateProjectInvitationCommandSchema.parse(raw);
    const ownerUserId = this.requireProjectOwner(input.projectId, actor);
    const request = JSON.stringify(input);
    const existing = this.idempotencyRecord(
      'project.invitation.create',
      key,
      request,
    );
    if (existing) return this.getInvitation(existing.entity_id);
    const invitee = this.registeredUser(input.inviteeUserId);
    if (invitee.accountType !== 'DEVELOPER')
      throw this.projectPermission('只能邀请开发账号加入项目');
    if (invitee.id === ownerUserId)
      throw this.invitationConflict('不能邀请自己加入项目');
    if (this.projectRole(input.projectId, invitee.id))
      throw this.invitationConflict('该开发人员已经是项目成员');
    const id = randomUUID(),
      now = this.iso();
    try {
      this.database.transaction(() => {
        this.database
          .query(
            `INSERT INTO project_invitation(id,project_id,invitee_user_id,invited_by_user_id,status,created_at,updated_at,resolved_at)
             VALUES(?,?,?,?, 'PENDING',?,?,NULL)`,
          )
          .run(id, input.projectId, invitee.id, ownerUserId, now, now);
        this.appendProjectAudit(
          input.projectId,
          ownerUserId,
          'project.invitation_created',
          invitee.id,
          now,
        );
        this.recordIdempotency(
          'project.invitation.create',
          key,
          request,
          id,
          now,
        );
      })();
    } catch (error) {
      if (
        String(error).includes('UNIQUE constraint failed') &&
        String(error).includes('project_invitation')
      )
        throw this.invitationConflict('该开发人员已有待处理邀请');
      throw error;
    }
    return this.getInvitation(id);
  }

  respondProjectInvitation(
    raw: Contract.RespondProjectInvitationCommand,
    key: string,
    actor: Contract.ControlPlaneActor,
  ) {
    const input = Contract.RespondProjectInvitationCommandSchema.parse(raw);
    const userId = this.requireDeveloper(actor);
    const request = JSON.stringify(input);
    const existing = this.idempotencyRecord(
      'project.invitation.respond',
      key,
      request,
    );
    if (existing) return this.getInvitation(existing.entity_id);
    const invitation = this.invitationRow(input.invitationId);
    if (invitation.invitee_user_id !== userId)
      throw this.projectPermission('只有受邀人可以处理该邀请');
    if (invitation.status !== 'PENDING')
      throw this.invitationInvalid('该邀请已经处理，不能重复操作');
    const now = this.iso();
    const status = input.action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
    this.database.transaction(() => {
      this.database
        .query(
          `UPDATE project_invitation SET status=?,updated_at=?,resolved_at=? WHERE id=? AND status='PENDING'`,
        )
        .run(status, now, now, invitation.id);
      if (status === 'ACCEPTED')
        this.database
          .query(
            `INSERT INTO project_member(project_id,user_id,role,created_at,updated_at) VALUES(?,?, 'DEVELOPER',?,?)`,
          )
          .run(invitation.project_id, userId, now, now);
      this.appendProjectAudit(
        invitation.project_id,
        userId,
        status === 'ACCEPTED'
          ? 'project.invitation_accepted'
          : 'project.invitation_rejected',
        userId,
        now,
      );
      this.recordIdempotency(
        'project.invitation.respond',
        key,
        request,
        invitation.id,
        now,
      );
    })();
    return this.getInvitation(invitation.id);
  }

  revokeProjectInvitation(
    raw: Contract.RevokeProjectInvitationCommand,
    key: string,
    actor: Contract.ControlPlaneActor,
  ) {
    const input = Contract.RevokeProjectInvitationCommandSchema.parse(raw);
    const invitation = this.invitationRow(input.invitationId);
    const ownerUserId = this.requireProjectOwner(invitation.project_id, actor);
    const request = JSON.stringify(input);
    const existing = this.idempotencyRecord(
      'project.invitation.revoke',
      key,
      request,
    );
    if (existing) return this.getInvitation(existing.entity_id);
    if (invitation.status !== 'PENDING')
      throw this.invitationInvalid('只有待处理邀请可以撤销');
    const now = this.iso();
    this.database.transaction(() => {
      this.database
        .query(
          `UPDATE project_invitation SET status='REVOKED',updated_at=?,resolved_at=? WHERE id=? AND status='PENDING'`,
        )
        .run(now, now, invitation.id);
      this.appendProjectAudit(
        invitation.project_id,
        ownerUserId,
        'project.invitation_revoked',
        invitation.invitee_user_id,
        now,
      );
      this.recordIdempotency(
        'project.invitation.revoke',
        key,
        request,
        invitation.id,
        now,
      );
    })();
    return this.getInvitation(invitation.id);
  }

  removeProjectMember(
    raw: Contract.RemoveProjectMemberCommand,
    key: string,
    actor: Contract.ControlPlaneActor,
  ) {
    const input = Contract.RemoveProjectMemberCommandSchema.parse(raw);
    const ownerUserId = this.requireProjectOwner(input.projectId, actor);
    const request = JSON.stringify(input);
    const existing = this.idempotencyRecord(
      'project.member.remove',
      key,
      request,
    );
    if (existing) return true;
    const role = this.projectRole(input.projectId, input.userId);
    if (!role) throw this.notFound('项目成员不存在');
    if (role === 'OWNER')
      throw this.memberRemovalBlocked('项目 OWNER 不能被移除');
    const engineeringMembership = this.database
      .query<{ display_name: string }, [string, string]>(
        `SELECT e.display_name FROM engineering_member m
         JOIN engineering e ON e.id=m.engineering_id
         WHERE e.project_id=? AND m.user_id=? LIMIT 1`,
      )
      .get(input.projectId, input.userId);
    if (engineeringMembership)
      throw this.memberRemovalBlocked(
        `${engineeringMembership.display_name} 仍由该开发人员负责或参与，请先完成工程成员交接`,
      );
    const now = this.iso();
    this.database.transaction(() => {
      this.database
        .query('DELETE FROM project_member WHERE project_id=? AND user_id=?')
        .run(input.projectId, input.userId);
      this.appendProjectAudit(
        input.projectId,
        ownerUserId,
        'project.member_removed',
        input.userId,
        now,
      );
      this.recordIdempotency(
        'project.member.remove',
        key,
        request,
        input.userId,
        now,
      );
    })();
    return true;
  }

  listReceivedProjectInvitations(actor: Contract.ControlPlaneActor) {
    const userId = this.requireDeveloper(actor);
    return this.database
      .query<ProjectInvitationRow, [string]>(
        `SELECT id,project_id,invitee_user_id,invited_by_user_id,status,created_at,updated_at,resolved_at
         FROM project_invitation WHERE invitee_user_id=? ORDER BY created_at DESC,id DESC`,
      )
      .all(userId)
      .map((row) => this.projectInvitationSummary(row));
  }

  createEngineering(
    raw: Contract.CreateEngineeringCommand,
    key: string,
    actor: Contract.ControlPlaneActor,
  ) {
    const input = Contract.CreateEngineeringCommandSchema.parse(raw);
    this.requireProjectOwner(input.projectId, actor);
    this.requireEngineeringMembersAreProjectDevelopers(
      input.projectId,
      input.ownerUserId,
      input.memberUserIds,
    );
    const request = JSON.stringify(input);
    const existing = this.idempotencyRecord('engineering.create', key, request);
    if (existing) return this.getEngineering(existing.entity_id, actor);
    const id = randomUUID(),
      now = this.iso();
    try {
      this.database.transaction(() => {
        this.database
          .query(
            `INSERT INTO engineering(id,project_id,slug,display_name,type,repository_url,archived_at,first_referenced_at,created_at,updated_at)
             VALUES(?,?,?,?,?,?,NULL,NULL,?,?)`,
          )
          .run(
            id,
            input.projectId,
            input.slug,
            input.displayName,
            input.type,
            input.repositoryUrl,
            now,
            now,
          );
        this.replaceEngineeringMembers(
          id,
          input.ownerUserId,
          input.memberUserIds,
          now,
        );
        this.replaceEngineeringEnvironments(id, input.environments, now);
        this.recordIdempotency('engineering.create', key, request, id, now);
      })();
    } catch (error) {
      this.rethrowEngineeringConstraint(error, input.slug);
    }
    return this.getEngineering(id, actor);
  }

  listEngineerings(
    projectId: string,
    includeArchived: boolean,
    actor: Contract.ControlPlaneActor,
  ) {
    const userId = this.requireProjectMember(projectId, actor);
    const projectRole = this.projectRole(projectId, userId);
    const rows = this.database
      .query<EngineeringRow, [string]>(
        `SELECT id,project_id,slug,display_name,type,repository_url,archived_at,first_referenced_at,created_at,updated_at
         FROM engineering WHERE project_id=? ORDER BY CASE type WHEN 'FRONTEND' THEN 0 ELSE 1 END,created_at,id`,
      )
      .all(projectId)
      .filter((row) => includeArchived || row.archived_at === null);
    return rows.map((row) =>
      this.engineeringSummary(row, userId, projectRole === 'OWNER'),
    );
  }

  getEngineering(
    engineeringId: string,
    actor: Contract.ControlPlaneActor,
  ): Contract.EngineeringDetail {
    const row = this.engineeringRow(engineeringId);
    const userId = this.requireProjectMember(row.project_id, actor);
    const projectOwner = this.projectRole(row.project_id, userId) === 'OWNER';
    const role = this.engineeringRole(engineeringId, userId);
    if (!projectOwner && !role)
      throw this.engineeringPermission('你不是该工程成员，不能查看技术配置');
    return {
      ...this.engineeringSummary(row, userId, projectOwner),
      repositoryUrl: row.repository_url,
      members: this.engineeringMembers(engineeringId),
      environments: this.engineeringEnvironments(engineeringId),
    };
  }

  updateEngineering(
    raw: Contract.UpdateEngineeringCommand,
    key: string,
    actor: Contract.ControlPlaneActor,
  ) {
    const input = Contract.UpdateEngineeringCommandSchema.parse(raw);
    const row = this.engineeringRow(input.engineeringId);
    this.requireEngineeringManager(row, actor);
    this.requireEngineeringMembersAreProjectDevelopers(
      row.project_id,
      input.ownerUserId,
      input.memberUserIds,
    );
    this.requireEngineeringEnvironmentIds(
      input.engineeringId,
      input.environments,
    );
    if (row.first_referenced_at && row.slug !== input.slug)
      throw this.engineeringReferenced(
        '工程已经被提测引用，稳定标识不能再修改',
      );
    const request = JSON.stringify(input);
    const existing = this.idempotencyRecord('engineering.update', key, request);
    if (existing) return this.getEngineering(existing.entity_id, actor);
    const now = this.iso();
    try {
      this.database.transaction(() => {
        this.database
          .query(
            `UPDATE engineering SET slug=?,display_name=?,type=?,repository_url=?,updated_at=? WHERE id=?`,
          )
          .run(
            input.slug,
            input.displayName,
            input.type,
            input.repositoryUrl,
            now,
            input.engineeringId,
          );
        this.replaceEngineeringMembers(
          input.engineeringId,
          input.ownerUserId,
          input.memberUserIds,
          now,
        );
        this.replaceEngineeringEnvironments(
          input.engineeringId,
          input.environments,
          now,
        );
        this.recordIdempotency(
          'engineering.update',
          key,
          request,
          input.engineeringId,
          now,
        );
      })();
    } catch (error) {
      this.rethrowEngineeringConstraint(error, input.slug);
    }
    return this.getEngineering(input.engineeringId, actor);
  }

  setEngineeringArchived(
    engineeringId: string,
    archived: boolean,
    key: string,
    actor: Contract.ControlPlaneActor,
  ) {
    const row = this.engineeringRow(engineeringId);
    this.requireEngineeringManager(row, actor);
    const input = { engineeringId, archived };
    const request = JSON.stringify(input);
    const existing = this.idempotencyRecord(
      'engineering.archive',
      key,
      request,
    );
    if (existing) return this.engineeringSummaryForActor(engineeringId, actor);
    const now = this.iso();
    this.database.transaction(() => {
      this.database
        .query('UPDATE engineering SET archived_at=?,updated_at=? WHERE id=?')
        .run(archived ? now : null, now, engineeringId);
      this.recordIdempotency(
        'engineering.archive',
        key,
        request,
        engineeringId,
        now,
      );
    })();
    return this.engineeringSummaryForActor(engineeringId, actor);
  }

  deleteEngineering(
    engineeringId: string,
    key: string,
    actor: Contract.ControlPlaneActor,
  ) {
    const input = Contract.DeleteEngineeringCommandSchema.parse({
      engineeringId,
    });
    const request = JSON.stringify(input);
    const existing = this.idempotencyRecord('engineering.delete', key, request);
    if (existing) return true;
    const row = this.engineeringRow(engineeringId);
    this.requireEngineeringManager(row, actor);
    if (row.first_referenced_at)
      throw this.engineeringReferenced(
        '已被提测引用的工程不能删除，请改为归档',
      );
    const now = this.iso();
    this.database.transaction(() => {
      this.database
        .query('DELETE FROM engineering WHERE id=?')
        .run(engineeringId);
      this.recordIdempotency(
        'engineering.delete',
        key,
        request,
        engineeringId,
        now,
      );
    })();
    return true;
  }

  snapshotEngineeringForSubmission(
    engineeringId: string,
    environmentId: string,
    actor: Contract.ControlPlaneActor,
  ): Contract.EngineeringSubmissionSnapshot {
    const row = this.engineeringRow(engineeringId);
    this.requireProjectMember(row.project_id, actor);
    if (row.archived_at)
      throw this.engineeringReferenced('归档工程不能加入新提测单');
    const environment = this.engineeringEnvironments(engineeringId).find(
      (item) => item.id === environmentId,
    );
    if (!environment) throw this.notFound('测试环境不存在');
    const capturedAt = this.iso();
    this.database
      .query(
        'UPDATE engineering SET first_referenced_at=COALESCE(first_referenced_at,?),updated_at=? WHERE id=?',
      )
      .run(capturedAt, capturedAt, engineeringId);
    return Contract.EngineeringSubmissionSnapshotSchema.parse({
      engineeringId,
      slug: row.slug,
      displayName: row.display_name,
      type: row.type,
      repositoryUrl: row.repository_url,
      environment: {
        id: environment.id,
        slug: environment.slug,
        displayName: environment.displayName,
        deploymentType: environment.deploymentType,
        localScriptCommand: environment.localScriptCommand,
        manualConfirmationRequired: environment.manualConfirmationRequired,
      },
      capturedAt,
    });
  }

  createEngineeringBindingTicket(
    engineeringId: string,
    actor: Contract.ControlPlaneActor,
  ) {
    const row = this.engineeringRow(engineeringId);
    if (row.archived_at)
      throw this.engineeringBindingInvalid('归档工程不能创建新绑定');
    const userId = this.requireProjectMember(row.project_id, actor);
    if (!this.engineeringRole(engineeringId, userId))
      throw this.engineeringPermission('只有工程成员可以绑定自己的 Agent');
    const existingBinding = this.database
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM engineering_binding WHERE engineering_id=? AND developer_user_id=?',
      )
      .get(engineeringId, userId);
    if (existingBinding)
      throw this.engineeringBindingConflict(
        '你已经绑定该工程的 Agent，绑定后不能更换',
      );
    const id = randomUUID();
    const ticket = `${id}.${randomBytes(32).toString('base64url')}`;
    const now = this.iso();
    const expiresAt = new Date(Date.parse(now) + 10 * 60_000).toISOString();
    this.database
      .query(
        `INSERT INTO engineering_binding_ticket(id,token_hash,engineering_id,developer_user_id,expires_at,consumed_at,created_at)
         VALUES(?,?,?,?,?,NULL,?)`,
      )
      .run(
        id,
        this.bindingTicketHash(ticket),
        engineeringId,
        userId,
        expiresAt,
        now,
      );
    return { ticket, expiresAt };
  }

  claimEngineeringBinding(raw: Contract.ClaimEngineeringBindingCommand) {
    const input = Contract.ClaimEngineeringBindingCommandSchema.parse(raw);
    const ticket = this.database
      .query<EngineeringBindingTicketRow, [string]>(
        `SELECT id,engineering_id,developer_user_id,expires_at,consumed_at
         FROM engineering_binding_ticket WHERE token_hash=?`,
      )
      .get(this.bindingTicketHash(input.ticket));
    if (!ticket || ticket.consumed_at)
      throw this.engineeringBindingInvalid('工程绑定票据无效或已经使用');
    const now = this.iso();
    if (Date.parse(ticket.expires_at) <= Date.parse(now))
      throw this.engineeringBindingInvalid('工程绑定票据已经过期');
    const engineering = this.engineeringRow(ticket.engineering_id);
    if (engineering.archived_at)
      throw this.engineeringBindingInvalid('归档工程不能创建新绑定');
    if (!this.engineeringRole(engineering.id, ticket.developer_user_id))
      throw this.engineeringBindingInvalid('开发人员已经不再属于该工程');

    const existingBinding = this.database
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM engineering_binding WHERE engineering_id=? AND developer_user_id=?',
      )
      .get(ticket.engineering_id, ticket.developer_user_id);
    if (existingBinding)
      throw this.engineeringBindingConflict(
        '你已经绑定该工程的 Agent，绑定后不能更换',
      );
    const existingRunner = this.database
      .query<{ owner_user_id: string | null }, [string]>(
        'SELECT owner_user_id FROM runner WHERE id=?',
      )
      .get(input.runnerId);
    if (
      existingRunner?.owner_user_id &&
      existingRunner.owner_user_id !== ticket.developer_user_id
    )
      throw this.engineeringBindingConflict('该 Agent 已经属于另一名开发人员');
    const bindingId = randomUUID();
    const repositoryName =
      input.repositoryName ?? repositoryNameFromUrl(engineering.repository_url);
    this.database.transaction(() => {
      this.database
        .query(
          `INSERT INTO runner(id,name,last_seen_at,created_at,updated_at,owner_user_id) VALUES(?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at,owner_user_id=COALESCE(runner.owner_user_id,excluded.owner_user_id)`,
        )
        .run(
          input.runnerId,
          input.runnerName,
          now,
          now,
          now,
          ticket.developer_user_id,
        );
      this.database
        .query(
          `INSERT INTO engineering_binding(id,engineering_id,developer_user_id,runner_id,repository_name,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          bindingId,
          ticket.engineering_id,
          ticket.developer_user_id,
          input.runnerId,
          repositoryName,
          now,
          now,
        );
      this.database
        .query('UPDATE engineering_binding_ticket SET consumed_at=? WHERE id=?')
        .run(now, ticket.id);
    })();
    return this.engineeringBindingSummary(bindingId);
  }

  listEngineeringBindings(
    engineeringId: string,
    actor: Contract.ControlPlaneActor,
  ) {
    const engineering = this.engineeringRow(engineeringId);
    const userId = this.requireProjectMember(engineering.project_id, actor);
    if (
      this.projectRole(engineering.project_id, userId) !== 'OWNER' &&
      !this.engineeringRole(engineeringId, userId)
    )
      throw this.engineeringPermission('你不能查看该工程的 Agent 绑定');
    return this.database
      .query<EngineeringBindingRow, [string]>(
        `SELECT id,engineering_id,developer_user_id,runner_id,repository_name,created_at,updated_at
         FROM engineering_binding WHERE engineering_id=? ORDER BY created_at,id`,
      )
      .all(engineeringId)
      .map((row) => this.engineeringBindingSummary(row.id));
  }

  registerRunner(raw: RegisterRunnerCommand) {
    const input = RegisterRunnerCommandSchema.parse(raw),
      now = this.iso();
    this.database
      .query(
        `INSERT INTO runner(id,name,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
      )
      .run(input.runnerId, input.name, now, now, now);
    return this.getRunner(input.runnerId);
  }
  heartbeatRunner(runnerId: string) {
    const now = this.iso();
    const result = this.database
      .query('UPDATE runner SET last_seen_at=?,updated_at=? WHERE id=?')
      .run(now, now, runnerId);
    if (!result.changes) throw this.notFound('Runner 不存在');
    return this.getRunner(runnerId);
  }
  setProjectDefaultRunner(
    projectId: string,
    runnerId: string,
    actor: Contract.ControlPlaneActor = SYSTEM_ACTOR,
  ) {
    this.requireProjectOwner(projectId, actor);
    this.getRunner(runnerId);
    const now = this.iso();
    const result = this.database
      .query('UPDATE project SET default_runner_id=?,updated_at=? WHERE id=?')
      .run(runnerId, now, projectId);
    if (!result.changes) throw this.notFound('项目不存在');
    return this.getProject(projectId, actor);
  }

  async createBug(raw: CreateBugCommand, key: string): Promise<BugDetail> {
    const input = CreateBugCommandSchema.parse(raw),
      request = JSON.stringify(input);
    const existing = this.idempotencyRecord('bug.create', key, request);
    if (existing) return this.getBug(existing.entity_id);
    this.getProject(input.projectId);
    const prepared = input.attachments.map((a) => ({
      input: a,
      id: randomUUID(),
      content: decodeBugAttachment(a),
    }));
    const id = randomUUID(),
      now = this.iso();
    const written: string[] = [];
    try {
      for (const a of prepared) {
        const storageKey = join(
          id,
          `${a.id}-${safeAttachmentName(a.input.fileName)}`,
        );
        const path = join(this.attachmentsDirectory, storageKey);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, a.content, { mode: 0o600, flag: 'wx' });
        written.push(path);
      }
      this.database.transaction(() => {
        this.database
          .query(
            `INSERT INTO bug(id,project_id,status,repair_state,repair_dispatch_id,deployment_batch_id,deployment_state,title,environment,operation_path,actual_result,expected_result,supplemental_description,created_at,updated_at) VALUES(?,?,'waiting_for_repair',NULL,NULL,NULL,NULL,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.projectId,
            input.title,
            '',
            input.operationPath,
            input.actualResult,
            input.expectedResult,
            input.supplementalDescription ?? null,
            now,
            now,
          );
        for (const a of prepared)
          this.database
            .query(
              `INSERT INTO bug_attachment(id,bug_id,verification_feedback_id,file_name,media_type,size_bytes,storage_key,created_at) VALUES(?,?,NULL,?,?,?,?,?)`,
            )
            .run(
              a.id,
              id,
              a.input.fileName,
              a.input.mediaType,
              a.input.sizeBytes,
              join(id, `${a.id}-${safeAttachmentName(a.input.fileName)}`),
              now,
            );
        this.appendBugEvent(id, 'bug.created', now);
        this.recordIdempotency('bug.create', key, request, id, now);
      })();
    } catch (error) {
      await Promise.all(
        written.map((path) => rm(path, { force: true }).catch(() => undefined)),
      );
      throw error;
    }
    return this.getBug(id);
  }
  listBugs(projectId: string) {
    this.getProject(projectId);
    return this.database
      .query<BugRow, [string]>(
        `${BUG_SELECT} WHERE project_id=? ORDER BY sequence`,
      )
      .all(projectId)
      .map((r) => this.bugSummary(r));
  }
  getBug(bugId: string): BugDetail {
    const row = this.getBugRow(bugId);
    const attachments = this.attachmentRows(bugId, null).map((r) =>
      this.attachmentMetadata(r),
    );
    const events = this.database
      .query<EventRow, [string]>(
        'SELECT id,bug_id,event_type,created_at FROM bug_event WHERE bug_id=? ORDER BY created_at,rowid',
      )
      .all(bugId)
      .map((e) => ({
        id: e.id,
        bugId: e.bug_id,
        type: e.event_type,
        createdAt: e.created_at,
      }));
    const attempts = this.database
      .query<RepairAttemptRow, [string]>(
        `${REPAIR_ATTEMPT_SELECT} WHERE bug_id=? ORDER BY created_at,rowid`,
      )
      .all(bugId)
      .map((r) => this.repairAttemptSummary(r));
    const feedbacks = this.database
      .query<
        {
          id: string;
          bug_id: string;
          deployment_batch_id: string;
          feedback: string;
          deployed_commit: string;
          created_at: string;
        },
        [string]
      >(
        'SELECT id,bug_id,deployment_batch_id,feedback,deployed_commit,created_at FROM verification_feedback WHERE bug_id=? ORDER BY created_at,rowid',
      )
      .all(bugId)
      .map((f) => ({
        id: f.id,
        bugId: f.bug_id,
        deploymentBatchId: f.deployment_batch_id,
        feedback: f.feedback,
        deployedCommit: f.deployed_commit,
        attachments: this.attachmentRows(bugId, f.id).map((a) =>
          this.attachmentMetadata(a),
        ),
        createdAt: f.created_at,
      }));
    return {
      ...this.bugSummary(row),
      canReopenRepair:
        row.status === 'done' && this.hasSuccessfulCleanup('bug', bugId),
      operationPath: row.operation_path,
      actualResult: row.actual_result,
      expectedResult: row.expected_result,
      supplementalDescription: row.supplemental_description,
      attachments,
      events,
      repairAttempt: attempts.at(-1) ?? null,
      repairAttempts: attempts,
      verificationFeedbacks: feedbacks,
    };
  }
  async getBugAttachment(id: string) {
    const row = this.database
      .query<AttachmentRow, [string]>(
        'SELECT id,bug_id,verification_feedback_id,file_name,media_type,size_bytes,storage_key,created_at FROM bug_attachment WHERE id=?',
      )
      .get(id);
    if (!row) throw this.notFound('附件不存在');
    return {
      attachment: this.attachmentMetadata(row),
      contentBase64: (
        await readFile(join(this.attachmentsDirectory, row.storage_key))
      ).toString('base64'),
    };
  }

  enqueueBugForRepair(bugId: string, key: string) {
    return this.enqueueRepairInternal(
      bugId,
      key,
      'bug.repair.enqueue',
      null,
      null,
      null,
      false,
    );
  }
  continueBugRepair(
    input: { bugId: string; feedback: string; reassign: boolean },
    key: string,
  ) {
    const bug = this.getBugRow(input.bugId);
    const reopening =
      bug.status === 'done' && this.hasSuccessfulCleanup('bug', input.bugId);
    if (
      !reopening &&
      (bug.status !== 'repairing' ||
        !['needs_input', 'blocked', 'failed', 'cancelled'].includes(
          bug.repair_state ?? '',
        ))
    )
      throw this.transitionInvalid('该 Bug 当前不需要继续修复');
    const latest = this.latestRepairAttemptRow(input.bugId);
    const resume =
      reopening || input.reassign ? null : (latest?.session_id ?? null);
    return this.enqueueRepairInternal(
      input.bugId,
      key,
      'bug.repair.continue',
      input.feedback,
      resume,
      bug.deployment_batch_id
        ? this.deployedCommitForBatch(bug.deployment_batch_id)
        : null,
      true,
    );
  }

  private hasSuccessfulCleanup(kind: 'bug' | 'deployment', id: string) {
    const cleanup = this.latestSuccessfulCleanup(kind, id);
    return Boolean(
      cleanup?.generation_token &&
      cleanup.generation_token === this.executionGenerationToken(kind, id),
    );
  }
  private enqueueRepairInternal(
    bugId: string,
    key: string,
    operation: string,
    feedback: string | null,
    resumeSession: string | null,
    sourceCommit: string | null,
    continuation: boolean,
  ) {
    const request = JSON.stringify({
      bugId,
      feedback,
      resumeSession: continuation ? undefined : resumeSession,
      continuation,
    });
    const existing = this.idempotencyRecord(operation, key, request);
    if (existing) {
      const bug = this.getBugRow(bugId);
      return {
        bug: this.bugSummary(bug),
        dispatch: this.getRepairDispatch(existing.entity_id),
      };
    }
    const now = this.iso();
    let dispatchId = '';
    this.database.transaction(() => {
      dispatchId = this.enqueueRepairMutation({
        bugId,
        key,
        operation,
        request,
        feedback,
        resumeSession,
        sourceCommit,
        continuation,
        now,
      });
    })();
    return {
      bug: this.bugSummary(this.getBugRow(bugId)),
      dispatch: this.getRepairDispatch(dispatchId),
    };
  }
  private enqueueRepairMutation(input: {
    bugId: string;
    key: string;
    operation: string;
    request: string;
    feedback: string | null;
    resumeSession: string | null;
    sourceCommit: string | null;
    continuation: boolean;
    now: string;
  }) {
    this.closeExpiredRepairDispatches(input.now);
    const bug = this.getBugRow(input.bugId);
    if (
      !input.continuation &&
      bug.status === 'repairing' &&
      bug.repair_dispatch_id
    ) {
      this.recordIdempotency(
        input.operation,
        input.key,
        input.request,
        bug.repair_dispatch_id,
        input.now,
      );
      return bug.repair_dispatch_id;
    }
    if (!input.continuation && bug.status !== 'waiting_for_repair')
      throw this.transitionInvalid('该 Bug 不能加入修复收集');
    const project = this.projectRow(bug.project_id);
    if (!project.default_runner_id)
      throw createAppError({
        code: ERROR_CODES.repairDispatchUnavailable,
        category: 'conflict',
        message: '项目尚未绑定默认 Runner',
        retryable: false,
      });
    let dispatchId = this.database
      .query<RepairDispatchRow, [string]>(
        `${REPAIR_DISPATCH_SELECT} WHERE project_id=? AND state='collecting' LIMIT 1`,
      )
      .get(bug.project_id)?.id;
    if (!dispatchId) {
      dispatchId = randomUUID();
      const closesAt = new Date(
        this.now().getTime() + this.repairDispatchConfig.delayMs,
      ).toISOString();
      this.database
        .query(
          `INSERT INTO repair_dispatch(id,project_id,runner_id,state,closes_at,max_bugs,delay_ms,max_infrastructure_retries,resume_session_id,feedback,source_deployment_batch_id,source_deployed_commit,created_at,updated_at) VALUES(?,?,?,'collecting',?,?,?,?,NULL,NULL,NULL,NULL,?,?)`,
        )
        .run(
          dispatchId,
          bug.project_id,
          project.default_runner_id,
          closesAt,
          this.repairDispatchConfig.maxBugs,
          this.repairDispatchConfig.delayMs,
          this.repairInfrastructureRetries,
          input.now,
          input.now,
        );
    }
    const position = this.database
      .query<{ position: number }, [string]>(
        'SELECT COALESCE(MAX(position),0)+1 position FROM repair_dispatch_member WHERE dispatch_id=?',
      )
      .get(dispatchId)!.position;
    this.database
      .query(
        `INSERT INTO repair_dispatch_member(dispatch_id,bug_id,position,created_at,removed_at,resume_session_id,feedback,source_deployment_batch_id,source_deployed_commit) VALUES(?,?,?,?,NULL,?,?,?,?) ON CONFLICT(dispatch_id,bug_id) DO UPDATE SET removed_at=NULL,resume_session_id=excluded.resume_session_id,feedback=excluded.feedback,source_deployment_batch_id=excluded.source_deployment_batch_id,source_deployed_commit=excluded.source_deployed_commit`,
      )
      .run(
        dispatchId,
        input.bugId,
        position,
        input.now,
        input.resumeSession,
        input.feedback,
        bug.deployment_batch_id,
        input.sourceCommit,
      );
    this.database
      .query(
        `UPDATE bug SET status='repairing',repair_state='collecting',repair_dispatch_id=?,deployment_batch_id=NULL,deployment_state=NULL,updated_at=? WHERE id=?`,
      )
      .run(dispatchId, input.now, input.bugId);
    this.appendBugEvent(input.bugId, 'bug.repair_enqueued', input.now);
    const dispatch = this.getRepairDispatchRow(dispatchId);
    if (this.activeRepairMemberCount(dispatchId) >= dispatch.max_bugs)
      this.queueRepairDispatch(dispatchId, input.now);
    this.recordIdempotency(
      input.operation,
      input.key,
      input.request,
      dispatchId,
      input.now,
    );
    return dispatchId;
  }
  returnBugToWaiting(bugId: string, key: string) {
    const request = JSON.stringify({ bugId }),
      existing = this.idempotencyRecord('bug.repair.return', key, request);
    if (existing) {
      const bug = this.getBugRow(bugId);
      return {
        bug: this.bugSummary(bug),
        dispatch: bug.repair_dispatch_id
          ? this.tryRepairDispatch(bug.repair_dispatch_id)
          : null,
      };
    }
    const now = this.iso();
    let remaining: string | null = null;
    this.database.transaction(() => {
      const bug = this.getBugRow(bugId);
      if (bug.status === 'waiting_for_repair') {
      } else {
        if (bug.status !== 'repairing' || !bug.repair_dispatch_id)
          throw this.transitionInvalid('该 Bug 不能移回待修复');
        const d = this.getRepairDispatchRow(bug.repair_dispatch_id);
        if (!['collecting', 'queued'].includes(d.state))
          throw this.transitionInvalid('已被 Runner 领取的 Bug 不能直接移回');
        this.database
          .query(
            'UPDATE repair_dispatch_member SET removed_at=? WHERE dispatch_id=? AND bug_id=? AND removed_at IS NULL',
          )
          .run(now, d.id, bugId);
        this.database
          .query(
            `UPDATE bug SET status='waiting_for_repair',repair_state=NULL,repair_dispatch_id=NULL,updated_at=? WHERE id=?`,
          )
          .run(now, bugId);
        this.appendBugEvent(bugId, 'bug.repair_returned', now);
        if (this.activeRepairMemberCount(d.id) === 0)
          this.database
            .query(
              `UPDATE repair_dispatch SET state='cancelled',updated_at=? WHERE id=?`,
            )
            .run(now, d.id);
        else remaining = d.id;
      }
      this.recordIdempotency('bug.repair.return', key, request, bugId, now);
    })();
    return {
      bug: this.bugSummary(this.getBugRow(bugId)),
      dispatch: remaining ? this.getRepairDispatch(remaining) : null,
    };
  }
  closeRepairDispatch(id: string, key: string) {
    return this.idempotentBatch(
      'repair_dispatch.close',
      key,
      { dispatchId: id },
      id,
      () => {
        const now = this.iso(),
          d = this.getRepairDispatchRow(id);
        if (d.state === 'cancelled')
          throw this.transitionInvalid('空修复收集不能立即修复');
        if (d.state === 'collecting') this.queueRepairDispatch(id, now);
        return this.getRepairDispatch(id);
      },
      () => this.getRepairDispatch(id),
    );
  }
  listRepairDispatches(projectId: string) {
    this.getProject(projectId);
    this.closeExpiredRepairDispatches(this.iso());
    return this.database
      .query<RepairDispatchRow, [string]>(
        `${REPAIR_DISPATCH_SELECT} WHERE project_id=? AND state IN ('collecting','queued','claimed') ORDER BY sequence`,
      )
      .all(projectId)
      .map((r) => this.repairDispatchSummary(r));
  }
  claimRepairDispatch(runnerId: string) {
    this.getRunner(runnerId);
    const now = this.iso();
    this.recoverExpiredRepairClaims(now);
    let row = this.database
      .query<RepairDispatchRow, [string]>(
        `${REPAIR_DISPATCH_SELECT} WHERE runner_id=? AND state='claimed' LIMIT 1`,
      )
      .get(runnerId);
    if (!row) {
      row = this.database
        .query<RepairDispatchRow, [string]>(
          `${REPAIR_DISPATCH_SELECT} WHERE runner_id=? AND state='queued' ORDER BY queued_at,sequence LIMIT 1`,
        )
        .get(runnerId);
      if (row)
        this.database
          .query(
            `UPDATE repair_dispatch SET state='claimed',claimed_at=?,updated_at=? WHERE id=?`,
          )
          .run(now, now, row.id);
    }
    return row
      ? this.repairDispatchSummary(this.getRepairDispatchRow(row.id))
      : null;
  }
  acquireRepairDispatch(runnerId: string): RepairDispatchClaim | null {
    const dispatch = this.claimRepairDispatch(runnerId);
    if (!dispatch) return null;
    const now = this.iso(),
      token = randomBytes(24).toString('base64url'),
      expires = new Date(
        this.now().getTime() + this.repairLeaseDurationMs,
      ).toISOString();
    this.database.transaction(() => {
      this.database
        .query(
          'UPDATE repair_dispatch SET lease_token=?,lease_expires_at=?,updated_at=? WHERE id=?',
        )
        .run(token, expires, now, dispatch.id);
      for (const bug of dispatch.members) {
        const exists = this.database
          .query<{ count: number }, [string, string]>(
            'SELECT COUNT(*) count FROM repair_attempt WHERE dispatch_id=? AND bug_id=?',
          )
          .get(dispatch.id, bug.id)!.count;
        if (!exists) this.createRepairAttempt(dispatch.id, bug.id, 0, now);
      }
    })();
    return {
      dispatch: this.getRepairDispatch(dispatch.id),
      leaseToken: token,
      leaseExpiresAt: expires,
      items: this.repairWorkItems(dispatch.id),
    };
  }
  renewRepairDispatchLease(input: {
    runnerId: string;
    dispatchId: string;
    leaseToken: string;
  }) {
    this.assertRepairLease(input);
    const expires = new Date(
      this.now().getTime() + this.repairLeaseDurationMs,
    ).toISOString();
    this.database
      .query(
        'UPDATE repair_dispatch SET lease_expires_at=?,updated_at=? WHERE id=?',
      )
      .run(expires, this.iso(), input.dispatchId);
    return expires;
  }
  startRepairAttempt(input: {
    runnerId: string;
    dispatchId: string;
    attemptId: string;
    leaseToken: string;
  }) {
    this.assertRepairLease(input);
    const a = this.getRepairAttemptRow(input.attemptId);
    if (a.dispatch_id !== input.dispatchId || a.runner_id !== input.runnerId)
      throw this.transitionInvalid('修复尝试不属于当前 Runner');
    if (a.state === 'running')
      return {
        attempt: this.repairAttemptSummary(a),
        bug: this.bugSummary(this.getBugRow(a.bug_id)),
      };
    if (a.state !== 'pending') throw this.transitionInvalid('修复尝试不能开始');
    const now = this.iso();
    this.database.transaction(() => {
      this.database
        .query(
          `UPDATE repair_attempt SET state='running',started_at=? WHERE id=?`,
        )
        .run(now, a.id);
      this.database
        .query(`UPDATE bug SET repair_state=?,updated_at=? WHERE id=?`)
        .run(a.retry_number ? 'retrying' : 'running', now, a.bug_id);
      this.appendBugEvent(a.bug_id, 'bug.repair_started', now);
    })();
    return {
      attempt: this.repairAttemptSummary(this.getRepairAttemptRow(a.id)),
      bug: this.bugSummary(this.getBugRow(a.bug_id)),
    };
  }
  finishRepairAttempt(input: {
    runnerId: string;
    dispatchId: string;
    attemptId: string;
    leaseToken: string;
    outcome: RepairAttemptOutcome;
  }) {
    let a = this.getRepairAttemptRow(input.attemptId);
    if (a.dispatch_id !== input.dispatchId || a.runner_id !== input.runnerId)
      throw this.transitionInvalid('修复尝试不属于当前 Runner');
    if (
      ['ready', 'needs_input', 'blocked', 'failed', 'cancelled'].includes(
        a.state,
      )
    ) {
      const next = this.database
        .query<RepairAttemptRow, [string, string, number]>(
          `${REPAIR_ATTEMPT_SELECT} WHERE dispatch_id=? AND bug_id=? AND retry_number=? AND state='pending' ORDER BY created_at,rowid LIMIT 1`,
        )
        .get(a.dispatch_id, a.bug_id, a.retry_number + 1);
      return {
        attempt: this.repairAttemptSummary(a),
        bug: this.bugSummary(this.getBugRow(a.bug_id)),
        dispatchCompleted:
          this.getRepairDispatchRow(input.dispatchId).state === 'completed',
        retryItem: next ? this.repairWorkItem(next) : null,
      };
    }
    this.assertRepairFinishLease(input);
    if (a.state !== 'running') throw this.transitionInvalid('修复尝试尚未开始');
    const now = this.iso();
    let retryItem: RepairWorkItem | null = null;
    this.database.transaction(() => {
      if (
        input.outcome.kind === 'execution_failure' &&
        a.retry_number < a.max_infrastructure_retries &&
        !a.cancel_requested
      ) {
        this.database
          .query(
            `UPDATE repair_attempt SET state='failed',session_id=?,failure_message=?,finished_at=? WHERE id=?`,
          )
          .run(input.outcome.sessionId, input.outcome.message, now, a.id);
        const nextId = this.createRepairAttempt(
          a.dispatch_id,
          a.bug_id,
          a.retry_number + 1,
          now,
          input.outcome.sessionId,
        );
        this.database
          .query(
            `UPDATE bug SET repair_state='retrying',updated_at=? WHERE id=?`,
          )
          .run(now, a.bug_id);
        const expires = new Date(
          this.now().getTime() + this.repairLeaseDurationMs,
        ).toISOString();
        this.database
          .query(
            `UPDATE repair_dispatch SET lease_expires_at=?,updated_at=? WHERE id=?`,
          )
          .run(expires, now, input.dispatchId);
        retryItem = this.repairWorkItem(this.getRepairAttemptRow(nextId));
      } else {
        const result =
          input.outcome.kind === 'result' ? input.outcome.result : null;
        const state: RepairAttemptState =
          input.outcome.kind === 'cancelled'
            ? 'cancelled'
            : input.outcome.kind === 'execution_failure'
              ? 'failed'
              : result!.status;
        const failure =
          input.outcome.kind === 'execution_failure' ||
          input.outcome.kind === 'cancelled'
            ? input.outcome.message
            : result!.status === 'ready'
              ? null
              : result!.reason;
        this.database
          .query(
            `UPDATE repair_attempt SET state=?,session_id=?,result_json=?,failure_message=?,finished_at=? WHERE id=?`,
          )
          .run(
            state,
            input.outcome.sessionId,
            result ? JSON.stringify(result) : null,
            failure,
            now,
            a.id,
          );
        const ready = state === 'ready';
        this.database
          .query(
            `UPDATE bug SET status=?,repair_state=?,updated_at=? WHERE id=?`,
          )
          .run(
            ready ? 'repair_ready' : 'repairing',
            ready ? null : state,
            now,
            a.bug_id,
          );
        const event = ready
          ? 'bug.repair_ready'
          : state === 'needs_input'
            ? 'bug.repair_needs_input'
            : state === 'blocked'
              ? 'bug.repair_blocked'
              : state === 'cancelled'
                ? 'bug.repair_cancelled'
                : 'bug.repair_failed';
        this.appendBugEvent(a.bug_id, event, now);
      }
    })();
    const remaining = this.database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) count FROM repair_attempt WHERE dispatch_id=? AND state IN ('pending','running')`,
      )
      .get(input.dispatchId)!.count;
    const completed = remaining === 0;
    if (completed)
      this.database
        .query(
          `UPDATE repair_dispatch SET state='completed',completed_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`,
        )
        .run(now, now, input.dispatchId);
    a = this.getRepairAttemptRow(input.attemptId);
    return {
      attempt: this.repairAttemptSummary(a),
      bug: this.bugSummary(this.getBugRow(a.bug_id)),
      dispatchCompleted: completed,
      retryItem,
    };
  }
  cancelRepairAttempt(bugId: string, key: string) {
    const request = JSON.stringify({ bugId }),
      existing = this.idempotencyRecord('repair_attempt.cancel', key, request);
    if (existing) {
      const a = this.getRepairAttemptRow(existing.entity_id);
      return {
        attempt: this.repairAttemptSummary(a),
        bug: this.bugSummary(this.getBugRow(bugId)),
      };
    }
    const a = this.latestRepairAttemptRow(bugId);
    if (!a || a.state !== 'running')
      throw this.transitionInvalid('该 Bug 没有运行中的修复');
    const now = this.iso();
    this.database
      .query('UPDATE repair_attempt SET cancel_requested=1 WHERE id=?')
      .run(a.id);
    this.recordIdempotency('repair_attempt.cancel', key, request, a.id, now);
    return {
      attempt: this.repairAttemptSummary(this.getRepairAttemptRow(a.id)),
      bug: this.bugSummary(this.getBugRow(bugId)),
    };
  }
  repairAttemptControl(input: { attemptId: string; runnerId: string }) {
    const a = this.getRepairAttemptRow(input.attemptId);
    return {
      cancelRequested: Boolean(
        a.runner_id === input.runnerId &&
        a.state === 'running' &&
        a.cancel_requested,
      ),
    };
  }

  enqueueBugForDeployment(bugId: string, key: string) {
    const request = JSON.stringify({ bugId }),
      existing = this.idempotencyRecord('bug.deployment.enqueue', key, request);
    if (existing)
      return {
        bug: this.bugSummary(this.getBugRow(bugId)),
        batch: this.getDeploymentBatch(existing.entity_id),
      };
    const now = this.iso();
    let batchId = '';
    this.database.transaction(() => {
      this.closeExpiredDeploymentBatches(now);
      const bug = this.getBugRow(bugId);
      if (bug.status === 'deploying' && bug.deployment_batch_id) {
        batchId = bug.deployment_batch_id;
        return;
      }
      if (bug.status !== 'repair_ready')
        throw this.transitionInvalid('该 Bug 尚未修复就绪');
      const ready = this.latestReadyAttempt(bugId);
      const candidate = (
        ready.result_json
          ? RepairResultSchema.parse(JSON.parse(ready.result_json))
          : null
      )?.candidateCommit;
      if (!candidate) throw this.transitionInvalid('Bug 缺少候选提交');
      let batch = this.database
        .query<DeploymentBatchRow, [string]>(
          `${DEPLOYMENT_BATCH_SELECT} WHERE project_id=? AND state='collecting' LIMIT 1`,
        )
        .get(bug.project_id);
      if (batch && batch.runner_id !== ready.runner_id)
        throw this.transitionInvalid('同一部署批次只能包含同 Runner 的 Bug');
      if (!batch) {
        const id = randomUUID(),
          closes = new Date(
            this.now().getTime() + this.deploymentBatchConfig.delayMs,
          ).toISOString();
        this.database
          .query(
            `INSERT INTO deployment_batch(id,project_id,runner_id,state,closes_at,max_bugs,delay_ms,created_at,updated_at) VALUES(?,?,?,'collecting',?,?,?,?,?)`,
          )
          .run(
            id,
            bug.project_id,
            ready.runner_id,
            closes,
            this.deploymentBatchConfig.maxBugs,
            this.deploymentBatchConfig.delayMs,
            now,
            now,
          );
        batch = this.getDeploymentBatchRow(id);
      }
      batchId = batch.id;
      const pos = this.database
        .query<{ position: number }, [string]>(
          'SELECT COALESCE(MAX(position),0)+1 position FROM deployment_batch_member WHERE batch_id=?',
        )
        .get(batchId)!.position;
      this.database
        .query(
          `INSERT INTO deployment_batch_member(batch_id,bug_id,candidate_commit,position,created_at) VALUES(?,?,?,?,?) ON CONFLICT(batch_id,bug_id) DO NOTHING`,
        )
        .run(batchId, bugId, candidate, pos, now);
      this.database
        .query(
          `UPDATE bug SET status='deploying',deployment_batch_id=?,deployment_state='collecting',repair_dispatch_id=NULL,repair_state=NULL,updated_at=? WHERE id=?`,
        )
        .run(batchId, now, bugId);
      this.appendBugEvent(bugId, 'bug.deployment_enqueued', now);
      if (this.deploymentMemberCount(batchId) >= batch.max_bugs)
        this.queueDeploymentBatch(batchId, now);
      this.recordIdempotency(
        'bug.deployment.enqueue',
        key,
        request,
        batchId,
        now,
      );
    })();
    return {
      bug: this.bugSummary(this.getBugRow(bugId)),
      batch: this.getDeploymentBatch(batchId),
    };
  }
  closeDeploymentBatch(id: string, key: string) {
    return this.idempotentBatch(
      'deployment_batch.close',
      key,
      { batchId: id },
      id,
      () => {
        const b = this.getDeploymentBatchRow(id);
        if (b.state === 'collecting') this.queueDeploymentBatch(id, this.iso());
        return this.getDeploymentBatch(id);
      },
      () => this.getDeploymentBatch(id),
    );
  }
  listDeploymentBatches(projectId: string) {
    this.getProject(projectId);
    this.closeExpiredDeploymentBatches(this.iso());
    return this.database
      .query<DeploymentBatchRow, [string]>(
        `${DEPLOYMENT_BATCH_SELECT} WHERE project_id=? AND state!='cancelled' ORDER BY sequence DESC`,
      )
      .all(projectId)
      .map((r) => this.deploymentBatchSummary(r));
  }
  acquireDeploymentBatch(runnerId: string): DeploymentWorkClaim | null {
    this.getRunner(runnerId);
    this.closeExpiredDeploymentBatches(this.iso());
    const now = this.iso();
    let batch = this.database
      .query<DeploymentBatchRow, [string]>(
        `${DEPLOYMENT_BATCH_SELECT} WHERE runner_id=? AND state='running' AND lease_token IS NOT NULL LIMIT 1`,
      )
      .get(runnerId);
    if (!batch)
      batch = this.database
        .query<DeploymentBatchRow, [string]>(
          `${DEPLOYMENT_BATCH_SELECT} WHERE runner_id=? AND state='queued' ORDER BY queued_at,sequence LIMIT 1`,
        )
        .get(runnerId);
    if (!batch) return null;
    const token = randomBytes(24).toString('base64url'),
      expires = new Date(
        this.now().getTime() + this.deploymentLeaseDurationMs,
      ).toISOString();
    let attempt = this.latestDeploymentAttemptRow(batch.id);
    if (!attempt || !['pending', 'running'].includes(attempt.state)) {
      const id = randomUUID();
      this.database
        .query(
          `INSERT INTO deployment_attempt(id,batch_id,runner_id,state,created_at) VALUES(?,?,?,'pending',?)`,
        )
        .run(id, batch.id, runnerId, now);
      attempt = this.getDeploymentAttemptRow(id);
    }
    this.database
      .query(
        'UPDATE deployment_batch SET lease_token=?,lease_expires_at=?,updated_at=? WHERE id=?',
      )
      .run(token, expires, now, batch.id);
    batch = this.getDeploymentBatchRow(batch.id);
    return {
      batch: this.deploymentBatchSummary(batch),
      attemptId: attempt.id,
      leaseToken: token,
      leaseExpiresAt: expires,
      prompt: this.renderDeploymentPrompt(batch),
      resumeSessionId: this.previousDeploymentSession(batch.id, attempt.id),
    };
  }
  renewDeploymentLease(input: {
    runnerId: string;
    batchId: string;
    leaseToken: string;
  }) {
    this.assertDeploymentLease(input);
    const expires = new Date(
      this.now().getTime() + this.deploymentLeaseDurationMs,
    ).toISOString();
    this.database
      .query(
        'UPDATE deployment_batch SET lease_expires_at=?,updated_at=? WHERE id=?',
      )
      .run(expires, this.iso(), input.batchId);
    return expires;
  }
  startDeploymentAttempt(input: {
    runnerId: string;
    batchId: string;
    attemptId: string;
    leaseToken: string;
  }) {
    this.assertDeploymentLease(input);
    const a = this.getDeploymentAttemptRow(input.attemptId);
    if (a.batch_id !== input.batchId || a.runner_id !== input.runnerId)
      throw this.transitionInvalid('部署尝试不属于当前 Runner');
    if (a.state === 'pending') {
      const now = this.iso();
      this.database.transaction(() => {
        this.database
          .query(
            `UPDATE deployment_attempt SET state='running',started_at=? WHERE id=?`,
          )
          .run(now, a.id);
        this.database
          .query(
            `UPDATE deployment_batch SET state='running',template_name=?,template_version=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=?`,
          )
          .run(
            this.deploymentTemplate(input.batchId).name,
            this.deploymentTemplate(input.batchId).version,
            now,
            now,
            input.batchId,
          );
        this.database
          .query(
            `UPDATE bug SET deployment_state='running',updated_at=? WHERE deployment_batch_id=?`,
          )
          .run(now, input.batchId);
      })();
    }
    return { batch: this.getDeploymentBatch(input.batchId) };
  }
  finishDeploymentAttempt(input: {
    runnerId: string;
    batchId: string;
    attemptId: string;
    leaseToken: string;
    outcome:
      | { kind: 'result'; sessionId: string | null; result: DeploymentResult }
      | {
          kind: 'execution_failure' | 'cancelled';
          sessionId: string | null;
          message: string;
        };
  }) {
    const a = this.getDeploymentAttemptRow(input.attemptId);
    if (a.batch_id !== input.batchId || a.runner_id !== input.runnerId)
      throw this.transitionInvalid('部署尝试不属于当前 Runner');
    if (a.state !== 'running')
      return { batch: this.getDeploymentBatch(input.batchId) };
    this.assertDeploymentFinishLease(input);
    const now = this.iso();
    let state: DeploymentBatchState,
      summary: string,
      reason: string | null,
      deployed: string | null,
      result: DeploymentResult | null = null;
    if (input.outcome.kind === 'result') {
      result = input.outcome.result;
      state = result.status;
      summary = result.summary;
      reason = result.reason;
      deployed = result.deployedCommit;
    } else if (input.outcome.kind === 'cancelled') {
      state = 'cancelled';
      summary = input.outcome.message;
      reason = input.outcome.message;
      deployed = null;
    } else {
      state = 'failed';
      summary = input.outcome.message;
      reason = input.outcome.message;
      deployed = null;
    }
    this.database.transaction(() => {
      this.database
        .query(
          `UPDATE deployment_attempt SET state=?,session_id=?,result_json=?,failure_message=?,finished_at=? WHERE id=?`,
        )
        .run(
          state,
          input.outcome.sessionId,
          result ? JSON.stringify(result) : null,
          reason,
          now,
          a.id,
        );
      this.database
        .query(
          `UPDATE deployment_batch SET state=?,summary=?,reason=?,deployed_commit=?,finished_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`,
        )
        .run(state, summary, reason, deployed, now, now, input.batchId);
      if (state === 'deployed') {
        this.database
          .query(
            `UPDATE bug SET status='waiting_for_verification',deployment_state=NULL,updated_at=? WHERE deployment_batch_id=?`,
          )
          .run(now, input.batchId);
        for (const { bug_id } of this.database
          .query<{ bug_id: string }, [string]>(
            'SELECT bug_id FROM deployment_batch_member WHERE batch_id=?',
          )
          .all(input.batchId))
          this.appendBugEvent(bug_id, 'bug.deployed', now);
      } else if (state === 'cancelled') {
        this.database
          .query(
            `UPDATE bug SET status='repair_ready',deployment_batch_id=NULL,deployment_state=NULL,updated_at=? WHERE deployment_batch_id=?`,
          )
          .run(now, input.batchId);
        for (const { bug_id } of this.database
          .query<{ bug_id: string }, [string]>(
            'SELECT bug_id FROM deployment_batch_member WHERE batch_id=?',
          )
          .all(input.batchId))
          this.appendBugEvent(bug_id, 'bug.deployment_cancelled', now);
      } else
        this.database
          .query(
            `UPDATE bug SET deployment_state=?,updated_at=? WHERE deployment_batch_id=?`,
          )
          .run(state, now, input.batchId);
    })();
    return { batch: this.getDeploymentBatch(input.batchId) };
  }
  continueDeploymentBatch(
    input: { batchId: string; feedback: string },
    key: string,
  ) {
    return this.idempotentBatch(
      'deployment_batch.continue',
      key,
      input,
      input.batchId,
      () => {
        const b = this.getDeploymentBatchRow(input.batchId);
        if (!['blocked', 'failed', 'unknown'].includes(b.state))
          throw this.transitionInvalid('该部署批次当前不能继续');
        const now = this.iso();
        this.database.transaction(() => {
          this.database
            .query(
              `UPDATE deployment_batch SET state='queued',feedback=?,queued_at=?,finished_at=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`,
            )
            .run(input.feedback, now, now, input.batchId);
          this.database
            .query(
              `UPDATE bug SET deployment_state='queued',updated_at=? WHERE deployment_batch_id=?`,
            )
            .run(now, input.batchId);
        })();
        return this.getDeploymentBatch(input.batchId);
      },
      () => this.getDeploymentBatch(input.batchId),
    );
  }
  cancelDeploymentBatch(id: string, key: string) {
    return this.idempotentBatch(
      'deployment_batch.cancel',
      key,
      { batchId: id },
      id,
      () => {
        const b = this.getDeploymentBatchRow(id),
          now = this.iso();
        if (b.state === 'running') {
          const a = this.latestDeploymentAttemptRow(id);
          if (!a || a.state !== 'running')
            throw this.transitionInvalid('部署运行状态不完整');
          this.database
            .query(
              'UPDATE deployment_attempt SET cancel_requested=1 WHERE id=?',
            )
            .run(a.id);
        } else if (
          ['collecting', 'queued', 'blocked', 'failed', 'unknown'].includes(
            b.state,
          )
        ) {
          this.database.transaction(() => {
            this.database
              .query(
                `UPDATE deployment_batch SET state='cancelled',finished_at=?,updated_at=? WHERE id=?`,
              )
              .run(now, now, id);
            this.database
              .query(
                `UPDATE bug SET status='repair_ready',deployment_batch_id=NULL,deployment_state=NULL,updated_at=? WHERE deployment_batch_id=?`,
              )
              .run(now, id);
            for (const { bug_id } of this.database
              .query<{ bug_id: string }, [string]>(
                'SELECT bug_id FROM deployment_batch_member WHERE batch_id=?',
              )
              .all(id))
              this.appendBugEvent(bug_id, 'bug.deployment_cancelled', now);
          })();
        } else throw this.transitionInvalid('该部署批次不能取消');
        return this.getDeploymentBatch(id);
      },
      () => this.getDeploymentBatch(id),
    );
  }
  deploymentAttemptControl(input: { batchId: string; runnerId: string }) {
    const a = this.latestDeploymentAttemptRow(input.batchId);
    return {
      cancelRequested: Boolean(
        a &&
        a.runner_id === input.runnerId &&
        a.state === 'running' &&
        a.cancel_requested,
      ),
    };
  }

  verifyBugPassed(bugId: string, key: string) {
    return this.idempotentBatch(
      'bug.verify.pass',
      key,
      { bugId },
      bugId,
      () => {
        const bug = this.getBugRow(bugId);
        if (bug.status === 'done') return this.bugSummary(bug);
        if (bug.status !== 'waiting_for_verification')
          throw this.transitionInvalid('该 Bug 当前不能标记验证通过');
        const now = this.iso();
        this.database
          .query(`UPDATE bug SET status='done',updated_at=? WHERE id=?`)
          .run(now, bugId);
        this.appendBugEvent(bugId, 'bug.verification_passed', now);
        return this.bugSummary(this.getBugRow(bugId));
      },
      () => this.bugSummary(this.getBugRow(bugId)),
    );
  }
  async verifyBugFailed(
    input: {
      bugId: string;
      feedback: string;
      attachments: CreateBugCommand['attachments'];
    },
    key: string,
  ) {
    const request = JSON.stringify(input),
      existing = this.idempotencyRecord('bug.verify.fail', key, request);
    if (existing) {
      const bug = this.getBugRow(input.bugId);
      return {
        bug: this.bugSummary(bug),
        dispatch: this.getRepairDispatch(existing.entity_id),
      };
    }
    const bug = this.getBugRow(input.bugId);
    if (bug.status !== 'waiting_for_verification' || !bug.deployment_batch_id)
      throw this.transitionInvalid('该 Bug 当前不能反馈验证失败');
    const deployed = this.deployedCommitForBatch(bug.deployment_batch_id);
    if (!deployed) throw this.transitionInvalid('部署批次缺少 deployed commit');
    const attachmentCount = this.database
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) count FROM bug_attachment WHERE bug_id=?',
      )
      .get(input.bugId)!.count;
    if (attachmentCount + input.attachments.length > 5)
      throw createAppError({
        code: ERROR_CODES.configInvalid,
        category: 'validation',
        message: '每个 Bug 最多只能保留 5 个附件',
        retryable: false,
      });
    const feedbackId = randomUUID(),
      now = this.iso(),
      resumeSession =
        this.latestRepairAttemptRow(input.bugId)?.session_id ?? null;
    const prepared = input.attachments.map((a) => ({
      input: a,
      id: randomUUID(),
      content: decodeBugAttachment(a),
    }));
    const written: string[] = [];
    try {
      for (const a of prepared) {
        const keyPath = join(
            input.bugId,
            'verification',
            feedbackId,
            `${a.id}-${safeAttachmentName(a.input.fileName)}`,
          ),
          path = join(this.attachmentsDirectory, keyPath);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, a.content, { mode: 0o600, flag: 'wx' });
        written.push(path);
      }
      let dispatchId = '';
      this.database.transaction(() => {
        this.database
          .query(
            `INSERT INTO verification_feedback(id,bug_id,deployment_batch_id,feedback,deployed_commit,created_at) VALUES(?,?,?,?,?,?)`,
          )
          .run(
            feedbackId,
            input.bugId,
            bug.deployment_batch_id,
            input.feedback,
            deployed,
            now,
          );
        for (const a of prepared)
          this.database
            .query(
              `INSERT INTO bug_attachment(id,bug_id,verification_feedback_id,file_name,media_type,size_bytes,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?)`,
            )
            .run(
              a.id,
              input.bugId,
              feedbackId,
              a.input.fileName,
              a.input.mediaType,
              a.input.sizeBytes,
              join(
                input.bugId,
                'verification',
                feedbackId,
                `${a.id}-${safeAttachmentName(a.input.fileName)}`,
              ),
              now,
            );
        this.appendBugEvent(input.bugId, 'bug.verification_failed', now);
        const internalKey = `internal:${key}`,
          internalRequest = JSON.stringify({
            bugId: input.bugId,
            feedback: input.feedback,
            continuation: true,
          });
        dispatchId = this.enqueueRepairMutation({
          bugId: input.bugId,
          key: internalKey,
          operation: 'bug.verify.fail.dispatch',
          request: internalRequest,
          feedback: input.feedback,
          resumeSession,
          sourceCommit: deployed,
          continuation: true,
          now,
        });
        this.recordIdempotency(
          'bug.verify.fail',
          key,
          request,
          dispatchId,
          now,
        );
      })();
      return {
        bug: this.bugSummary(this.getBugRow(input.bugId)),
        dispatch: this.getRepairDispatch(dispatchId),
      };
    } catch (error) {
      const cleanup = await Promise.allSettled(
        written.map((path) => rm(path, { force: true })),
      );
      const cleanupErrors = cleanup.flatMap((result) =>
        result.status === 'rejected' ? [asError(result.reason)] : [],
      );
      if (cleanupErrors.length)
        throw new AggregateError(
          [asError(error), ...cleanupErrors],
          '验证失败回滚附件时发生错误',
        );
      throw error;
    }
  }

  listPromptTemplates() {
    return PROMPT_TEMPLATES.map((t) => ({
      name: t.name,
      version: t.version,
      purpose: t.purpose,
      text: t.text,
      variables: [...t.variables],
      outputSchema: JSON.parse(JSON.stringify(t.outputSchema)) as Record<
        string,
        unknown
      >,
    }));
  }
  listCleanupTargets(runnerId: string) {
    this.getRunner(runnerId);
    const bugs = this.database
      .query<{ id: string; sequence: number; project_id: string }, [string]>(
        `SELECT DISTINCT b.id,b.sequence,b.project_id FROM bug b JOIN repair_attempt a ON a.bug_id=b.id WHERE b.status='done' AND a.runner_id=?`,
      )
      .all(runnerId)
      .map((r) =>
        this.cleanupTarget(
          'bug',
          r.id,
          `BUG-${String(r.sequence).padStart(4, '0')}`,
          r.project_id,
          runnerId,
        ),
      );
    const batches = this.database
      .query<{ id: string; project_id: string }, [string]>(
        `SELECT DISTINCT d.id,d.project_id FROM deployment_batch d WHERE d.runner_id=? AND d.state='deployed' AND NOT EXISTS(SELECT 1 FROM deployment_batch_member m JOIN bug b ON b.id=m.bug_id WHERE m.batch_id=d.id AND b.status!='done')`,
      )
      .all(runnerId)
      .map((r) =>
        this.cleanupTarget(
          'deployment',
          r.id,
          `部署批次 ${r.id.slice(0, 8)}`,
          r.project_id,
          runnerId,
        ),
      );
    return [...bugs, ...batches].filter((t) => !t.cleanedAt);
  }
  getCleanupTarget(input: {
    runnerId: string;
    kind: 'bug' | 'deployment';
    id: string;
  }) {
    const target = this.cleanupTargetByInput(input);
    if (target.cleanedAt) throw this.transitionInvalid('该目标已经清理完成');
    const t = getPromptTemplate('cleanup')!;
    const prompt: RepairPrompt = {
      templateName: t.name,
      templateVersion: t.version,
      text: t.text
        .replaceAll('{{TARGET_KIND}}', target.kind)
        .replaceAll('{{TARGET_ID}}', target.id)
        .replaceAll('{{SESSION_IDS}}', target.sessionIds.join(', ') || '无'),
      outputSchema: JSON.parse(JSON.stringify(t.outputSchema)),
    };
    return { target, prompt };
  }
  finishCleanup(
    input: {
      runnerId: string;
      kind: 'bug' | 'deployment';
      id: string;
      success: boolean;
      summary: string;
      sessionId: string | null;
    },
    key: string,
  ) {
    return this.idempotentBatch(
      'cleanup.finish',
      key,
      input,
      input.id,
      () => {
        this.cleanupTargetByInput(input);
        this.database
          .query(
            `INSERT INTO cleanup_record(id,runner_id,target_kind,target_id,success,summary,session_id,generation_token,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            input.runnerId,
            input.kind,
            input.id,
            input.success ? 1 : 0,
            input.summary,
            input.sessionId,
            this.executionGenerationToken(input.kind, input.id),
            this.iso(),
          );
        if (input.kind === 'bug')
          this.appendBugEvent(
            input.id,
            input.success ? 'bug.cleanup_completed' : 'bug.cleanup_failed',
            this.iso(),
          );
        return this.cleanupTargetByInput(input);
      },
      () => this.cleanupTargetByInput(input),
    );
  }

  collaborativeCommand(
    command: Contract.CollaborativeCommand,
    actor: Contract.ControlPlaneActor,
  ) {
    return this.collaborative.command(command, actor);
  }

  collaborativeQuery(
    query: Contract.CollaborativeQuery,
    actor: Contract.ControlPlaneActor,
  ) {
    return this.collaborative.query(query, actor);
  }

  close() {
    this.database.close();
  }

  private createRepairAttempt(
    dispatchId: string,
    bugId: string,
    retry: number,
    now: string,
    resumeOverride?: string | null,
  ) {
    const d = this.getRepairDispatchRow(dispatchId),
      context = this.repairMemberContext(dispatchId, bugId),
      template = getPromptTemplate(
        context.feedback ? 'bug-repair-resume' : 'bug-repair-start',
      )!;
    const id = randomUUID();
    this.database
      .query(
        `INSERT INTO repair_attempt(id,bug_id,dispatch_id,runner_id,template_name,template_version,state,retry_number,max_infrastructure_retries,cancel_requested,source_deployment_batch_id,source_deployed_commit,created_at,session_id) VALUES(?,?,?,?,?,?,'pending',?,?,0,?,?,?,?)`,
      )
      .run(
        id,
        bugId,
        dispatchId,
        d.runner_id,
        template.name,
        template.version,
        retry,
        d.max_infrastructure_retries,
        context.source_deployment_batch_id,
        context.source_deployed_commit,
        now,
        resumeOverride ??
          (retry
            ? (this.latestRepairAttemptRow(bugId)?.session_id ?? null)
            : context.resume_session_id),
      );
    return id;
  }
  private repairWorkItems(dispatchId: string) {
    return this.database
      .query<RepairAttemptRow, [string]>(
        `${REPAIR_ATTEMPT_SELECT} WHERE dispatch_id=? AND state='pending' ORDER BY created_at,rowid`,
      )
      .all(dispatchId)
      .map((a) => this.repairWorkItem(a));
  }
  private repairWorkItem(a: RepairAttemptRow): RepairWorkItem {
    const context = this.repairMemberContext(a.dispatch_id, a.bug_id),
      bug = this.getBug(a.bug_id),
      project = this.projectRow(bug.projectId),
      template = getPromptTemplate(a.template_name)!;
    const bugJson = JSON.stringify(
      {
        bugId: bug.id,
        shortId: bug.shortId,
        title: bug.title,
        operationPath: bug.operationPath,
        actualResult: bug.actualResult,
        expectedResult: bug.expectedResult,
        supplementalDescription: bug.supplementalDescription,
      },
      null,
      2,
    );
    const text = template.text
      .replaceAll('{{ATTEMPT_ID}}', a.id)
      .replaceAll('{{BUG_JSON}}', bugJson)
      .replaceAll('{{FEEDBACK}}', context.feedback ?? '无')
      .replaceAll(
        '{{SOURCE_DEPLOYED_COMMIT}}',
        context.source_deployed_commit ?? '无',
      );
    return {
      attemptId: a.id,
      project: { id: project.id, slug: project.slug, title: project.title },
      bug: {
        id: bug.id,
        shortId: bug.shortId,
        title: bug.title,
        operationPath: bug.operationPath,
        actualResult: bug.actualResult,
        expectedResult: bug.expectedResult,
        supplementalDescription: bug.supplementalDescription,
        attachments: [
          ...bug.attachments,
          ...bug.verificationFeedbacks.flatMap((f) => f.attachments),
        ],
      },
      prompt: {
        templateName: template.name,
        templateVersion: template.version,
        text,
        outputSchema: JSON.parse(JSON.stringify(BUG_REPAIR_OUTPUT_JSON_SCHEMA)),
      },
      resumeSessionId: a.retry_number
        ? a.session_id
        : context.resume_session_id,
      retryNumber: a.retry_number,
      sourceDeploymentBatchId: a.source_deployment_batch_id,
      sourceDeployedCommit: a.source_deployed_commit,
    };
  }
  private repairMemberContext(dispatchId: string, bugId: string) {
    const context = this.database
      .query<RepairDispatchMemberContextRow, [string, string]>(
        'SELECT resume_session_id,feedback,source_deployment_batch_id,source_deployed_commit FROM repair_dispatch_member WHERE dispatch_id=? AND bug_id=?',
      )
      .get(dispatchId, bugId);
    if (!context) throw this.transitionInvalid('修复收集成员不存在');
    return context;
  }
  private getRepairDispatch(id: string) {
    const d = this.getRepairDispatchRow(id);
    if (['cancelled', 'completed'].includes(d.state))
      throw this.transitionInvalid('修复收集已经结束');
    return this.repairDispatchSummary(d);
  }
  private tryRepairDispatch(id: string) {
    try {
      return this.getRepairDispatch(id);
    } catch {
      return null;
    }
  }
  private getRepairDispatchRow(id: string) {
    const r = this.database
      .query<RepairDispatchRow, [string]>(
        `${REPAIR_DISPATCH_SELECT} WHERE id=?`,
      )
      .get(id);
    if (!r) throw this.notFound('修复收集不存在');
    return r;
  }
  private repairDispatchSummary(d: RepairDispatchRow): RepairDispatchSummary {
    if (!['collecting', 'queued', 'claimed'].includes(d.state))
      throw this.transitionInvalid('修复收集已经结束');
    const members = this.database
      .query<{ bug_id: string }, [string]>(
        'SELECT bug_id FROM repair_dispatch_member WHERE dispatch_id=? AND removed_at IS NULL ORDER BY position',
      )
      .all(d.id)
      .map((x) => this.bugSummary(this.getBugRow(x.bug_id)));
    return {
      id: d.id,
      projectId: d.project_id,
      runnerId: d.runner_id,
      state: d.state as RepairDispatchState,
      closesAt: d.closes_at,
      config: { maxBugs: d.max_bugs, delayMs: d.delay_ms },
      members,
      createdAt: d.created_at,
      queuedAt: d.queued_at,
      claimedAt: d.claimed_at,
    };
  }
  private closeExpiredRepairDispatches(now: string) {
    for (const d of this.database
      .query<{ id: string }, [string]>(
        `SELECT id FROM repair_dispatch WHERE state='collecting' AND closes_at<=?`,
      )
      .all(now))
      this.queueRepairDispatch(d.id, now);
  }
  private queueRepairDispatch(id: string, now: string) {
    this.database
      .query(
        `UPDATE repair_dispatch SET state='queued',queued_at=?,updated_at=? WHERE id=? AND state='collecting'`,
      )
      .run(now, now, id);
    this.database
      .query(
        `UPDATE bug SET repair_state='queued',updated_at=? WHERE repair_dispatch_id=? AND repair_state='collecting'`,
      )
      .run(now, id);
  }
  private activeRepairMemberCount(id: string) {
    return this.database
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) count FROM repair_dispatch_member WHERE dispatch_id=? AND removed_at IS NULL',
      )
      .get(id)!.count;
  }
  private recoverExpiredRepairClaims(now: string) {
    const rows = this.database
      .query<{ id: string }, [string]>(
        `SELECT d.id FROM repair_dispatch d WHERE d.state='claimed' AND d.lease_expires_at<? AND NOT EXISTS(SELECT 1 FROM repair_attempt a WHERE a.dispatch_id=d.id AND a.state='running')`,
      )
      .all(now);
    for (const r of rows)
      this.database
        .query(
          `UPDATE repair_dispatch SET state='queued',claimed_at=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`,
        )
        .run(now, r.id);
  }
  private assertRepairLease(i: {
    runnerId: string;
    dispatchId: string;
    leaseToken: string;
  }) {
    const d = this.getRepairDispatchRow(i.dispatchId);
    if (
      d.state !== 'claimed' ||
      d.runner_id !== i.runnerId ||
      d.lease_token !== i.leaseToken ||
      !d.lease_expires_at ||
      new Date(d.lease_expires_at) < this.now()
    )
      throw this.transitionInvalid('修复租约无效或已过期');
    return d;
  }
  private assertRepairFinishLease(i: {
    runnerId: string;
    dispatchId: string;
    leaseToken: string;
  }) {
    const d = this.getRepairDispatchRow(i.dispatchId);
    if (
      d.state !== 'claimed' ||
      d.runner_id !== i.runnerId ||
      d.lease_token !== i.leaseToken
    )
      throw this.transitionInvalid('修复结果不属于当前 Runner');
    return d;
  }
  private getRepairAttemptRow(id: string) {
    const r = this.database
      .query<RepairAttemptRow, [string]>(`${REPAIR_ATTEMPT_SELECT} WHERE id=?`)
      .get(id);
    if (!r) throw this.notFound('修复尝试不存在');
    return r;
  }
  private latestRepairAttemptRow(bugId: string) {
    return this.database
      .query<RepairAttemptRow, [string]>(
        `${REPAIR_ATTEMPT_SELECT} WHERE bug_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
      )
      .get(bugId);
  }
  private latestReadyAttempt(bugId: string) {
    const r = this.database
      .query<RepairAttemptRow, [string]>(
        `${REPAIR_ATTEMPT_SELECT} WHERE bug_id=? AND state='ready' ORDER BY created_at DESC,rowid DESC LIMIT 1`,
      )
      .get(bugId);
    if (!r) throw this.transitionInvalid('Bug 缺少修复就绪尝试');
    return r;
  }
  private repairAttemptSummary(r: RepairAttemptRow): RepairAttemptSummary {
    return {
      id: r.id,
      bugId: r.bug_id,
      dispatchId: r.dispatch_id,
      runnerId: r.runner_id,
      templateName: r.template_name,
      templateVersion: r.template_version,
      state: r.state,
      sessionId: r.session_id,
      result: r.result_json
        ? RepairResultSchema.parse(JSON.parse(r.result_json))
        : null,
      failureMessage: r.failure_message,
      retryNumber: r.retry_number,
      maxInfrastructureRetries: r.max_infrastructure_retries,
      cancelRequested: Boolean(r.cancel_requested),
      sourceDeploymentBatchId: r.source_deployment_batch_id,
      sourceDeployedCommit: r.source_deployed_commit,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    };
  }

  private getDeploymentBatch(id: string) {
    return this.deploymentBatchSummary(this.getDeploymentBatchRow(id));
  }
  private getDeploymentBatchRow(id: string) {
    const r = this.database
      .query<DeploymentBatchRow, [string]>(
        `${DEPLOYMENT_BATCH_SELECT} WHERE id=?`,
      )
      .get(id);
    if (!r) throw this.notFound('部署批次不存在');
    return r;
  }
  private deploymentBatchSummary(
    r: DeploymentBatchRow,
  ): DeploymentBatchSummary {
    const members = this.database
      .query<{ bug_id: string; candidate_commit: string }, [string]>(
        'SELECT bug_id,candidate_commit FROM deployment_batch_member WHERE batch_id=? ORDER BY position',
      )
      .all(r.id)
      .map((m) => ({
        bug: this.bugSummary(this.getBugRow(m.bug_id)),
        candidateCommit: m.candidate_commit,
      }));
    return {
      id: r.id,
      projectId: r.project_id,
      runnerId: r.runner_id,
      state: r.state,
      closesAt: r.closes_at,
      config: { maxBugs: r.max_bugs, delayMs: r.delay_ms },
      members,
      templateName: r.template_name,
      templateVersion: r.template_version,
      summary: r.summary,
      reason: r.reason,
      deployedCommit: r.deployed_commit,
      createdAt: r.created_at,
      queuedAt: r.queued_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    };
  }
  private closeExpiredDeploymentBatches(now: string) {
    for (const b of this.database
      .query<{ id: string }, [string]>(
        `SELECT id FROM deployment_batch WHERE state='collecting' AND closes_at<=?`,
      )
      .all(now))
      this.queueDeploymentBatch(b.id, now);
  }
  private queueDeploymentBatch(id: string, now: string) {
    this.database
      .query(
        `UPDATE deployment_batch SET state='queued',queued_at=?,updated_at=? WHERE id=? AND state='collecting'`,
      )
      .run(now, now, id);
    this.database
      .query(
        `UPDATE bug SET deployment_state='queued',updated_at=? WHERE deployment_batch_id=?`,
      )
      .run(now, id);
  }
  private deploymentMemberCount(id: string) {
    return this.database
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) count FROM deployment_batch_member WHERE batch_id=?',
      )
      .get(id)!.count;
  }
  private getDeploymentAttemptRow(id: string) {
    const r = this.database
      .query<DeploymentAttemptRow, [string]>(
        `${DEPLOYMENT_ATTEMPT_SELECT} WHERE id=?`,
      )
      .get(id);
    if (!r) throw this.notFound('部署尝试不存在');
    return r;
  }
  private latestDeploymentAttemptRow(id: string) {
    return this.database
      .query<DeploymentAttemptRow, [string]>(
        `${DEPLOYMENT_ATTEMPT_SELECT} WHERE batch_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
      )
      .get(id);
  }
  private previousDeploymentSession(batchId: string, currentId: string) {
    return (
      this.database
        .query<{ session_id: string }, [string, string]>(
          `SELECT session_id FROM deployment_attempt WHERE batch_id=? AND id!=? AND session_id IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1`,
        )
        .get(batchId, currentId)?.session_id ?? null
    );
  }
  private deploymentTemplate(batchId: string) {
    const b = this.getDeploymentBatchRow(batchId);
    return getPromptTemplate(
      b.feedback ? 'deployment-resume' : 'deployment-start',
    )!;
  }
  private renderDeploymentPrompt(b: DeploymentBatchRow): RepairPrompt {
    const t = this.deploymentTemplate(b.id),
      commits = this.database
        .query<{ bug_id: string; candidate_commit: string }, [string]>(
          'SELECT bug_id,candidate_commit FROM deployment_batch_member WHERE batch_id=? ORDER BY position',
        )
        .all(b.id)
        .map(
          (m) =>
            `- ${this.bugSummary(this.getBugRow(m.bug_id)).shortId}: ${m.candidate_commit}`,
        )
        .join('\n');
    return {
      templateName: t.name,
      templateVersion: t.version,
      text: t.text
        .replaceAll('{{BATCH_ID}}', b.id)
        .replaceAll('{{CANDIDATE_COMMITS}}', commits)
        .replaceAll('{{FEEDBACK}}', b.feedback ?? '无'),
      outputSchema: JSON.parse(JSON.stringify(DEPLOYMENT_OUTPUT_JSON_SCHEMA)),
    };
  }
  private assertDeploymentLease(i: {
    runnerId: string;
    batchId: string;
    leaseToken: string;
  }) {
    const b = this.getDeploymentBatchRow(i.batchId);
    if (
      b.runner_id !== i.runnerId ||
      b.lease_token !== i.leaseToken ||
      !b.lease_expires_at ||
      new Date(b.lease_expires_at) < this.now()
    )
      throw this.transitionInvalid('部署租约无效或已过期');
    return b;
  }
  private assertDeploymentFinishLease(i: {
    runnerId: string;
    batchId: string;
    leaseToken: string;
  }) {
    const b = this.getDeploymentBatchRow(i.batchId);
    if (b.runner_id !== i.runnerId || b.lease_token !== i.leaseToken)
      throw this.transitionInvalid('部署结果不属于当前 Runner');
    return b;
  }
  private deployedCommitForBatch(id: string) {
    return this.getDeploymentBatchRow(id).deployed_commit;
  }

  private cleanupTarget(
    kind: 'bug' | 'deployment',
    id: string,
    label: string,
    projectId: string,
    runnerId: string,
  ): CleanupTarget {
    const sessionIds =
      kind === 'bug'
        ? this.database
            .query<{ session_id: string }, [string]>(
              `SELECT DISTINCT session_id FROM repair_attempt WHERE bug_id=? AND session_id IS NOT NULL`,
            )
            .all(id)
            .map((x) => x.session_id)
        : this.database
            .query<{ session_id: string }, [string]>(
              `SELECT DISTINCT session_id FROM deployment_attempt WHERE batch_id=? AND session_id IS NOT NULL`,
            )
            .all(id)
            .map((x) => x.session_id);
    const cleanup = this.latestSuccessfulCleanup(kind, id);
    const cleanedAt =
      cleanup?.generation_token === this.executionGenerationToken(kind, id)
        ? cleanup.created_at
        : null;
    return {
      kind,
      id,
      label,
      projectId,
      runnerId,
      sessionIds,
      cleanedAt,
    } as CleanupTarget;
  }

  private latestSuccessfulCleanup(kind: 'bug' | 'deployment', id: string) {
    return this.database
      .query<
        { created_at: string; generation_token: string | null },
        [string, string]
      >(
        `SELECT created_at,generation_token FROM cleanup_record WHERE target_kind=? AND target_id=? AND success=1 ORDER BY created_at DESC,rowid DESC LIMIT 1`,
      )
      .get(kind, id);
  }

  private executionGenerationToken(kind: 'bug' | 'deployment', id: string) {
    return kind === 'bug'
      ? (this.database
          .query<{ id: string }, [string]>(
            'SELECT id FROM repair_attempt WHERE bug_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
          )
          .get(id)?.id ?? null)
      : (this.database
          .query<{ id: string }, [string]>(
            'SELECT id FROM deployment_attempt WHERE batch_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
          )
          .get(id)?.id ?? null);
  }
  private cleanupTargetByInput(i: {
    runnerId: string;
    kind: 'bug' | 'deployment';
    id: string;
  }) {
    this.getRunner(i.runnerId);
    if (i.kind === 'bug') {
      const b = this.getBugRow(i.id);
      if (b.status !== 'done')
        throw this.transitionInvalid('只有已完成 Bug 可以清理');
      const owned = this.database
        .query<{ ok: number }, [string, string]>(
          'SELECT 1 ok FROM repair_attempt WHERE bug_id=? AND runner_id=? LIMIT 1',
        )
        .get(b.id, i.runnerId);
      if (!owned) throw this.transitionInvalid('该 Bug 不属于当前 Runner');
      return this.cleanupTarget(
        'bug',
        b.id,
        `BUG-${String(b.sequence).padStart(4, '0')}`,
        b.project_id,
        i.runnerId,
      );
    }
    const b = this.getDeploymentBatchRow(i.id);
    if (b.runner_id !== i.runnerId)
      throw this.transitionInvalid('该部署批次不属于当前 Runner');
    if (b.state !== 'deployed')
      throw this.transitionInvalid('只有已部署完成批次可以清理');
    const unfinished = this.database
      .query<{ ok: number }, [string]>(
        `SELECT 1 ok FROM deployment_batch_member m JOIN bug x ON x.id=m.bug_id WHERE m.batch_id=? AND x.status!='done' LIMIT 1`,
      )
      .get(b.id);
    if (unfinished)
      throw this.transitionInvalid('部署批次中的 Bug 尚未全部完成');
    return this.cleanupTarget(
      'deployment',
      b.id,
      `部署批次 ${b.id.slice(0, 8)}`,
      b.project_id,
      i.runnerId,
    );
  }

  private projectActorUserId(actor: Contract.ControlPlaneActor) {
    return actor.kind === 'system'
      ? LEGACY_OWNER_USER_ID
      : this.requireDeveloper(actor);
  }

  private engineeringRow(engineeringId: string) {
    const row = this.database
      .query<EngineeringRow, [string]>(
        `SELECT id,project_id,slug,display_name,type,repository_url,archived_at,first_referenced_at,created_at,updated_at
         FROM engineering WHERE id=?`,
      )
      .get(engineeringId);
    if (!row) throw this.notFound('工程不存在');
    return row;
  }

  private engineeringSummaryForActor(
    engineeringId: string,
    actor: Contract.ControlPlaneActor,
  ) {
    const row = this.engineeringRow(engineeringId);
    const userId = this.requireProjectMember(row.project_id, actor);
    return this.engineeringSummary(
      row,
      userId,
      this.projectRole(row.project_id, userId) === 'OWNER',
    );
  }

  private engineeringSummary(
    row: EngineeringRow,
    userId: string,
    projectOwner: boolean,
  ): Contract.EngineeringSummary {
    const memberRole = this.engineeringRole(row.id, userId);
    return {
      id: row.id,
      projectId: row.project_id,
      slug: row.slug,
      displayName: row.display_name,
      type: row.type,
      archivedAt: row.archived_at,
      firstReferencedAt: row.first_referenced_at,
      memberRole,
      canViewTechnicalConfiguration: projectOwner || memberRole !== null,
      canManage: projectOwner || memberRole === 'OWNER',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private engineeringMembers(engineeringId: string) {
    return this.database
      .query<EngineeringMemberRow, [string]>(
        `SELECT engineering_id,user_id,role,created_at,updated_at FROM engineering_member
         WHERE engineering_id=? ORDER BY CASE role WHEN 'OWNER' THEN 0 ELSE 1 END,created_at,user_id`,
      )
      .all(engineeringId)
      .map((row): Contract.EngineeringMemberSummary => ({
        engineeringId: row.engineering_id,
        user: this.registeredUser(row.user_id),
        role: row.role,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  private engineeringEnvironments(engineeringId: string) {
    return this.database
      .query<EngineeringEnvironmentRow, [string]>(
        `SELECT id,engineering_id,slug,display_name,deployment_type,local_script_command,created_at,updated_at
         FROM engineering_environment WHERE engineering_id=? ORDER BY created_at,id`,
      )
      .all(engineeringId)
      .map((row): Contract.EngineeringEnvironmentSummary => ({
        id: row.id,
        engineeringId: row.engineering_id,
        slug: row.slug,
        displayName: row.display_name,
        deploymentType: row.deployment_type,
        localScriptCommand: row.local_script_command,
        manualConfirmationRequired: row.deployment_type === 'CI_CD',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  private engineeringRole(engineeringId: string, userId: string) {
    return (
      this.database
        .query<{ role: 'OWNER' | 'MEMBER' }, [string, string]>(
          'SELECT role FROM engineering_member WHERE engineering_id=? AND user_id=?',
        )
        .get(engineeringId, userId)?.role ?? null
    );
  }

  private engineeringBindingSummary(
    bindingId: string,
  ): Contract.EngineeringBindingSummary {
    const row = this.database
      .query<EngineeringBindingRow, [string]>(
        `SELECT id,engineering_id,developer_user_id,runner_id,repository_name,created_at,updated_at
         FROM engineering_binding WHERE id=?`,
      )
      .get(bindingId);
    if (!row) throw this.notFound('工程绑定不存在');
    return {
      id: row.id,
      engineeringId: row.engineering_id,
      repositoryName:
        row.repository_name ??
        repositoryNameFromUrl(
          this.engineeringRow(row.engineering_id).repository_url,
        ),
      developer: this.registeredUser(row.developer_user_id),
      runner: this.getRunner(row.runner_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private bindingTicketHash(ticket: string) {
    return createHash('sha256').update(ticket).digest('hex');
  }

  private requireEngineeringManager(
    row: EngineeringRow,
    actor: Contract.ControlPlaneActor,
  ) {
    if (actor.kind === 'system') return LEGACY_OWNER_USER_ID;
    const userId = this.requireProjectMember(row.project_id, actor);
    if (
      this.projectRole(row.project_id, userId) !== 'OWNER' &&
      this.engineeringRole(row.id, userId) !== 'OWNER'
    )
      throw this.engineeringPermission(
        '只有项目负责人或工程负责人可以修改工程',
      );
    return userId;
  }

  private requireEngineeringMembersAreProjectDevelopers(
    projectId: string,
    ownerUserId: string,
    memberUserIds: string[],
  ) {
    for (const userId of [ownerUserId, ...memberUserIds]) {
      const user = this.registeredUser(userId);
      if (
        user.accountType !== 'DEVELOPER' ||
        !this.projectRole(projectId, userId)
      )
        throw this.engineeringMemberInvalid(
          `${user.displayName} 不是该项目的开发成员`,
        );
    }
  }

  private replaceEngineeringMembers(
    engineeringId: string,
    ownerUserId: string,
    memberUserIds: string[],
    now: string,
  ) {
    const createdAt = new Map(
      this.database
        .query<{ user_id: string; created_at: string }, [string]>(
          'SELECT user_id,created_at FROM engineering_member WHERE engineering_id=?',
        )
        .all(engineeringId)
        .map((row) => [row.user_id, row.created_at] as const),
    );
    this.database
      .query('DELETE FROM engineering_member WHERE engineering_id=?')
      .run(engineeringId);
    for (const [userId, role] of [
      [ownerUserId, 'OWNER'],
      ...memberUserIds.map((userId) => [userId, 'MEMBER']),
    ] as Array<[string, 'OWNER' | 'MEMBER']>)
      this.database
        .query(
          `INSERT INTO engineering_member(engineering_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)`,
        )
        .run(engineeringId, userId, role, createdAt.get(userId) ?? now, now);
  }

  private replaceEngineeringEnvironments(
    engineeringId: string,
    environments: Contract.EngineeringEnvironmentInput[],
    now: string,
  ) {
    const existing = new Map(
      this.database
        .query<{ id: string; created_at: string }, [string]>(
          'SELECT id,created_at FROM engineering_environment WHERE engineering_id=?',
        )
        .all(engineeringId)
        .map((row) => [row.id, row.created_at] as const),
    );
    const retainedIds = new Set(
      environments
        .map((environment) => environment.id)
        .filter((id): id is string => Boolean(id && existing.has(id))),
    );

    for (const id of retainedIds)
      this.database
        .query(
          'UPDATE engineering_environment SET slug=? WHERE id=? AND engineering_id=?',
        )
        .run(`__updating__${id}`, id, engineeringId);

    for (const id of existing.keys()) {
      if (retainedIds.has(id)) continue;
      try {
        this.database
          .query(
            'DELETE FROM engineering_environment WHERE id=? AND engineering_id=?',
          )
          .run(id, engineeringId);
      } catch (error) {
        if (String(error).includes('FOREIGN KEY constraint failed'))
          throw this.engineeringReferenced('已被提测单引用的测试环境不能删除');
        throw error;
      }
    }

    for (const environment of environments) {
      const id = environment.id ?? randomUUID();
      const localScriptCommand =
        environment.deploymentType === 'LOCAL_SCRIPT'
          ? (environment.localScriptCommand ?? null)
          : null;
      if (existing.has(id)) {
        this.database
          .query(
            `UPDATE engineering_environment
             SET slug=?,display_name=?,deployment_type=?,local_script_command=?,updated_at=?
             WHERE id=? AND engineering_id=?`,
          )
          .run(
            environment.slug,
            environment.displayName,
            environment.deploymentType,
            localScriptCommand,
            now,
            id,
            engineeringId,
          );
        continue;
      }
      this.database
        .query(
          `INSERT INTO engineering_environment(id,engineering_id,slug,display_name,deployment_type,local_script_command,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          engineeringId,
          environment.slug,
          environment.displayName,
          environment.deploymentType,
          localScriptCommand,
          now,
          now,
        );
    }
  }

  private requireEngineeringEnvironmentIds(
    engineeringId: string,
    environments: Contract.EngineeringEnvironmentInput[],
  ) {
    const existingIds = new Set(
      this.database
        .query<{ id: string }, [string]>(
          'SELECT id FROM engineering_environment WHERE engineering_id=?',
        )
        .all(engineeringId)
        .map((row) => row.id),
    );
    const requestedIds = environments
      .map((environment) => environment.id)
      .filter((id): id is string => Boolean(id));
    if (new Set(requestedIds).size !== requestedIds.length)
      throw this.engineeringEnvironmentInvalid('同一个测试环境不能重复提交');
    const invalid = environments.find(
      (environment) => environment.id && !existingIds.has(environment.id),
    );
    if (invalid)
      throw this.engineeringEnvironmentInvalid(
        `测试环境“${invalid.displayName}”不属于当前工程，请刷新后重试`,
      );
  }

  private rethrowEngineeringConstraint(error: unknown, slug: string): never {
    const message = String(error);
    if (
      message.includes('UNIQUE constraint failed') &&
      message.includes('engineering.project_id') &&
      message.includes('engineering.slug')
    )
      throw createAppError({
        code: ERROR_CODES.engineeringSlugConflict,
        category: 'conflict',
        message: `当前项目已存在工程标识 ${slug}`,
        retryable: false,
      });
    if (
      message.includes('UNIQUE constraint failed') &&
      message.includes('engineering_environment.engineering_id') &&
      message.includes('engineering_environment.slug')
    )
      throw this.engineeringEnvironmentInvalid(
        '同一工程内的测试环境标识不能重复',
      );
    if (
      message.includes('UNIQUE constraint failed') &&
      message.includes('engineering_environment.id')
    )
      throw this.engineeringEnvironmentInvalid(
        '测试环境标识已存在，请刷新后重试',
      );
    throw error;
  }

  private requireDeveloper(actor: Contract.ControlPlaneActor) {
    if (actor.kind !== 'user')
      throw this.projectPermission('只有开发账号可以管理项目');
    const registered = this.registeredUser(actor.userId);
    if (
      registered.accountType !== 'DEVELOPER' ||
      actor.accountType !== registered.accountType
    )
      throw this.projectPermission('只有开发账号可以管理项目');
    return actor.userId;
  }

  private requireProjectMember(
    projectId: string,
    actor: Contract.ControlPlaneActor,
  ) {
    if (actor.kind === 'system') return LEGACY_OWNER_USER_ID;
    const userId = this.requireDeveloper(actor);
    if (!this.projectRole(projectId, userId))
      throw this.projectPermission('你不是该项目成员');
    return userId;
  }

  private requireProjectOwner(
    projectId: string,
    actor: Contract.ControlPlaneActor,
  ) {
    if (actor.kind === 'system') return LEGACY_OWNER_USER_ID;
    const userId = this.requireDeveloper(actor);
    if (this.projectRole(projectId, userId) !== 'OWNER')
      throw this.projectPermission('只有项目 OWNER 可以执行该操作');
    return userId;
  }

  private projectRole(projectId: string, userId: string) {
    return (
      this.database
        .query<{ role: 'OWNER' | 'DEVELOPER' }, [string, string]>(
          'SELECT role FROM project_member WHERE project_id=? AND user_id=?',
        )
        .get(projectId, userId)?.role ?? null
    );
  }

  private registeredUser(userId: string) {
    const user = REGISTERED_USERS.find((candidate) => candidate.id === userId);
    if (!user) throw this.notFound('受邀账号不存在');
    return user;
  }

  private projectMemberSummary(
    row: ProjectMemberRow,
  ): Contract.ProjectMemberSummary {
    return {
      projectId: row.project_id,
      user: this.registeredUser(row.user_id),
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private invitationRow(id: string) {
    const row = this.database
      .query<ProjectInvitationRow, [string]>(
        `SELECT id,project_id,invitee_user_id,invited_by_user_id,status,created_at,updated_at,resolved_at
         FROM project_invitation WHERE id=?`,
      )
      .get(id);
    if (!row) throw this.notFound('项目邀请不存在');
    return row;
  }

  private getInvitation(id: string) {
    return this.projectInvitationSummary(this.invitationRow(id));
  }

  private projectInvitationSummary(
    row: ProjectInvitationRow,
  ): Contract.ProjectInvitationSummary {
    const project = this.projectRow(row.project_id);
    return {
      id: row.id,
      projectId: row.project_id,
      projectTitle: project.title ?? project.slug,
      projectSlug: project.slug,
      invitee: this.registeredUser(row.invitee_user_id),
      invitedBy: this.registeredUser(row.invited_by_user_id),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
    };
  }

  private appendProjectAudit(
    projectId: string,
    actorUserId: string,
    type: Contract.ProjectAuditEventSummary['type'],
    subjectUserId: string | null,
    now: string,
  ) {
    this.database
      .query(
        `INSERT INTO project_audit_event(id,project_id,actor_user_id,event_type,subject_user_id,metadata_json,created_at)
         VALUES(?,?,?,?,?,'{}',?)`,
      )
      .run(randomUUID(), projectId, actorUserId, type, subjectUserId, now);
  }

  private projectAuditSummary(
    row: ProjectAuditEventRow,
  ): Contract.ProjectAuditEventSummary {
    return {
      id: row.id,
      projectId: row.project_id,
      actorUserId: row.actor_user_id,
      type: row.event_type,
      subjectUserId: row.subject_user_id,
      createdAt: row.created_at,
    };
  }

  private projectRow(id: string) {
    const r = this.database
      .query<ProjectRow, [string]>(
        'SELECT id,slug,title,default_runner_id,created_at,updated_at FROM project WHERE id=?',
      )
      .get(id);
    if (!r) throw this.notFound('项目不存在');
    return r;
  }
  private getRunner(id: string): RunnerSummary {
    const r = this.database
      .query<RunnerRow, [string]>(
        'SELECT id,name,last_seen_at FROM runner WHERE id=?',
      )
      .get(id);
    if (!r) throw this.notFound('Runner 不存在');
    return this.runnerSummary(r);
  }
  private runnerSummary(r: RunnerRow): RunnerSummary {
    return {
      id: r.id,
      name: r.name,
      availability:
        this.now().getTime() - new Date(r.last_seen_at).getTime() <=
        this.runnerOfflineAfterMs
          ? 'online'
          : 'offline',
      lastSeenAt: r.last_seen_at,
    };
  }
  private projectSummary(
    r: ProjectRow,
    memberRole: 'OWNER' | 'DEVELOPER' | null,
  ): ProjectSummary {
    const defaultRunner = r.default_runner_id
      ? this.getRunner(r.default_runner_id)
      : null;
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      defaultRunner,
      executable: defaultRunner?.availability === 'online',
      memberRole,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  private getBugRow(id: string) {
    const r = this.database
      .query<BugRow, [string]>(`${BUG_SELECT} WHERE id=?`)
      .get(id);
    if (!r) throw this.notFound('Bug 不存在');
    return r;
  }
  private bugSummary(r: BugRow): BugSummary {
    return {
      id: r.id,
      shortId: `BUG-${String(r.sequence).padStart(4, '0')}`,
      projectId: r.project_id,
      status: r.status,
      repairState: r.repair_state,
      repairDispatchId: r.repair_dispatch_id,
      deploymentBatchId: r.deployment_batch_id,
      deploymentState: r.deployment_state,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  private attachmentRows(bugId: string, feedbackId: string | null) {
    return this.database
      .query<AttachmentRow, [string, string | null]>(
        'SELECT id,bug_id,verification_feedback_id,file_name,media_type,size_bytes,storage_key,created_at FROM bug_attachment WHERE bug_id=? AND verification_feedback_id IS ? ORDER BY created_at,id',
      )
      .all(bugId, feedbackId);
  }
  private attachmentMetadata(r: AttachmentRow): BugAttachmentMetadata {
    return {
      id: r.id,
      bugId: r.bug_id,
      fileName: r.file_name,
      mediaType: r.media_type,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
    };
  }
  private appendBugEvent(id: string, type: BugEvent['type'], now: string) {
    this.database
      .query(
        'INSERT INTO bug_event(id,bug_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?)',
      )
      .run(randomUUID(), id, type, '{}', now);
  }
  private idempotencyRecord(operation: string, key: string, request: string) {
    const e = this.database
      .query<IdempotencyRow, [string, string]>(
        'SELECT request_json,entity_id FROM idempotency_record WHERE operation=? AND key=?',
      )
      .get(operation, key);
    if (e && e.request_json !== request)
      throw createAppError({
        code: ERROR_CODES.idempotencyConflict,
        category: 'conflict',
        message: '同一个 idempotency key 不能用于不同的请求',
        retryable: false,
      });
    return e;
  }
  private recordIdempotency(
    operation: string,
    key: string,
    request: string,
    id: string,
    now: string,
  ) {
    this.database
      .query(
        'INSERT INTO idempotency_record(operation,key,request_json,entity_id,created_at) VALUES(?,?,?,?,?)',
      )
      .run(operation, key, request, id, now);
  }
  private idempotentBatch<T>(
    operation: string,
    key: string,
    input: unknown,
    id: string,
    action: () => T,
    replay: () => T,
  ): T {
    const request = JSON.stringify(input),
      existing = this.idempotencyRecord(operation, key, request);
    if (existing) return replay();
    const result = action();
    this.recordIdempotency(operation, key, request, id, this.iso());
    return result;
  }
  private iso() {
    return this.now().toISOString();
  }
  private notFound(message: string) {
    return createAppError({
      code: ERROR_CODES.entityNotFound,
      category: 'not_found',
      message,
      retryable: false,
    });
  }
  private projectPermission(message: string) {
    return createAppError({
      code: ERROR_CODES.projectAccessDenied,
      category: 'permission',
      message,
      retryable: false,
    });
  }
  private engineeringPermission(message: string) {
    return createAppError({
      code: ERROR_CODES.engineeringAccessDenied,
      category: 'permission',
      message,
      retryable: false,
    });
  }
  private engineeringMemberInvalid(message: string) {
    return createAppError({
      code: ERROR_CODES.engineeringMemberInvalid,
      category: 'validation',
      message,
      retryable: false,
    });
  }
  private engineeringEnvironmentInvalid(message: string) {
    return createAppError({
      code: ERROR_CODES.engineeringEnvironmentInvalid,
      category: 'validation',
      message,
      retryable: false,
    });
  }
  private engineeringReferenced(message: string) {
    return createAppError({
      code: ERROR_CODES.engineeringReferenced,
      category: 'conflict',
      message,
      retryable: false,
    });
  }
  private engineeringBindingInvalid(message: string) {
    return createAppError({
      code: ERROR_CODES.engineeringBindingInvalid,
      category: 'validation',
      message,
      retryable: false,
    });
  }
  private engineeringBindingConflict(message: string) {
    return createAppError({
      code: ERROR_CODES.engineeringBindingConflict,
      category: 'conflict',
      message,
      retryable: false,
    });
  }
  private invitationConflict(message: string) {
    return createAppError({
      code: ERROR_CODES.projectInvitationConflict,
      category: 'conflict',
      message,
      retryable: false,
    });
  }
  private invitationInvalid(message: string) {
    return createAppError({
      code: ERROR_CODES.projectInvitationInvalid,
      category: 'conflict',
      message,
      retryable: false,
    });
  }
  private memberRemovalBlocked(message: string) {
    return createAppError({
      code: ERROR_CODES.projectMemberRemovalBlocked,
      category: 'conflict',
      message,
      retryable: false,
    });
  }
  private transitionInvalid(message: string) {
    return createAppError({
      code: ERROR_CODES.bugTransitionInvalid,
      category: 'conflict',
      message,
      retryable: false,
    });
  }
}

function ensureColumn(
  database: Database,
  table: string,
  column: string,
  declaration: string,
) {
  const columns = database
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all();
  if (!columns.some((c) => c.name === column))
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}
function repositoryNameFromUrl(repositoryUrl: string) {
  const normalized = repositoryUrl.replace(/[\\/]+$/, '');
  const name = normalized
    .split(/[\\/:]/)
    .at(-1)
    ?.replace(/\.git$/, '');
  return name || 'repository';
}
function migrateRepairDispatchMemberContext(database: Database) {
  database.exec(
    `UPDATE repair_dispatch_member AS member SET resume_session_id=(SELECT dispatch.resume_session_id FROM repair_dispatch AS dispatch WHERE dispatch.id=member.dispatch_id),feedback=(SELECT dispatch.feedback FROM repair_dispatch AS dispatch WHERE dispatch.id=member.dispatch_id),source_deployment_batch_id=(SELECT dispatch.source_deployment_batch_id FROM repair_dispatch AS dispatch WHERE dispatch.id=member.dispatch_id),source_deployed_commit=(SELECT dispatch.source_deployed_commit FROM repair_dispatch AS dispatch WHERE dispatch.id=member.dispatch_id) WHERE member.resume_session_id IS NULL AND EXISTS(SELECT 1 FROM repair_dispatch AS dispatch JOIN repair_attempt AS attempt ON attempt.bug_id=member.bug_id AND attempt.session_id=dispatch.resume_session_id WHERE dispatch.id=member.dispatch_id AND dispatch.resume_session_id IS NOT NULL)`,
  );
}
function migrateRepairAttempt(database: Database) {
  const sql =
    database
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='repair_attempt'",
      )
      .get()?.sql ?? '';
  if (
    !sql.includes('UNIQUE(dispatch_id, bug_id)') &&
    !sql.includes('UNIQUE(dispatch_id,bug_id)')
  ) {
    for (const [c, d] of [
      ['retry_number', 'INTEGER NOT NULL DEFAULT 0'],
      ['max_infrastructure_retries', 'INTEGER NOT NULL DEFAULT 2'],
      ['cancel_requested', 'INTEGER NOT NULL DEFAULT 0'],
      ['source_deployment_batch_id', 'TEXT'],
      ['source_deployed_commit', 'TEXT'],
    ] as const)
      ensureColumn(database, 'repair_attempt', c, d);
    return;
  }
  database.exec(
    'PRAGMA foreign_keys=OFF; ALTER TABLE repair_attempt RENAME TO repair_attempt_legacy; CREATE TABLE repair_attempt (id TEXT PRIMARY KEY,bug_id TEXT NOT NULL REFERENCES bug(id),dispatch_id TEXT NOT NULL REFERENCES repair_dispatch(id),runner_id TEXT NOT NULL REFERENCES runner(id),template_name TEXT NOT NULL,template_version TEXT NOT NULL,state TEXT NOT NULL,session_id TEXT,result_json TEXT,failure_message TEXT,retry_number INTEGER NOT NULL DEFAULT 0,max_infrastructure_retries INTEGER NOT NULL DEFAULT 2,cancel_requested INTEGER NOT NULL DEFAULT 0,source_deployment_batch_id TEXT,source_deployed_commit TEXT,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT); INSERT INTO repair_attempt(id,bug_id,dispatch_id,runner_id,template_name,template_version,state,session_id,result_json,failure_message,created_at,started_at,finished_at) SELECT id,bug_id,dispatch_id,runner_id,template_name,template_version,state,session_id,result_json,failure_message,created_at,started_at,finished_at FROM repair_attempt_legacy; DROP TABLE repair_attempt_legacy; CREATE INDEX IF NOT EXISTS repair_attempt_bug ON repair_attempt(bug_id,created_at); PRAGMA foreign_keys=ON;',
  );
}
function migrateCleanupGeneration(database: Database) {
  database.exec(
    `UPDATE cleanup_record SET generation_token=CASE target_kind WHEN 'bug' THEN (SELECT id FROM repair_attempt WHERE bug_id=cleanup_record.target_id AND created_at<=cleanup_record.created_at ORDER BY created_at DESC,rowid DESC LIMIT 1) WHEN 'deployment' THEN (SELECT id FROM deployment_attempt WHERE batch_id=cleanup_record.target_id AND created_at<=cleanup_record.created_at ORDER BY created_at DESC,rowid DESC LIMIT 1) END WHERE success=1 AND generation_token IS NULL`,
  );
}
function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
