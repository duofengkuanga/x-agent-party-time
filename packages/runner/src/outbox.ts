import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  CompleteExecutionRequestSchema,
  ExecutionStartRequestSchema,
} from '@agent-party-time/execution-contract';
import { z } from 'zod';
import { runnerLocalPaths, type RunnerLocalPaths } from './state';

const OutboxEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.uuid(),
    kind: z.literal('START'),
    executionId: z.uuid(),
    request: ExecutionStartRequestSchema,
    createdAt: z.iso.datetime(),
  }),
  z.object({
    id: z.uuid(),
    kind: z.literal('OUTCOME'),
    executionId: z.uuid(),
    request: CompleteExecutionRequestSchema,
    createdAt: z.iso.datetime(),
  }),
]);

export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

export class ExecutionOutbox {
  constructor(
    private readonly paths: RunnerLocalPaths = runnerLocalPaths(),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async add(
    input:
      | {
          kind: 'START';
          executionId: string;
          request: z.input<typeof ExecutionStartRequestSchema>;
        }
      | {
          kind: 'OUTCOME';
          executionId: string;
          request: z.input<typeof CompleteExecutionRequestSchema>;
        },
  ): Promise<OutboxEntry> {
    const entry = OutboxEntrySchema.parse({
      ...input,
      id: this.createId(),
      createdAt: this.now().toISOString(),
    });
    await mkdir(this.paths.outbox, { recursive: true, mode: 0o700 });
    const path = this.path(entry.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, path);
    return entry;
  }

  async list(): Promise<OutboxEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.paths.outbox);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) =>
          OutboxEntrySchema.parse(
            JSON.parse(await readFile(join(this.paths.outbox, name), 'utf8')),
          ),
        ),
    );
    return entries.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        Number(a.kind === 'OUTCOME') - Number(b.kind === 'OUTCOME') ||
        a.id.localeCompare(b.id),
    );
  }

  async remove(id: string): Promise<void> {
    await rm(this.path(z.uuid().parse(id)), { force: true });
  }

  private path(id: string): string {
    return join(this.paths.outbox, `${id}.json`);
  }
}
