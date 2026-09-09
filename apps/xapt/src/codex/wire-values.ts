import { type JsonValue } from '@agent-party-time/execution-contract';

export function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

export function turnFailureMessage(turn: Record<string, unknown>): string {
  const error = asRecord(turn.error);
  const message = optionalString(error.message);
  const codexErrorInfo = asRecord(error.codexErrorInfo);
  const tooMany = asRecord(codexErrorInfo.responseTooManyFailedAttempts);
  if (
    tooMany.httpStatusCode === 429 ||
    message?.includes('429 Too Many Requests')
  )
    return 'Codex 请求过多：429 Too Many Requests，已超过重试次数。';
  return message?.trim() || 'Codex Turn 未正常完成';
}

export function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

export function requiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const result = value[key];
  if (typeof result !== 'string' || !result)
    throw new Error(`Codex 本机服务响应缺少 ${key}`);
  return result;
}

export function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseStructuredResult(message: string): JsonValue | undefined {
  const trimmed = message.trim();
  const candidates: string[] = [trimmed];
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)]
    .map((match) => match[1].trim())
    .reverse();
  candidates.push(...fences);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as JsonValue;
    } catch {
      // 尝试下一个候选片段
    }
  }
  return undefined;
}

export function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Codex 本机服务请求失败';
}
