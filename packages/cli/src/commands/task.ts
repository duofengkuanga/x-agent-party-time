import { randomUUID } from 'node:crypto';
import {
  AssignTaskCommandSchema,
  ChangeTaskStateCommandSchema,
  ClaimTaskCommandSchema,
  CreateTaskCommandSchema,
  CreateTaskFromMessageCommandSchema,
  GetTaskQuerySchema,
  GetTaskResultSchema,
  ListTasksQuerySchema,
  ListTasksResultSchema,
  ReviewCompletionCommandSchema,
  SubmitCompletionCommandSchema,
  TaskMutationResultSchema,
  type TaskActor,
  type TaskAssignee,
} from '@agent-party-time/shared';
import {
  optionNumber,
  optionString,
  optionStrings,
  parseArgs,
} from '../args.js';
import type { ServiceClient } from '../client/service-client.js';
import type { Output } from '../output.js';

export async function runTaskCommand(
  action: string,
  args: readonly string[],
  client: ServiceClient,
  output: Output,
) {
  const parsed = parseArgs(args);
  const id = parsed.positionals[0];
  if (action === 'list') {
    output.value(
      (
        await client.query(
          'task.list',
          ListTasksQuerySchema,
          ListTasksResultSchema,
          {
            cursor: optionString(parsed, 'cursor'),
            limit: optionNumber(parsed, 'limit', 50),
            state: optionString(parsed, 'state') as never,
            priority: optionString(parsed, 'priority') as never,
          },
        )
      ).items,
    );
    return;
  }
  if (action === 'show') {
    if (!id) throw new Error('缺少 task id');
    output.value(await get(client, id));
    return;
  }
  if (action === 'create') {
    const taskId = optionString(parsed, 'id') ?? randomUUID();
    const input = CreateTaskCommandSchema.parse({
      taskId,
      title: required(parsed, 'title'),
      description: optionString(parsed, 'description') ?? '',
      priority: optionString(parsed, 'priority') ?? 'normal',
      assignee: optionString(parsed, 'assignee')
        ? assignee(optionString(parsed, 'assignee')!)
        : null,
      creator: taskActor(optionString(parsed, 'creator') ?? 'human:cli'),
      labels: optionStrings(parsed, 'label'),
      parentTaskId: optionString(parsed, 'parent') ?? null,
    });
    output.value(
      await client.request(
        'task.create',
        CreateTaskCommandSchema,
        TaskMutationResultSchema,
        input,
        { idempotencyKey: `task:${taskId}` },
      ),
    );
    return;
  }
  if (action === 'from') {
    const input = CreateTaskFromMessageCommandSchema.parse({
      anchor: {
        channelKey: required(parsed, 'channel'),
        sourceSeq: required(parsed, 'seq'),
        ...(optionString(parsed, 'event-id')
          ? { eventId: optionString(parsed, 'event-id') }
          : {}),
      },
      creator: taskActor(optionString(parsed, 'creator') ?? 'human:cli'),
      priority: optionString(parsed, 'priority') ?? 'normal',
      assignee: optionString(parsed, 'assignee')
        ? assignee(optionString(parsed, 'assignee')!)
        : null,
      parentTaskId: optionString(parsed, 'parent') ?? null,
    });
    output.value(
      await client.request(
        'task.create_from_message',
        CreateTaskFromMessageCommandSchema,
        TaskMutationResultSchema,
        input,
        { idempotencyKey: randomUUID() },
      ),
    );
    return;
  }
  if (!id) throw new Error('缺少 task id');
  const current = await get(client, id);
  const base = { taskId: id, expectedRevision: current.task.revision };
  if (action === 'assign') {
    const input = AssignTaskCommandSchema.parse({
      ...base,
      assignee: assignee(required(parsed, 'assignee')),
      actor: taskActor(optionString(parsed, 'actor') ?? 'human:cli'),
      reason: optionString(parsed, 'reason'),
    });
    output.value(
      await client.request(
        'task.assign',
        AssignTaskCommandSchema,
        TaskMutationResultSchema,
        input,
      ),
    );
    return;
  }
  if (action === 'claim') {
    const input = ClaimTaskCommandSchema.parse({
      ...base,
      actor: taskActor(optionString(parsed, 'actor') ?? 'human:cli'),
    });
    output.value(
      await client.request(
        'task.claim',
        ClaimTaskCommandSchema,
        TaskMutationResultSchema,
        input,
      ),
    );
    return;
  }
  if (action === 'status') {
    const nextState = parsed.positionals[1];
    if (!nextState) throw new Error('缺少目标状态');
    const input = ChangeTaskStateCommandSchema.parse({
      ...base,
      nextState,
      actor: taskActor(optionString(parsed, 'actor') ?? 'human:cli'),
      reason: optionString(parsed, 'reason'),
    });
    output.value(
      await client.request(
        'task.change_state',
        ChangeTaskStateCommandSchema,
        TaskMutationResultSchema,
        input,
      ),
    );
    return;
  }
  if (action === 'complete') {
    const input = SubmitCompletionCommandSchema.parse({
      ...base,
      submittedBy: taskActor(optionString(parsed, 'actor') ?? 'human:cli'),
      summary: required(parsed, 'summary'),
      references: optionStrings(parsed, 'ref').map(reference),
      runId: optionString(parsed, 'run'),
    });
    output.value(
      await client.request(
        'task.submit_completion',
        SubmitCompletionCommandSchema,
        TaskMutationResultSchema,
        input,
      ),
    );
    return;
  }
  if (action === 'review') {
    const decision = parsed.options.approve
      ? 'approve'
      : parsed.options.reject
        ? 'reject'
        : undefined;
    if (!decision) throw new Error('需要 --approve 或 --reject');
    const input = ReviewCompletionCommandSchema.parse({
      ...base,
      reviewer: taskActor(optionString(parsed, 'actor') ?? 'human:cli'),
      decision,
      reason: optionString(parsed, 'reason'),
    });
    output.value(
      await client.request(
        'task.review_completion',
        ReviewCompletionCommandSchema,
        TaskMutationResultSchema,
        input,
      ),
    );
    return;
  }
  throw new Error(`未知 task 命令: ${action}`);
}
function get(client: ServiceClient, id: string) {
  return client.query('task.get', GetTaskQuerySchema, GetTaskResultSchema, {
    taskId: id,
  });
}
function taskActor(value: string): TaskActor {
  const [kind, ...rest] = value.split(':');
  if (!['agent', 'human', 'system'].includes(kind!) || !rest.length)
    throw new Error('actor 格式应为 agent:id、human:id 或 system:id');
  return { kind: kind as TaskActor['kind'], id: rest.join(':') } as TaskActor;
}
function assignee(value: string): TaskAssignee {
  const [kind, ...rest] = value.split(':');
  if (!['agent', 'human', 'squad'].includes(kind!) || !rest.length)
    throw new Error('assignee 格式应为 agent:id、human:id 或 squad:id');
  return {
    kind: kind as TaskAssignee['kind'],
    id: rest.join(':'),
  } as TaskAssignee;
}
function reference(value: string) {
  const [kind, ...rest] = value.split(':');
  return {
    kind: kind as 'file' | 'url' | 'run' | 'message' | 'text',
    value: rest.join(':'),
  };
}
function required(parsed: ReturnType<typeof parseArgs>, key: string) {
  const value = optionString(parsed, key);
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}
