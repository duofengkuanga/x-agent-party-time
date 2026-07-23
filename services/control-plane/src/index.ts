import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULTS, ENV_NAMES, LOCAL_PATHS } from '@agent-party-time/shared';
import { ControlPlaneServer } from './server.js';
import { ControlPlaneStore } from './store.js';
import { loadControlPlaneConfig } from './config.js';

export const ControlPlaneOptionsSchema = z.object({
  homeDirectory: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(0).max(65_535).optional(),
  runnerOfflineAfterMs: z.number().int().positive().optional(),
  repairDispatchMaxBugs: z.number().int().positive().optional(),
  repairDispatchDelayMs: z.number().int().positive().optional(),
  repairInfrastructureRetries: z.number().int().nonnegative().optional(),
  collaborativeAutomaticUpdateDelayMs: z
    .number()
    .int()
    .nonnegative()
    .optional(),
  deploymentBatchMaxBugs: z.number().int().positive().optional(),
  deploymentBatchDelayMs: z.number().int().positive().optional(),
  now: z.custom<() => Date>((value) => typeof value === 'function').optional(),
  env: z.record(z.string(), z.string().optional()).optional(),
});
export type ControlPlaneOptions = z.infer<typeof ControlPlaneOptionsSchema>;

export interface ControlPlaneHandle {
  address(): string;
  close(): Promise<void>;
}

export async function startControlPlane(rawOptions: ControlPlaneOptions = {}) {
  const options = ControlPlaneOptionsSchema.parse(rawOptions);
  const env = { ...process.env, ...options.env };
  const homeDirectory = resolve(
    options.homeDirectory ??
      env[ENV_NAMES.home] ??
      resolve(homedir(), LOCAL_PATHS.homeDirName),
  );
  const runtimeConfig = await loadControlPlaneConfig(homeDirectory, env);
  const configuredPort = Number(env[ENV_NAMES.controlPlanePort]);
  const store = await ControlPlaneStore.open(
    resolve(homeDirectory, LOCAL_PATHS.controlPlaneStateFile),
    {
      attachmentsDirectory: resolve(
        homeDirectory,
        LOCAL_PATHS.controlPlaneAttachmentsDir,
      ),
      runnerOfflineAfterMs:
        options.runnerOfflineAfterMs ?? DEFAULTS.runnerOfflineAfterMs,
      repairDispatchConfig: {
        maxBugs:
          options.repairDispatchMaxBugs ?? runtimeConfig.repairDispatch.maxBugs,
        delayMs:
          options.repairDispatchDelayMs ?? runtimeConfig.repairDispatch.delayMs,
      },
      repairInfrastructureRetries:
        options.repairInfrastructureRetries ??
        runtimeConfig.repairDispatch.infrastructureRetries,
      collaborativeAutomaticUpdateDelayMs:
        options.collaborativeAutomaticUpdateDelayMs,
      deploymentBatchConfig: {
        maxBugs:
          options.deploymentBatchMaxBugs ??
          runtimeConfig.deploymentBatch.maxBugs,
        delayMs:
          options.deploymentBatchDelayMs ??
          runtimeConfig.deploymentBatch.delayMs,
      },
      now: options.now,
    },
  );
  const server = new ControlPlaneServer({
    host:
      options.host ??
      env[ENV_NAMES.controlPlaneHost] ??
      DEFAULTS.controlPlaneHost,
    port:
      options.port ??
      (Number.isInteger(configuredPort)
        ? configuredPort
        : DEFAULTS.controlPlanePort),
    store,
  });
  try {
    await server.start();
  } catch (error) {
    store.close();
    throw error;
  }
  return {
    address: () => server.address(),
    close: async () => {
      await server.close();
      store.close();
    },
  } satisfies ControlPlaneHandle;
}

export { ControlPlaneServer } from './server.js';
export { ControlPlaneStore } from './store.js';
