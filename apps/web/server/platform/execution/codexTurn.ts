import { createHash } from 'node:crypto';
import {
  serializeDeterministicJson,
  type CodexTurn,
  type ExecutionResultAssertion,
  type JsonObject,
  type TaskSkillBinding,
} from '@agent-party-time/execution-contract';

export function createInitialCodexTurn(input: {
  requiredSkillName: string;
  requiredSkillProtocol?: string;
  manualHandoff?: 'EXTERNAL_SESSION';
  managedInteractions?: true;
  executionBrief: JsonObject;
  outputJsonSchema: JsonObject;
  resultAssertions?: ExecutionResultAssertion[];
}): CodexTurn {
  const serialized = serializeDeterministicJson(input.executionBrief);
  return {
    kind: 'INITIAL',
    manualHandoff: input.manualHandoff,
    managedInteractions: input.managedInteractions,
    requiredSkillName: input.requiredSkillName,
    requiredSkillProtocol: input.requiredSkillProtocol,
    executionBrief: input.executionBrief,
    executionBriefHash: createHash('sha256').update(serialized).digest('hex'),
    outputJsonSchema: input.outputJsonSchema,
    taskSkillBinding: null,
    resultAssertions: input.resultAssertions,
  };
}

export function createContinuationCodexTurn(input: {
  taskId: string;
  manualHandoff?: 'EXTERNAL_SESSION';
  managedInteractions?: true;
  taskSkillBinding: TaskSkillBinding;
  text: string;
  outputJsonSchema: JsonObject;
  resultAssertions?: ExecutionResultAssertion[];
}): CodexTurn {
  return {
    kind: 'CONTINUATION',
    manualHandoff: input.manualHandoff,
    managedInteractions: input.managedInteractions,
    taskId: input.taskId,
    taskSkillBinding: input.taskSkillBinding,
    input: input.text,
    outputJsonSchema: input.outputJsonSchema,
    resultAssertions: input.resultAssertions,
  };
}
