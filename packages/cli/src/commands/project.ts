import {
  BindProjectCommandSchema,
  BindProjectResultSchema,
  ListProjectBindingsQuerySchema,
  ListProjectBindingsResultSchema,
} from '@agent-party-time/shared';
import { optionString, parseArgs } from '../args.js';
import type { ServiceClient } from '../client/service-client.js';
import type { Output } from '../output.js';

export async function runProjectCommand(
  action: string,
  args: readonly string[],
  client: ServiceClient,
  output: Output,
) {
  const parsed = parseArgs(args);
  if (action === 'list') {
    const result = await client.query(
      'project.binding.list',
      ListProjectBindingsQuerySchema,
      ListProjectBindingsResultSchema,
      {},
    );
    output.value(result.items);
    return;
  }
  if (action === 'bind') {
    const input = BindProjectCommandSchema.parse({
      project: required(parsed, 'project'),
      repositoryPath: optionString(parsed, 'repo') ?? process.cwd(),
      baseBranch: optionString(parsed, 'base'),
    });
    const result = await client.request(
      'project.bind',
      BindProjectCommandSchema,
      BindProjectResultSchema,
      input,
      {
        idempotencyKey: `project-bind:${input.project}`,
      },
    );
    output.value(result.binding);
    return;
  }
  throw new Error(`未知 project 命令: ${action}`);
}

function required(parsed: ReturnType<typeof parseArgs>, key: string) {
  const value = optionString(parsed, key);
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}
