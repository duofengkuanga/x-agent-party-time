import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULTS, ENV_NAMES, LOCAL_PATHS } from '@agent-party-time/shared';

const ControlPlaneFileConfigSchema = z
  .object({
    repairDispatch: z
      .object({
        maxBugs: z.number().int().positive().optional(),
        delayMs: z.number().int().positive().optional(),
        infrastructureRetries: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    deploymentBatch: z
      .object({
        maxBugs: z.number().int().positive().optional(),
        delayMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface ControlPlaneRuntimeConfig {
  repairDispatch: {
    maxBugs: number;
    delayMs: number;
    infrastructureRetries: number;
  };
  deploymentBatch: {
    maxBugs: number;
    delayMs: number;
  };
}

export async function loadControlPlaneConfig(
  homeDirectory: string,
  env: Record<string, string | undefined>,
): Promise<ControlPlaneRuntimeConfig> {
  let fileConfig: z.infer<typeof ControlPlaneFileConfigSchema> = {};
  try {
    const content = await readFile(
      resolve(homeDirectory, LOCAL_PATHS.controlPlaneConfigFile),
      'utf8',
    );
    fileConfig = ControlPlaneFileConfigSchema.parse(JSON.parse(content));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return {
    repairDispatch: {
      maxBugs: positiveInteger(
        env[ENV_NAMES.repairDispatchMaxBugs],
        fileConfig.repairDispatch?.maxBugs ?? DEFAULTS.repairDispatchMaxBugs,
        ENV_NAMES.repairDispatchMaxBugs,
      ),
      delayMs: positiveInteger(
        env[ENV_NAMES.repairDispatchDelayMs],
        fileConfig.repairDispatch?.delayMs ?? DEFAULTS.repairDispatchDelayMs,
        ENV_NAMES.repairDispatchDelayMs,
      ),
      infrastructureRetries: nonnegativeInteger(
        env[ENV_NAMES.repairInfrastructureRetries],
        fileConfig.repairDispatch?.infrastructureRetries ??
          DEFAULTS.repairInfrastructureRetries,
        ENV_NAMES.repairInfrastructureRetries,
      ),
    },
    deploymentBatch: {
      maxBugs: positiveInteger(
        env[ENV_NAMES.deploymentBatchMaxBugs],
        fileConfig.deploymentBatch?.maxBugs ?? DEFAULTS.deploymentBatchMaxBugs,
        ENV_NAMES.deploymentBatchMaxBugs,
      ),
      delayMs: positiveInteger(
        env[ENV_NAMES.deploymentBatchDelayMs],
        fileConfig.deploymentBatch?.delayMs ?? DEFAULTS.deploymentBatchDelayMs,
        ENV_NAMES.deploymentBatchDelayMs,
      ),
    },
  };
}

function positiveInteger(
  rawValue: string | undefined,
  fallback: number,
  name: string,
) {
  if (rawValue === undefined) return fallback;
  return z.coerce
    .number({ error: `${name} 必须是正整数` })
    .int()
    .positive()
    .parse(rawValue);
}

function nonnegativeInteger(
  rawValue: string | undefined,
  fallback: number,
  name: string,
) {
  if (rawValue === undefined) return fallback;
  return z.coerce
    .number({ error: `${name} 必须是非负整数` })
    .int()
    .nonnegative()
    .parse(rawValue);
}
