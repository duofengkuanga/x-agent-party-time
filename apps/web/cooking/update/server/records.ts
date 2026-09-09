import type { Execution } from '@agent-party-time/execution-contract';

export type ItemSourceRow = {
  submission_id: string;
  submission_item_id: string;
  project_id: string;
  submission_status: 'ACTIVE' | 'CLOSED';
  submission_title: string;
  engineering_name: string;
  repository_url: string;
  target_branch: string;
  environment_name: string;
  deployment_json: string;
  responsible_user_id: string;
  binding_id: string;
  runner_id: string;
};

export type CandidateRow = {
  bug_id: string;
  short_id: number;
  title: string;
  pending_commits_json: string;
  pending_manual_operations_json: string;
  last_candidate_at: string;
};

export type BatchRow = {
  id: string;
  submission_id: string;
  submission_item_id: string;
  state: 'READY' | 'RUNNING' | 'WAITING_EXTERNAL' | 'FAILED' | 'COMPLETED';
  version: number;
  active_execution_id: string | null;
  session_id: string | null;
  deployment_json: string;
  frozen_at: string;
  created_at: string;
  updated_at: string;
};

export type AttemptRow = {
  id: string;
  batch_id: string;
  execution_id: string;
  continuation_report_id: string | null;
  attempt: number;
  outcome_json: string | null;
  created_at: string;
  finished_at: string | null;
  state: Execution['state'];
  session_id: string | null;
};

export type ExternalReportRow = {
  id: string;
  batch_id: string;
  round: number;
  outcome: 'SUCCEEDED' | 'FAILED';
  summary: string | null;
  reported_by_user_id: string;
  created_at: string;
};

export type ExternalReportAttachmentRow = {
  id: string;
  original_name: string;
  media_type: string;
  size_bytes: number;
  created_at: string;
};

export type FrozenBatch = {
  batchId: string;
  executionId: string;
  revision: number;
};
