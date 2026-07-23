import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  CLI_NAME,
  DeploymentAttemptIdSchema,
  ENV_NAMES,
  ListLogsResultSchema,
  LOCAL_PATHS,
  LogsQuerySchema,
  RepairAttemptIdSchema,
} from '@agent-party-time/shared';
import {
  optionBoolean,
  optionNumber,
  optionString,
  optionStrings,
  parseArgs,
} from '../args.js';
import type { ServiceClient } from '../client/service-client.js';
import type { Output } from '../output.js';

export async function runLogsCommand(
  args: readonly string[],
  client: ServiceClient,
  output: Output,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const parsed = parseArgs(args);
  const kind = parsed.positionals[0];
  if (kind === 'repair' || kind === 'deployment') {
    await showExecutionLogs(kind, parsed, output, env);
    return;
  }
  const query = LogsQuerySchema.parse({
    cursor: optionString(parsed, 'cursor'),
    limit: optionNumber(parsed, 'limit', 100),
    since: optionString(parsed, 'since'),
    until: optionString(parsed, 'until'),
    levels: optionStrings(parsed, 'level').length
      ? optionStrings(parsed, 'level')
      : undefined,
    event: optionString(parsed, 'event'),
    correlationId: optionString(parsed, 'correlation'),
    agentId: optionString(parsed, 'agent'),
    channelKey: optionString(parsed, 'channel'),
    jobId: optionString(parsed, 'job'),
    runId: optionString(parsed, 'run'),
    taskId: optionString(parsed, 'task'),
  });
  const result = await client.query(
    'logs.query',
    LogsQuerySchema,
    ListLogsResultSchema,
    query,
  );
  output.value(result.items);
  if (optionBoolean(parsed, 'follow')) {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    await client.subscribeLogs(
      result.nextCursor,
      query,
      (item) => output.value(item.record),
      controller.signal,
    );
  }
}

async function showExecutionLogs(
  kind: 'repair' | 'deployment',
  parsed: ReturnType<typeof parseArgs>,
  output: Output,
  env: Readonly<Record<string, string | undefined>>,
) {
  const rawAttempt = optionString(parsed, 'attempt');
  if (!rawAttempt)
    throw new Error(`用法：${CLI_NAME} logs ${kind} --attempt <id>`);
  const attemptId =
    kind === 'repair'
      ? RepairAttemptIdSchema.parse(rawAttempt)
      : DeploymentAttemptIdSchema.parse(rawAttempt);
  const homeDirectory = resolve(
    optionString(parsed, 'home') ??
      env[ENV_NAMES.home] ??
      resolve(homedir(), LOCAL_PATHS.homeDirName),
  );
  const directory = resolve(
    homeDirectory,
    LOCAL_PATHS.repairAttemptsDir,
    kind === 'repair' ? attemptId : `deployment-${attemptId}`,
  );
  const files = await Promise.all(
    ['codex.stdout.jsonl', 'codex.stderr.log', 'final-result.json'].map(
      async (name) => {
        const path = resolve(directory, name);
        try {
          return { name, path, content: await readFile(path, 'utf8') };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return { name, path, content: null };
          throw error;
        }
      },
    ),
  );
  if (files.every((file) => file.content === null))
    throw new Error(`未找到 ${kind} attempt ${attemptId} 的本地日志`);
  output.value({ kind, attemptId, directory, files });
}
