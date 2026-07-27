import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  RunnerCredentialSchema,
  RunnerIdSchema,
} from '@agent-party-time/runner-contract';
import { normalizeServerUrl } from './server-url';

export const RunnerConfigSchema = z.object({
  serverUrl: z.url(),
  runnerId: RunnerIdSchema,
  credential: RunnerCredentialSchema,
});

export const LocalBindingSchema = z.object({
  bindingId: z.uuid(),
  repositoryPath: z.string().min(1),
  updatedAt: z.iso.datetime(),
});

const BindingStateSchema = z.object({
  bindings: z.record(z.uuid(), LocalBindingSchema),
});

export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;
export type LocalBinding = z.infer<typeof LocalBindingSchema>;

export type RunnerLocalPaths = {
  root: string;
  config: string;
  bindings: string;
  executions: string;
  outbox: string;
};

export function runnerLocalPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RunnerLocalPaths {
  const root = resolve(
    env.AGENT_PARTY_TIME_RUNNER_HOME ??
      join(homedir(), '.agent-party-time', 'runner'),
  );
  return {
    root,
    config: join(root, 'config.json'),
    bindings: join(root, 'bindings.json'),
    executions: join(root, 'executions'),
    outbox: join(root, 'outbox'),
  };
}

export class RunnerStateStore {
  constructor(
    private readonly paths: RunnerLocalPaths = runnerLocalPaths(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async saveConfig(input: RunnerConfig): Promise<void> {
    const config = RunnerConfigSchema.parse({
      ...input,
      serverUrl: normalizeServerUrl(input.serverUrl),
    });
    await writePrivateJson(this.paths.config, config);
  }

  async loadConfig(): Promise<RunnerConfig> {
    return RunnerConfigSchema.parse(
      await readRequiredJson(this.paths.config, 'Runner 尚未完成配对'),
    );
  }

  async bind(bindingId: string, repositoryPath: string): Promise<LocalBinding> {
    const absolutePath = normalizeAbsolutePath(repositoryPath);
    const current = await this.readBindingState();
    const binding = LocalBindingSchema.parse({
      bindingId,
      repositoryPath: absolutePath,
      updatedAt: this.now().toISOString(),
    });
    current.bindings[binding.bindingId] = binding;
    await writePrivateJson(this.paths.bindings, current);
    return binding;
  }

  async resolveBinding(bindingId: string): Promise<string | null> {
    const parsedId = z.uuid().parse(bindingId);
    return (
      (await this.readBindingState()).bindings[parsedId]?.repositoryPath ?? null
    );
  }

  async listBindings(): Promise<LocalBinding[]> {
    return Object.values((await this.readBindingState()).bindings).sort(
      (a, b) => a.bindingId.localeCompare(b.bindingId),
    );
  }

  async fileModes(): Promise<{
    config?: number;
    bindings?: number;
    root?: number;
  }> {
    const modes: { config?: number; bindings?: number; root?: number } = {};
    for (const [key, path] of Object.entries({
      config: this.paths.config,
      bindings: this.paths.bindings,
      root: this.paths.root,
    }) as Array<[keyof typeof modes, string]>) {
      try {
        modes[key] = (await stat(path)).mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return modes;
  }

  private async readBindingState(): Promise<
    z.infer<typeof BindingStateSchema>
  > {
    try {
      return BindingStateSchema.parse(
        JSON.parse(await readFile(this.paths.bindings, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { bindings: {} };
      throw error;
    }
  }
}

function normalizeAbsolutePath(value: string): string {
  if (!isAbsolute(value)) throw new Error('仓库路径必须是本机绝对路径');
  return resolve(value);
}

async function readRequiredJson(
  path: string,
  missingMessage: string,
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(missingMessage);
    throw error;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
