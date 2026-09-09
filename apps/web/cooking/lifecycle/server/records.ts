import { type Execution } from '@agent-party-time/execution-contract';

export type BugSourceRow = {
  id: string;
  submission_id: string;
  submission_item_id: string | null;
  stage: string;
  version: number;
  short_id: number;
  title: string;
  project_id: string;
  submission_status: 'ACTIVE' | 'CLOSED';
  submission_title: string;
  tester_user_id: string;
  responsible_user_id: string | null;
  binding_id: string | null;
  runner_id: string | null;
  engineering_name: string | null;
  target_branch: string | null;
  archived_at: string | null;
  archived_by_user_id: string | null;
};

export type CleanupSourceRow = {
  id: string;
  submission_id: string;
  submission_item_id: string;
  reason: 'SUBMISSION_CLOSED';
  subject_id: string;
  state: 'READY' | 'RUNNING' | 'FAILED' | 'COMPLETED';
  version: number;
  active_execution_id: string | null;
  session_id: string | null;
  scope_json: string;
  created_at: string;
  updated_at: string;
  responsible_user_id: string;
  binding_id: string;
  runner_id: string;
  engineering_name: string;
  target_branch: string;
  submission_title: string;
  project_id: string;
};

export type CleanupAttemptRow = {
  id: string;
  cleanup_id: string;
  execution_id: string;
  attempt: number;
  outcome_json: string | null;
  created_at: string;
  finished_at: string | null;
  state: Execution['state'];
  session_id: string | null;
};
