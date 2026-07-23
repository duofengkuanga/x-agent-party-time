import {
  BindEngineeringCommandSchema,
  BindEngineeringResultSchema,
  ListEngineeringBindingsLocalQuerySchema,
  ListEngineeringBindingsLocalResultSchema,
} from '@agent-party-time/shared';
import { optionString, parseArgs } from '../args.js';
import type { ServiceClient } from '../client/service-client.js';
import type { Output } from '../output.js';

export async function runEngineeringCommand(
  action: string,
  args: readonly string[],
  client: ServiceClient,
  output: Output,
) {
  const parsed = parseArgs(args);
  if (action === 'list') {
    const result = await client.query(
      'engineering.binding.list',
      ListEngineeringBindingsLocalQuerySchema,
      ListEngineeringBindingsLocalResultSchema,
      {},
    );
    output.value(result.items);
    return;
  }
  if (action === 'bind') {
    const input = BindEngineeringCommandSchema.parse({
      engineeringId: required(parsed, 'engineering'),
      pairingTicket: required(parsed, 'ticket'),
      repositoryPath: optionString(parsed, 'repo') ?? process.cwd(),
    });
    const result = await client.request(
      'engineering.bind',
      BindEngineeringCommandSchema,
      BindEngineeringResultSchema,
      input,
      { idempotencyKey: `engineering-bind:${input.engineeringId}` },
    );
    output.value(result.binding);
    return;
  }
  throw new Error(`未知 engineering 命令: ${action}`);
}

function required(parsed: ReturnType<typeof parseArgs>, key: string) {
  const value = optionString(parsed, key);
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}
