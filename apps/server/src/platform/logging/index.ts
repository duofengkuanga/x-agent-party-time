import { PlatformError } from '@/platform/errors';

type LogFields = Readonly<Record<string, unknown>>;

const SENSITIVE_KEYS = /password|credential|token|secret|lease|path/iu;

export const logger = {
  info(event: string, fields: LogFields = {}) {
    console.info(JSON.stringify({ level: 'info', event, ...sanitize(fields) }));
  },
  error(event: string, error: unknown, fields: LogFields = {}) {
    console.error(
      JSON.stringify({
        level: 'error',
        event,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorCode: error instanceof PlatformError ? error.code : undefined,
        ...sanitize(fields),
      }),
    );
  },
};

function sanitize(fields: LogFields): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      SENSITIVE_KEYS.test(key) ? '[REDACTED]' : sanitizeValue(value),
    ]),
  );
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object')
    return sanitize(value as Record<string, unknown>);
  return value;
}
