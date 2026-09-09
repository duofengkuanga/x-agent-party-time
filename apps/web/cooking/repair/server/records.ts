import type { Execution } from '@agent-party-time/execution-contract';

export type RepairSourceRow = {
  bug_id: string;
  submission_id: string;
  submission_item_id: string;
  project_id: string;
  submission_status: 'ACTIVE' | 'CLOSED';
  stage:
    | 'WAITING_FOR_REPAIR'
    | 'REPAIRING'
    | 'WAITING_FOR_UPDATE'
    | 'UPDATING'
    | 'WAITING_FOR_VERIFICATION'
    | 'DONE'
    | 'CANCELLED';
  bug_version: number;
  responsible_user_id: string;
};

export type AttemptRow = {
  id: string;
  bug_id: string;
  execution_id: string;
  attempt: number;
  outcome_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  state: Execution['state'];
  session_id: string | null;
  outcome: string | null;
  runner_name: string;
};

export type ContextRow = {
  bug_id: string;
  workspace_key: string;
  session_id: string | null;
  pending_commits_json: string;
  pending_manual_operations_json: string;
  last_candidate_at: string | null;
  version: number;
};
