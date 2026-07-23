import { randomUUID } from 'node:crypto';
import {
  CancelRunCommandSchema,
  InvalidateSessionCommandSchema,
  InvalidateSessionResultSchema,
  ListRunsQuerySchema,
  ListRunsResultSchema,
  ListSessionsQuerySchema,
  ListSessionsResultSchema,
  RetryRunCommandSchema,
  RunActionResultSchema,
  ShowRunQuerySchema,
  ShowRunResultSchema,
  ShowSessionQuerySchema,
  ShowSessionResultSchema,
} from '@agent-party-time/shared';
import { optionNumber, optionString, parseArgs } from '../args.js';
import type { ServiceClient } from '../client/service-client.js';
import type { Output } from '../output.js';

export async function runExecutionCommand(
  group: 'run' | 'session',
  action: string,
  args: readonly string[],
  client: ServiceClient,
  output: Output,
) {
  const parsed = parseArgs(args);
  const id = parsed.positionals[0];
  if (group === 'run') {
    if (action === 'list') {
      output.value(
        (
          await client.query(
            'run.list',
            ListRunsQuerySchema,
            ListRunsResultSchema,
            {
              cursor: optionString(parsed, 'cursor'),
              limit: optionNumber(parsed, 'limit', 50),
              state: optionString(parsed, 'state') as never,
              jobId: optionString(parsed, 'job'),
              taskId: optionString(parsed, 'task'),
            },
          )
        ).items,
      );
      return;
    }
    if (!id) throw new Error('缺少 run/job id');
    if (action === 'show') {
      output.value(
        await client.query(
          'run.show',
          ShowRunQuerySchema,
          ShowRunResultSchema,
          { runId: id },
        ),
      );
      return;
    }
    if (action === 'cancel') {
      const input =
        optionString(parsed, 'kind') === 'job'
          ? {
              targetKind: 'job' as const,
              jobId: id,
              reason: optionString(parsed, 'reason') ?? 'CLI cancel',
            }
          : {
              targetKind: 'run' as const,
              runId: id,
              reason: optionString(parsed, 'reason') ?? 'CLI cancel',
            };
      output.value(
        await client.request(
          'run.cancel',
          CancelRunCommandSchema,
          RunActionResultSchema,
          input,
        ),
      );
      return;
    }
    if (action === 'retry') {
      output.value(
        await client.request(
          'run.retry',
          RetryRunCommandSchema,
          RunActionResultSchema,
          { jobId: id, reason: optionString(parsed, 'reason') ?? 'CLI retry' },
          { idempotencyKey: randomUUID() },
        ),
      );
      return;
    }
  } else {
    if (action === 'list') {
      output.value(
        (
          await client.query(
            'session.list',
            ListSessionsQuerySchema,
            ListSessionsResultSchema,
            {
              cursor: optionString(parsed, 'cursor'),
              limit: optionNumber(parsed, 'limit', 50),
              agentId: optionString(parsed, 'agent'),
              status: optionString(parsed, 'status') as never,
            },
          )
        ).items,
      );
      return;
    }
    if (!id) throw new Error('缺少 session key');
    const generation = optionNumber(parsed, 'generation', 1);
    const current = await client.query(
      'session.show',
      ShowSessionQuerySchema,
      ShowSessionResultSchema,
      { sessionKey: id, generation },
    );
    if (action === 'show') {
      output.value(current);
      return;
    }
    if (action === 'invalidate') {
      output.value(
        await client.request(
          'session.invalidate',
          InvalidateSessionCommandSchema,
          InvalidateSessionResultSchema,
          {
            sessionKey: id,
            generation,
            expectedRevision: current.session.revision,
            reason: optionString(parsed, 'reason') ?? 'CLI invalidate',
          },
        ),
      );
      return;
    }
  }
  throw new Error(`未知 ${group} 命令: ${action}`);
}
