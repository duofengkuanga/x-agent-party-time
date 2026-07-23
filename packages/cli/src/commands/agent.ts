import { randomUUID } from 'node:crypto';
import {
  AddAgentCommandSchema,
  AgentMutationResultSchema,
  DisableAgentCommandSchema,
  EnableAgentCommandSchema,
  GetAgentQuerySchema,
  GetAgentResultSchema,
  ListAgentsQuerySchema,
  ListAgentsResultSchema,
  UpdateAgentCommandSchema,
} from '@agent-party-time/shared';
import {
  optionBoolean,
  optionNumber,
  optionString,
  parseArgs,
} from '../args.js';
import type { ServiceClient } from '../client/service-client.js';
import type { Output } from '../output.js';

export async function runAgentCommand(
  action: string,
  args: readonly string[],
  client: ServiceClient,
  output: Output,
) {
  const parsed = parseArgs(args);
  const id = parsed.positionals[0];
  if (action === 'list') {
    const result = await client.query(
      'agent.list',
      ListAgentsQuerySchema,
      ListAgentsResultSchema,
      {
        cursor: optionString(parsed, 'cursor'),
        limit: optionNumber(parsed, 'limit', 50),
        enabled: optionBoolean(parsed, 'enabled')
          ? true
          : optionBoolean(parsed, 'disabled')
            ? false
            : undefined,
        role: optionString(parsed, 'role') as never,
      },
    );
    output.value(result.items);
    return;
  }
  if (action === 'show') {
    if (!id) throw new Error('缺少 agent id');
    output.value(
      await client.query(
        'agent.get',
        GetAgentQuerySchema,
        GetAgentResultSchema,
        { id },
      ),
    );
    return;
  }
  if (action === 'add') {
    const input = AddAgentCommandSchema.parse({
      id: optionString(parsed, 'id') ?? randomUUID(),
      expectedRevision: await revision(client),
      name: required(parsed, 'name'),
      workspacePath: required(parsed, 'workspace'),
      role: optionString(parsed, 'role') ?? 'front',
      model: optionString(parsed, 'model'),
      instructions: optionString(parsed, 'instructions'),
    });
    output.value(
      await client.request(
        'agent.add',
        AddAgentCommandSchema,
        AgentMutationResultSchema,
        input,
        { idempotencyKey: `agent:${input.id}` },
      ),
    );
    return;
  }
  if (!id) throw new Error('缺少 agent id');
  const current = await client.query(
    'agent.get',
    GetAgentQuerySchema,
    GetAgentResultSchema,
    { id },
  );
  if (action === 'update') {
    const patch = Object.fromEntries(
      [
        ['name', optionString(parsed, 'name')],
        ['workspacePath', optionString(parsed, 'workspace')],
        ['model', optionString(parsed, 'model')],
        ['instructions', optionString(parsed, 'instructions')],
        ['role', optionString(parsed, 'role')],
      ].filter(([, value]) => value !== undefined),
    );
    output.value(
      await client.request(
        'agent.update',
        UpdateAgentCommandSchema,
        AgentMutationResultSchema,
        { id, expectedRevision: current.configRevision, patch },
      ),
    );
    return;
  }
  const schema =
    action === 'enable' ? EnableAgentCommandSchema : DisableAgentCommandSchema;
  output.value(
    await client.request(`agent.${action}`, schema, AgentMutationResultSchema, {
      id,
      expectedRevision: current.configRevision,
    }),
  );
}
async function revision(client: ServiceClient) {
  return (
    await client.query(
      'agent.list',
      ListAgentsQuerySchema,
      ListAgentsResultSchema,
      { limit: 1 },
    )
  ).configRevision;
}
function required(parsed: ReturnType<typeof parseArgs>, key: string) {
  const value = optionString(parsed, key);
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}
