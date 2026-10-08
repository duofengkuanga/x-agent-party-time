const MAX_FAILURE_MESSAGE_LENGTH = 1_000;

export function failureMessage(message: string): string {
  const normalized = message.trim();
  return normalized.length <= MAX_FAILURE_MESSAGE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…`;
}
