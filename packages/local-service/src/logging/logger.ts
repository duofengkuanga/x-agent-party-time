import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AppErrorSchema,
  LogLevelSchema as SharedLogLevelSchema,
  LogsQuerySchema,
  ServiceLogRecordSchema,
  ServiceLogStreamItemSchema,
  normalizeError,
  type LogsQuery,
  type ServiceLogRecord,
  type ServiceLogStreamItem,
} from '@agent-party-time/shared';

export const LogLevelSchema = SharedLogLevelSchema;
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogContextSchema = z.object({
  instanceId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  subscriptionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  channelKey: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  outboxEntryId: z.string().min(1).optional(),
});
export type LogContext = z.infer<typeof LogContextSchema>;

export const LogRecordSchema = LogContextSchema.extend({
  timestamp: z.string().datetime(),
  level: LogLevelSchema,
  event: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  error: AppErrorSchema.optional(),
});
export type LogRecord = z.infer<typeof LogRecordSchema>;

export interface Logger {
  trace(event: string, message: string, details?: unknown): void;
  debug(event: string, message: string, details?: unknown): void;
  info(event: string, message: string, details?: unknown): void;
  warn(event: string, message: string, details?: unknown): void;
  error(
    event: string,
    message: string,
    error: unknown,
    details?: unknown,
  ): void;
  fatal(
    event: string,
    message: string,
    error: unknown,
    details?: unknown,
  ): void;
  child(context: LogContext): Logger;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const JsonlLoggerOptionsSchema = z.object({
  directory: z.string().min(1),
  level: LogLevelSchema,
  stdout: z.boolean(),
  maxFileBytes: z.number().int().positive(),
  maxFiles: z.number().int().positive(),
  baseContext: LogContextSchema,
});
export type JsonlLoggerOptions = z.infer<typeof JsonlLoggerOptionsSchema>;

const LEVELS: readonly LogLevel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];
const SENSITIVE =
  /token|authorization|cookie|secret|password|capability|api[-_]?key|prompt/i;

export function redact(value: unknown, key = ''): unknown {
  if (SENSITIVE.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redact(child, childKey),
      ]),
    );
  }
  return value;
}

interface SharedLoggerState {
  options: JsonlLoggerOptions;
  currentFile: string;
  pending: Promise<void>;
  closed: boolean;
}

export class JsonlLogger implements Logger {
  private readonly state: SharedLoggerState;
  private readonly context: LogContext;

  constructor(
    options: JsonlLoggerOptions,
    state?: SharedLoggerState,
    context?: LogContext,
  ) {
    const parsed = JsonlLoggerOptionsSchema.parse(options);
    this.state = state ?? {
      options: parsed,
      currentFile: join(parsed.directory, 'current.jsonl'),
      pending: Promise.resolve(),
      closed: false,
    };
    this.context = LogContextSchema.parse(context ?? parsed.baseContext);
  }

  trace(event: string, message: string, details?: unknown) {
    this.write('trace', event, message, undefined, details);
  }
  debug(event: string, message: string, details?: unknown) {
    this.write('debug', event, message, undefined, details);
  }
  info(event: string, message: string, details?: unknown) {
    this.write('info', event, message, undefined, details);
  }
  warn(event: string, message: string, details?: unknown) {
    this.write('warn', event, message, undefined, details);
  }
  error(event: string, message: string, error: unknown, details?: unknown) {
    this.write('error', event, message, error, details);
  }
  fatal(event: string, message: string, error: unknown, details?: unknown) {
    this.write('fatal', event, message, error, details);
  }

  child(context: LogContext): Logger {
    return new JsonlLogger(
      this.state.options,
      this.state,
      LogContextSchema.parse({ ...this.context, ...context }),
    );
  }

  async flush(): Promise<void> {
    await this.state.pending;
  }
  async close(): Promise<void> {
    this.state.closed = true;
    await this.flush();
  }

