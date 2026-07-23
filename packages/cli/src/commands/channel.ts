import { randomUUID } from 'node:crypto';
import {
  AddChannelCommandSchema,
  ChannelMutationResultSchema,
  DisableChannelCommandSchema,
  EnableChannelCommandSchema,
  GetChannelQuerySchema,
  GetChannelResultSchema,
  ListChannelsQuerySchema,
  ListChannelsResultSchema,
  RemoveChannelCommandSchema,
  RemoveChannelResultSchema,
  UpdateChannelCommandSchema,
} from '@agent-party-time/shared';
import { optionNumber, optionString, parseArgs } from '../args.js';
import type { ServiceClient } from '../client/service-client.js';
import type { Output } from '../output.js';
export async function runChannelCommand(
  action: string,
  args: readonly string[],
  client: ServiceClient,
  output: Output,
) {
  const parsed = parseArgs(args);
  const id = parsed.positionals[0];
  if (action === 'list') {
    const result = await client.query(
      'channel.list',
      ListChannelsQuerySchema,
      ListChannelsResultSchema,
      {
        cursor: optionString(parsed, 'cursor'),
        limit: optionNumber(parsed, 'limit', 50),
        transport: optionString(parsed, 'transport'),
        agentId: optionString(parsed, 'agent'),
      },
    );
    output.value(result.items);
    return;
  }
  if (action === 'show') {
    if (!id) throw new Error('缺少 channel id');
    output.value(
      await client.query(
        'channel.get',
        GetChannelQuerySchema,
        GetChannelResultSchema,
        { id },
      ),
    );
    return;
  }
  if (action === 'add') {
    const input = {
      id: optionString(parsed, 'id') ?? randomUUID(),
      expectedRevision: await revision(client),
      channelKey: required(parsed, 'channel'),
      transport: required(parsed, 'transport'),
      agentId: required(parsed, 'agent'),
      trigger: trigger(parsed),
      tokenRef: optionString(parsed, 'token-ref'),
    };
    output.value(
      await client.request(
        'channel.add',
        AddChannelCommandSchema,
        ChannelMutationResultSchema,
        input,
        { idempotencyKey: `channel:${input.id}` },
      ),
    );
    return;
  }
  if (!id) throw new Error('缺少 channel id');
  const current = await client.query(
    'channel.get',
    GetChannelQuerySchema,
    GetChannelResultSchema,
    { id },
  );
  if (action === 'update') {
    const patch: Record<string, unknown> = {};
    for (const [option, field] of [
      ['channel', 'channelKey'],
      ['transport', 'transport'],
      ['agent', 'agentId'],
      ['token-ref', 'tokenRef'],
    ] as const) {
      const value = optionString(parsed, option);
      if (value !== undefined) patch[field] = value;
    }
    if (optionString(parsed, 'trigger')) patch.trigger = trigger(parsed);
    output.value(
      await client.request(
        'channel.update',
        UpdateChannelCommandSchema,
        ChannelMutationResultSchema,
        { id, expectedRevision: current.configRevision, patch },
      ),
    );
    return;
  }
  if (action === 'remove') {
    output.value(
      await client.request(
        'channel.remove',
        RemoveChannelCommandSchema,
        RemoveChannelResultSchema,
        { id, expectedRevision: current.configRevision },
      ),
    );
    return;
  }
  const schema =
    action === 'enable'
      ? EnableChannelCommandSchema
      : DisableChannelCommandSchema;
  output.value(
    await client.request(
      `channel.${action}`,
      schema,
      ChannelMutationResultSchema,
      { id, expectedRevision: current.configRevision },
    ),
  );
}
function trigger(parsed: ReturnType<typeof parseArgs>) {
  const kind = optionString(parsed, 'trigger') ?? 'mention';
  if (kind === 'mention') return { kind: 'direct_mention' as const };
  if (kind === 'prefix')
    return { kind: 'prefix' as const, prefix: required(parsed, 'prefix') };
  if (kind === 'all') return { kind: 'all_messages' as const };
  if (kind === 'task-assignment') return { kind: 'task_assignment' as const };
  throw new Error(`无效 trigger: ${kind}`);
}
async function revision(client: ServiceClient) {
  return (
    await client.query(
      'channel.list',
      ListChannelsQuerySchema,
      ListChannelsResultSchema,
      { limit: 1 },
    )
  ).configRevision;
}
function required(parsed: ReturnType<typeof parseArgs>, key: string) {
  const value = optionString(parsed, key);
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}
