import {
  type ExecutionApprovalPolicy,
  type JsonObject,
  type JsonValue,
} from '@agent-party-time/execution-contract';
import type { MaterializedAttachment } from '../execution/attachments';
import type { CodexObservationNotice } from '../observability/protocol';

export type CodexInteraction = {
  method: string;
  payload: JsonValue;
};

export type CodexExecutionInput = {
  approvalPolicy: ExecutionApprovalPolicy;
  executionId: string;
  repositoryPath: string;
  workspaceDirectories?: Array<{ alias: string; path: string; baseCommit?: string }>;
  text: string;
  skill: { name: string; path: string } | null;
  boundSkillPath?: string;
  handoffSkillPath?: string;
  outputSchema: JsonObject;
  attachments: MaterializedAttachment[];
  taskId: string | null;
  managedInteractions?: boolean;
  onProcessGroups?: (groups: number[]) => Promise<void>;
  onInteraction: (interaction: CodexInteraction) => Promise<JsonValue>;
  onManualHandoff?: (questions: string[]) => Promise<void>;
  observe?: (notice: CodexObservationNotice) => void;
};

export type StartedCodexExecution = {
  sessionId: string;
  completion: Promise<JsonValue>;
};

export type CompletedCodexTurn = {
  turnId: string;
  result: JsonValue;
  commandExecutions: unknown[];
};

export interface CodexExecutor {
  begin(input: CodexExecutionInput, signal: AbortSignal): Promise<StartedCodexExecution>;
  readLastCompletedTurn(
    sessionId: string,
    observe?: (notice: CodexObservationNotice) => void,
  ): Promise<CompletedCodexTurn>;
  releaseSession?(sessionId: string): Promise<void>;
}
