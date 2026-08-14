import { createHash } from 'node:crypto';
import {
  serializeDeterministicJson,
  type CodexTurn,
  type JsonObject,
  type TaskSkillBinding,
} from '@agent-party-time/execution-contract';

export function createInitialCodexTurn(input: {
  requiredSkillName: string;
  executionBrief: JsonObject;
  outputJsonSchema: JsonObject;
}): CodexTurn {
  const serialized = serializeDeterministicJson(input.executionBrief);
  return {
    kind: 'INITIAL',
    requiredSkillName: input.requiredSkillName,
    executionBrief: input.executionBrief,
    executionBriefHash: createHash('sha256').update(serialized).digest('hex'),
    outputJsonSchema: input.outputJsonSchema,
    taskSkillBinding: null,
  };
}

export function createContinuationCodexTurn(input: {
  taskId: string;
  taskSkillBinding: TaskSkillBinding;
  text: string;
  outputJsonSchema: JsonObject;
}): CodexTurn {
  return {
    kind: 'CONTINUATION',
    taskId: input.taskId,
    taskSkillBinding: input.taskSkillBinding,
    input: input.text,
    outputJsonSchema: input.outputJsonSchema,
  };
}
