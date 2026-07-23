#!/usr/bin/env bun
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { ZodError } from 'zod';
import { APP_NAME, CLI_NAME, type AppError } from '@agent-party-time/shared';
import {
  parseArgs,
  optionBoolean,
  optionNumber,
  optionString,
  withoutLeadingPositionals,
} from './args.js';
import { ServiceClient, ServiceClientError } from './client/service-client.js';
import { runAgentCommand } from './commands/agent.js';
import { runChannelCommand } from './commands/channel.js';
import { runCleanupCommand } from './commands/cleanup.js';
import { runEngineeringCommand } from './commands/engineering.js';
import { runLogsCommand } from './commands/logs.js';
import { runExecutionCommand } from './commands/run.js';
import { runServiceCommand } from './commands/service.js';
import { runTaskCommand } from './commands/task.js';
import { runProjectCommand } from './commands/project.js';
import { Output } from './output.js';

export interface CliDependencies {
  stdout: Writable;
  stderr: Writable;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
}
const HELP = `${APP_NAME}\n\n用法：\n  ${CLI_NAME} start|stop|status\n  ${CLI_NAME} project bind --project <id|slug> [--repo <path>] [--base <branch>]\n  ${CLI_NAME} project list\n  ${CLI_NAME} engineering bind --engineering <id> --ticket <ticket> [--repo <path>]\n  ${CLI_NAME} engineering list\n  ${CLI_NAME} agent list|show|add|update|enable|disable\n  ${CLI_NAME} channel list|show|add|update|enable|disable|remove\n  ${CLI_NAME} run list|show|cancel|retry\n  ${CLI_NAME} session list|show|invalidate\n  ${CLI_NAME} task list|show|create|from|assign|claim|status|complete|review\n  ${CLI_NAME} logs [--follow]
  ${CLI_NAME} logs repair|deployment --attempt <id>
  ${CLI_NAME} cleanup list
  ${CLI_NAME} cleanup run --bug <id>|--deployment <id> --confirm <label>\n\n全局参数：--server <url> --home <path> --timeout <ms> --json`;

export async function main(
  argv: readonly string[],
  deps: CliDependencies = {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    fetch: globalThis.fetch,
  },
): Promise<number> {
  const commandArgs = argv.slice(2);
  const globals = parseArgs(commandArgs);
  const output = new Output(
    deps.stdout,
    deps.stderr,
    optionBoolean(globals, 'json'),
  );
  if (
    !commandArgs.length ||
    optionBoolean(globals, 'help') ||
    globals.positionals[0] === 'help'
  ) {
    deps.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (optionBoolean(globals, 'version')) {
    deps.stdout.write('0.1.0\n');
    return 0;
  }
  const client = new ServiceClient({
    serverUrl: optionString(globals, 'server'),
    homeDirectory: optionString(globals, 'home'),
    capabilityFile: optionString(globals, 'capability-file'),
    timeoutMs: optionNumber(globals, 'timeout', 30_000),
    fetch: deps.fetch,
    env: deps.env,
  });
  try {
    const group = globals.positionals[0]!;
    const action = globals.positionals[1];
    const serviceArgs = withoutLeadingPositionals(commandArgs, 1);
    const nestedArgs = withoutLeadingPositionals(commandArgs, 2);
    if (['start', 'stop', 'status'].includes(group))
      await runServiceCommand(group, serviceArgs, client, output);
    else if (group === 'agent')
      await runAgentCommand(action ?? 'list', nestedArgs, client, output);
    else if (group === 'channel')
      await runChannelCommand(action ?? 'list', nestedArgs, client, output);
    else if (group === 'run' || group === 'session')
      await runExecutionCommand(
        group,
        action ?? 'list',
        nestedArgs,
        client,
        output,
      );
    else if (group === 'task')
      await runTaskCommand(action ?? 'list', nestedArgs, client, output);
    else if (group === 'project')
      await runProjectCommand(action ?? 'list', nestedArgs, client, output);
    else if (group === 'engineering')
      await runEngineeringCommand(action ?? 'list', nestedArgs, client, output);
    else if (group === 'logs')
      await runLogsCommand(serviceArgs, client, output, deps.env);
    else if (group === 'cleanup')
      await runCleanupCommand(action ?? 'list', nestedArgs, output, {
        env: deps.env,
        fetch: deps.fetch,
      });
    else throw new Error(`未知命令 ${group}\n${HELP}`);
    return 0;
  } catch (error) {
    output.error(presentError(error));
    return exitCodeForError(error);
  } finally {
    client.close();
  }
}

export function presentError(error: unknown): string {
  if (error instanceof ServiceClientError)
    return `${error.appError.message} (${error.appError.code})`;
  if (error instanceof ZodError)
    return `参数校验失败：${error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')}`;
  return error instanceof Error ? error.message : '未知错误';
}
export function exitCodeForError(error: unknown): number {
  if (error instanceof ZodError) return 2;
  if (!(error instanceof ServiceClientError)) return 1;
  const category = error.appError.category;
  if (category === 'validation') return 2;
  if (category === 'transport') return 3;
  if (category === 'conflict' || category === 'not_found') return 4;
  if (category === 'authentication' || category === 'permission') return 5;
  if (category === 'timeout' || category === 'cancelled') return 6;
  return 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && new URL(import.meta.url).pathname === invokedPath)
  process.exitCode = await main(process.argv);
