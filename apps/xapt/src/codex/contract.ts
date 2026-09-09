import {
  type ExecutionApprovalPolicy,
  type JsonObject,
  type JsonValue,
} from '@agent-party-time/execution-contract';
import type { MaterializedAttachment } from '../execution/attachments';

export type CodexInteraction = {
  method: string;
  payload: JsonValue;
};

export type CodexExecutionInput = {
  approvalPolicy: ExecutionApprovalPolicy;
  executionId: string;
  repositoryPath: string;
  text: string;
  skill: { name: string; path: string } | null;
  outputSchema: JsonObject;
  attachments: MaterializedAttachment[];
  artifactsDirectory: string;
  taskId: string | null;
  onInteraction: (interaction: CodexInteraction) => Promise<JsonValue>;
};

export type StartedCodexExecution = {
  sessionId: string;
  completion: Promise<JsonValue>;
};

export type CompletedCodexTurn = {
  turnId: string;
  result: JsonValue;
};

export interface CodexExecutor {
  begin(
    input: CodexExecutionInput,
    signal: AbortSignal,
  ): Promise<StartedCodexExecution>;
  readLastCompletedTurn(sessionId: string): Promise<CompletedCodexTurn>;
}