  private write(
    level: LogLevel,
    event: string,
    message: string,
    error?: unknown,
    details?: unknown,
  ): void {
    if (
      this.state.closed ||
      LEVELS.indexOf(level) < LEVELS.indexOf(this.state.options.level)
    )
      return;
    const raw: LogRecord = {
      ...this.context,
      timestamp: new Date().toISOString(),
      level,
      event,
      message,
      ...(details === undefined
        ? {}
        : { details: redact(details) as Record<string, unknown> }),
      ...(error === undefined
        ? {}
        : {
            error: redact(normalizeError(error)) as ReturnType<
              typeof normalizeError
            >,
          }),
    };
    const record = LogRecordSchema.parse(raw);
    const line = `${JSON.stringify(record)}\n`;
    if (this.state.options.stdout) process.stderr.write(line);
    this.state.pending = this.state.pending
      .then(async () => {
        await mkdir(this.state.options.directory, {
          recursive: true,
          mode: 0o700,
        });
        await this.rotateIfNeeded(Buffer.byteLength(line));
        await appendFile(this.state.currentFile, line, {
          encoding: 'utf8',
          mode: 0o600,
        });
      })
      .catch((writeError) => {
        process.stderr.write(`logger write failed: ${String(writeError)}\n`);
      });
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    const size = await stat(this.state.currentFile)
      .then((value) => value.size)
      .catch(() => 0);
    if (size + incomingBytes <= this.state.options.maxFileBytes) return;
    const archive = join(
      this.state.options.directory,
      `${new Date().toISOString().replaceAll(':', '-')}.jsonl`,
    );
    await rename(this.state.currentFile, archive).catch(() => undefined);
    const files = (await readdir(this.state.options.directory))
      .filter((file) => file.endsWith('.jsonl') && file !== 'current.jsonl')
      .sort();
    await Promise.all(
      files
        .slice(0, Math.max(0, files.length - this.state.options.maxFiles))
        .map((file) => unlink(join(this.state.options.directory, file))),
    );
  }
}

const LogCursorSchema = z.object({
  fileIndex: z.number().int().nonnegative(),
  lineIndex: z.number().int().nonnegative(),
});
function encodeCursor(value: z.infer<typeof LogCursorSchema>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decodeCursor(value?: string): z.infer<typeof LogCursorSchema> {
  return value
    ? LogCursorSchema.parse(
        JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
      )
    : { fileIndex: 0, lineIndex: 0 };
}

export class LogQueryService {
  constructor(private readonly directory: string) {}

  async query(
    raw: LogsQuery,
  ): Promise<{ items: ServiceLogStreamItem[]; nextCursor: string | null }> {
    const input = LogsQuerySchema.parse(raw);
    const files = (await readdir(this.directory).catch(() => [] as string[]))
      .filter((file) => file.endsWith('.jsonl'))
      .sort((a, b) =>
        a === 'current.jsonl'
          ? 1
          : b === 'current.jsonl'
            ? -1
            : a.localeCompare(b),
      );
    const start = decodeCursor(input.cursor);
    const items: ServiceLogStreamItem[] = [];
    let nextCursor: string | null = null;
    for (
      let fileIndex = start.fileIndex;
      fileIndex < files.length && items.length < input.limit;
      fileIndex += 1
    ) {
      const lines = (
        await readFile(join(this.directory, files[fileIndex]!), 'utf8')
      )
        .split('\n')
        .filter(Boolean);
      const firstLine = fileIndex === start.fileIndex ? start.lineIndex : 0;
      for (
        let lineIndex = firstLine;
        lineIndex < lines.length && items.length < input.limit;
        lineIndex += 1
      ) {
        const record = this.parseRecord(lines[lineIndex]!);
        if (!record || !this.matches(record, input)) continue;
        nextCursor = encodeCursor({ fileIndex, lineIndex: lineIndex + 1 });
        items.push(
          ServiceLogStreamItemSchema.parse({ cursor: nextCursor, record }),
        );
      }
    }
    return { items, nextCursor };
  }

  async subscribe(
    cursor: string | null,
    raw: LogsQuery,
    onItem: (item: ServiceLogStreamItem) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let current = cursor;
    while (!signal.aborted) {
      const result = await this.query({ ...raw, cursor: current ?? undefined });
      for (const item of result.items) {
        await onItem(item);
        current = item.cursor;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  private parseRecord(line: string): ServiceLogRecord | null {
    try {
      return ServiceLogRecordSchema.parse(JSON.parse(line));
    } catch {
      return null;
    }
  }

  private matches(record: ServiceLogRecord, input: LogsQuery): boolean {
    return (
      !(input.since && record.timestamp < input.since) &&
      !(input.until && record.timestamp > input.until) &&
      (!input.levels || input.levels.includes(record.level)) &&
      (!input.event || record.event === input.event) &&
      (!input.correlationId || record.correlationId === input.correlationId) &&
      (!input.agentId || record.agentId === input.agentId) &&
      (!input.channelKey || record.channelKey === input.channelKey) &&
      (!input.jobId || record.jobId === input.jobId) &&
      (!input.runId || record.runId === input.runId) &&
      (!input.taskId || record.taskId === input.taskId)
    );
  }
}
