import {
  sanitizeExecutionInteractionPayload,
  type JsonValue,
} from '@agent-party-time/execution-contract';
import { PlatformError } from '@/server/errors';
import {
  CookingInteractionViewSchema,
  type CookingInteractionView,
} from './contract';

export type CookingInteractionRow = {
  id: string;
  execution_id: string;
  kind: 'APPROVAL' | 'USER_INPUT';
  method: string;
  payload_json: string;
  state: 'PENDING' | 'RESOLVED';
  resolution_json: string | null;
  created_at: string;
  resolved_at: string | null;
};

export function projectCookingInteraction(
  row: CookingInteractionRow,
  responsible: boolean,
): CookingInteractionView {
  const payload = sanitizeExecutionInteractionPayload(
    row.method,
    JSON.parse(row.payload_json),
  );
  const resolution = row.resolution_json
    ? (JSON.parse(row.resolution_json) as JsonValue)
    : null;
  const base = {
    id: row.id,
    executionId: row.execution_id,
    state: row.state,
    canResolve: responsible && row.state === 'PENDING',
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
  if (row.kind === 'APPROVAL')
    return CookingInteractionViewSchema.parse({
      ...base,
      kind: row.kind,
      request: responsible ? approvalRequest(row.method, payload) : null,
      resolution:
        responsible && resolution
          ? approvalResolution(row.method, resolution)
          : null,
    });
  return CookingInteractionViewSchema.parse({
    ...base,
    kind: row.kind,
    request: responsible ? userInputRequest(payload) : null,
    resolution:
      responsible && resolution
        ? userInputResolution(payload, resolution)
        : null,
  });
}

function approvalRequest(method: string, payloadValue: JsonValue) {
  const payload = asRecord(payloadValue);
  const values = {
    'item/commandExecution/requestApproval': {
      type: 'COMMAND' as const,
      title: 'Codex 请求执行命令',
    },
    'item/fileChange/requestApproval': {
      type: 'FILE_CHANGE' as const,
      title: 'Codex 请求扩展文件写入范围',
    },
    'item/permissions/requestApproval': {
      type: 'PERMISSION' as const,
      title: 'Codex 请求权限',
    },
  }[method];
  if (!values)
    throw new PlatformError('INTERNAL_ERROR', '不支持的 Codex 审批类型');
  return {
    ...values,
    purpose: stringValue(payload.reason),
    command: stringValue(payload.command),
    permissions: payload.permissions ?? null,
  };
}

function approvalResolution(
  method: string,
  resolutionValue: JsonValue,
): 'DECLINED' | 'ACCEPTED_ONCE' | 'ACCEPTED_FOR_SESSION' {
  const resolution = asRecord(resolutionValue);
  if (method === 'item/permissions/requestApproval') {
    const permissions = asRecord(resolution.permissions);
    if (Object.keys(permissions).length === 0) return 'DECLINED';
    if (resolution.scope === 'turn') return 'ACCEPTED_ONCE';
    if (resolution.scope === 'session') return 'ACCEPTED_FOR_SESSION';
  } else {
    if (resolution.decision === 'decline') return 'DECLINED';
    if (resolution.decision === 'accept') return 'ACCEPTED_ONCE';
    if (resolution.decision === 'acceptForSession')
      return 'ACCEPTED_FOR_SESSION';
  }
  throw new PlatformError('INTERNAL_ERROR', 'Codex 审批结果无效');
}

function userInputRequest(payloadValue: JsonValue) {
  const questions = asRecord(payloadValue).questions;
  if (!Array.isArray(questions) || questions.length === 0)
    throw new PlatformError('INTERNAL_ERROR', 'Codex 提问缺少 questions');
  return {
    questions: questions.map((questionValue) => {
      const question = asRecord(questionValue);
      if (
        typeof question.id !== 'string' ||
        typeof question.header !== 'string' ||
        typeof question.question !== 'string'
      )
        throw new PlatformError('INTERNAL_ERROR', 'Codex question 结构无效');
      const options = Array.isArray(question.options)
        ? question.options.map((optionValue) => {
            const option = asRecord(optionValue);
            const label = stringValue(option.label);
            const value = stringValue(option.value) ?? label;
            if (!label || !value)
              throw new PlatformError(
                'INTERNAL_ERROR',
                'Codex question option 结构无效',
              );
            return {
              value,
              label,
              description: stringValue(option.description),
            };
          })
        : [];
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
    }),
  };
}

function userInputResolution(
  payloadValue: JsonValue,
  resolutionValue: JsonValue,
) {
  const answerValues = asRecord(resolutionValue).answers;
  const answers = asRecord(answerValues);
  const questions = userInputRequest(payloadValue).questions;
  const optionLabels = new Map(
    questions.flatMap((question) =>
      question.options.map(
        (option) => [`${question.id}:${option.value}`, option.label] as const,
      ),
    ),
  );
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, answerValue]) => {
        const values = asRecord(answerValue).answers;
        if (
          !Array.isArray(values) ||
          values.length === 0 ||
          values.some((value) => typeof value !== 'string' || !value.trim())
        )
          throw new PlatformError('INTERNAL_ERROR', 'Codex 回答记录无效');
        return [
          id,
          values.map((value) => optionLabels.get(`${id}:${value}`) ?? value),
        ];
      }),
    ),
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}
