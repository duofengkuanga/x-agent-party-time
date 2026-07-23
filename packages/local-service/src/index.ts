import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import {
  DEFAULTS,
  ENV_NAMES,
  LOCAL_PATHS,
  LogLevelSchema,
  type AgentRunner,
  type ChannelTransportFactory,
} from '@agent-party-time/shared';
import {
  HttpControlPlaneAdapter,
  type ControlPlanePort,
} from '@agent-party-time/control-plane-client';
import { LocalApiServer } from './api/server.js';
import { ChannelManager } from './channels/channel-manager.js';
import { ConfigService } from './config/config-service.js';
import { EventJournal } from './events/event-journal.js';
import { HeartbeatService, SYSTEM_CLOCK } from './health/heartbeat.js';
import { InstanceLock } from './lifecycle/instance-lock.js';
import { JsonlLogger, LogQueryService } from './logging/logger.js';
import { ReplyOutbox } from './outbox/reply-outbox.js';
import { CodexRunner } from './runners/codex-runner.js';
import { Scheduler } from './scheduler/scheduler.js';
import {
  TokenResolver,
  type KeychainAdapter,
} from './security/token-resolver.js';
import {
  SessionManager,
  DEFAULT_WORKSPACE_RESOLVER,
} from './sessions/session-manager.js';
import { FileConfigStore } from './store/config-store.js';
import { SqliteStateStore } from './store/state-store.js';
import {
  ServiceSupervisor,
  type ServiceStatus,
} from './supervisor/supervisor.js';
import { TaskService } from './tasks/task-service.js';
import { TeamCoordinator } from './teams/team-coordinator.js';
import {
  CodexAppServerExecutor,
  type RepairExecutor,
  type StructuredExecutor,
} from './control-plane/codex-app-server.js';
import { CollaborativeSubmissionWorker } from './control-plane/collaborative-submission-worker.js';
import { ProjectBindingService } from './control-plane/project-binding-service.js';
import { EngineeringBindingService } from './control-plane/engineering-binding-service.js';
import { BugRepairWorker } from './control-plane/repair-worker.js';
import { RunnerRegistration } from './control-plane/runner-registration.js';
import { RunnerStateStore } from './control-plane/runner-state-store.js';

export const LocalServiceOptionsSchema = z.object({
  homeDirectory: z.string().min(1).optional(),
  apiHost: z.string().min(1).optional(),
  apiPort: z.number().int().min(0).max(65_535).optional(),
  logLevel: LogLevelSchema.optional(),
  controlPlaneUrl: z.string().url().optional(),
  runnerName: z.string().trim().min(1).max(80).optional(),
  codexExecutable: z.string().trim().min(1).optional(),
  env: z.record(z.string(), z.string().optional()).optional(),
});
export type LocalServiceOptions = z.infer<typeof LocalServiceOptionsSchema>;
export interface LocalServiceDependencies {
  transports?: Readonly<Record<string, ChannelTransportFactory>>;
  keychain?: KeychainAdapter;
  runner?: AgentRunner;
  controlPlane?: ControlPlanePort;
  repairExecutor?: RepairExecutor;
  collaborativeExecutor?: StructuredExecutor;
}
export interface LocalServiceHandle {
  readonly instanceId: string;
  address(): string;
  status(): Promise<ServiceStatus>;
  shutdown(reason: string): Promise<void>;
  waitUntilStopped(): Promise<void>;
}

export async function startLocalService(
  rawOptions: LocalServiceOptions = {},
  dependencies: LocalServiceDependencies = {},
): Promise<LocalServiceHandle> {
  const options = LocalServiceOptionsSchema.parse(rawOptions);
  const env = { ...process.env, ...options.env };
  const homeDirectory = resolve(
    options.homeDirectory ??
      env[ENV_NAMES.home] ??
      resolve(homedir(), LOCAL_PATHS.homeDirName),
  );
  const configPath = resolve(homeDirectory, LOCAL_PATHS.serviceConfigFile);
  const statePath = resolve(homeDirectory, LOCAL_PATHS.serviceStateFile);
  const lockPath = resolve(homeDirectory, LOCAL_PATHS.serviceLockFile);
  const logsDirectory = resolve(homeDirectory, LOCAL_PATHS.serviceLogsDir);
  const runnerStatePath = resolve(homeDirectory, LOCAL_PATHS.runnerStateFile);
  const repairAttemptsDirectory = resolve(
    homeDirectory,
    LOCAL_PATHS.repairAttemptsDir,
  );
  const collaborativeArtifactsDirectory = resolve(
    homeDirectory,
    'service/collaborative-submissions',
  );
  const capabilityPath = resolve(
    homeDirectory,
    env[ENV_NAMES.capabilityFile] ?? LOCAL_PATHS.serviceCapabilityFile,
  );
  await mkdir(resolve(homeDirectory, LOCAL_PATHS.serviceDir), {
    recursive: true,
    mode: 0o700,
  });
  const instanceId = randomUUID();
  const logger = new JsonlLogger({
    directory: logsDirectory,
    level:
      options.logLevel ??
      (env[ENV_NAMES.logLevel] as z.infer<typeof LogLevelSchema> | undefined) ??
      DEFAULTS.logLevel,
    stdout: true,
    maxFileBytes: 10 * 1024 * 1024,
    maxFiles: 5,
    baseContext: { instanceId },
  });
  const lock = await new InstanceLock({
    lockPath,
    dataDirectory: resolve(homeDirectory, LOCAL_PATHS.serviceDir),
    staleAfterMs: DEFAULTS.heartbeatStaleAfterMs,
    logger,
  }).acquire(instanceId);
  let store: SqliteStateStore | null = null;
  let runner: AgentRunner | null = null;
  let tokenResolver: TokenResolver | null = null;
  let registration: RunnerRegistration | null = null;
  let codexExecutor: CodexAppServerExecutor | null = null;
  try {
    const configStore = new FileConfigStore({
      configPath,
      migrations: [],
      logger,
    });
    store = await SqliteStateStore.open({
      databasePath: statePath,
      logger,
      clock: SYSTEM_CLOCK,
      busyTimeoutMs: 5_000,
    });
    await store.integrityCheck();
    const config = await configStore.load();
    const configService = new ConfigService({
      store: configStore,
      workspaceResolver: (path) => DEFAULT_WORKSPACE_RESOLVER.resolve(path),
      logger,
    });
    tokenResolver = new TokenResolver({
      env,
      cacheTtlMs: 60_000,
      keychain: dependencies.keychain ?? { get: async () => null },
      allowedFileRoot: homeDirectory,
      logger,
    });
    const eventJournal = new EventJournal({
      repository: store.events,
      subscriberBufferSize: 256,
      logger,
    });
    const sessionManager = new SessionManager({
      sessions: store.sessions,
      clock: SYSTEM_CLOCK,
      workspaceResolver: DEFAULT_WORKSPACE_RESOLVER,
      logger,
    });
    const taskService = new TaskService({
      store,
      configStore,
      clock: SYSTEM_CLOCK,
      logger,
    });
    const controlPlane =
      dependencies.controlPlane ??
      new HttpControlPlaneAdapter({
        baseUrl:
          options.controlPlaneUrl ??
          env[ENV_NAMES.controlPlaneUrl] ??
          DEFAULTS.controlPlaneUrl,
      });
    const runnerState = new RunnerStateStore(runnerStatePath);
    const runnerIdentity = await runnerState.ensureIdentity(
      options.runnerName ??
        env[ENV_NAMES.runnerName] ??
        `Agent @ ${hostname()}`,
    );
    const projectBindings = new ProjectBindingService({
      controlPlane,
      stateStore: runnerState,
      runner: runnerIdentity,
    });
    const engineeringBindings = new EngineeringBindingService({
      controlPlane,
      stateStore: runnerState,
      runner: runnerIdentity,
    });
    registration = new RunnerRegistration({
      controlPlane,
      runner: runnerIdentity,
      intervalMs: DEFAULTS.runnerHeartbeatIntervalMs,
      logger,
    });
    codexExecutor = new CodexAppServerExecutor({
      executable:
        options.codexExecutable ?? env[ENV_NAMES.codexExecutable] ?? 'codex',
    });
    const repairExecutor = dependencies.repairExecutor ?? codexExecutor;
    const bugRepairWorker = new BugRepairWorker({
      controlPlane,
      runner: runnerIdentity,
      stateStore: runnerState,
      executor: repairExecutor,
      attemptsDirectory: repairAttemptsDirectory,
      logger,
      pollIntervalMs: DEFAULTS.repairWorkerPollIntervalMs,
      leaseRenewIntervalMs: DEFAULTS.repairLeaseRenewIntervalMs,
    });
    const collaborativeSubmissionWorker = new CollaborativeSubmissionWorker({
      controlPlane,
      runner: runnerIdentity,
      stateStore: runnerState,
      executor: dependencies.collaborativeExecutor ?? codexExecutor,
      artifactsDirectory: collaborativeArtifactsDirectory,
      logger,
      maxConcurrent: config.settings.maxConcurrentRuns,
      pollIntervalMs: DEFAULTS.repairWorkerPollIntervalMs,
      leaseRenewIntervalMs: DEFAULTS.repairLeaseRenewIntervalMs,
    });
    runner =
      dependencies.runner ?? new CodexRunner({ logger, clock: SYSTEM_CLOCK });
    let scheduler!: Scheduler;
    const channelManager = new ChannelManager({
      store,
      tokenResolver,
      clock: SYSTEM_CLOCK,
      logger,
      onJobQueued: () => scheduler?.notify(),
    });
    for (const [name, factory] of Object.entries(dependencies.transports ?? {}))
      channelManager.registerTransport(name, factory);
    scheduler = new Scheduler({
      instanceId,
      store,
      configStore,
      sessionManager,
      taskService,
      runner,
      clock: SYSTEM_CLOCK,
      logger,
      maxConcurrentRuns: config.settings.maxConcurrentRuns,
      leaseDurationMs: config.settings.leaseDurationMs,
    });
    const outbox = new ReplyOutbox({
      instanceId,
      store,
      channelManager,
      clock: SYSTEM_CLOCK,
      logger,
      leaseDurationMs: config.settings.leaseDurationMs,
      baseRetryDelayMs: DEFAULTS.outboxRetryBaseDelayMs,
    });
    const teams = new TeamCoordinator({
      store,
      configStore,
      clock: SYSTEM_CLOCK,
      logger,
      onJobQueued: () => scheduler.notify(),
    });
    const capability = await readOrCreateCapability(capabilityPath);
    let heartbeat!: HeartbeatService;
    let supervisor!: ServiceSupervisor;
    let shutdownAll = async (reason: string) => {
      await supervisor.shutdown(reason);
    };
    const apiServer = new LocalApiServer({
      host: options.apiHost ?? config.settings.localApiHost,
      port: options.apiPort ?? config.settings.localApiPort,
      capability,
      services: {
        config: configService,
        channels: channelManager,
        scheduler,
        sessions: sessionManager,
        tasks: taskService,
        teams,
        logs: new LogQueryService(logsDirectory),
        events: eventJournal,
        state: store,
        projectBindings,
        engineeringBindings,
        status: {
          status: async () => ({
            instance: heartbeat.snapshot()!,
            configRevision: (await configStore.load()).revision,
          }),
          shutdown: (reason) => void shutdownAll(reason),
        },
      },
      logger,
    });
    heartbeat = new HeartbeatService({
      instanceId,
      pid: process.pid,
      version: '0.1.0',
      intervalMs: config.settings.heartbeatIntervalMs,
      staleAfterMs: config.settings.heartbeatStaleAfterMs,
      clock: SYSTEM_CLOCK,
      store: store.heartbeats,
      lock,
      logger,
      onOwnershipLost: (error) => supervisor.shutdown(error.message),
    });
    supervisor = new ServiceSupervisor({
      configStore,
      apiServer,
      heartbeat,
      outbox,
      scheduler,
      channels: channelManager,
      eventJournal,
      backgroundWorkers: [
        { name: 'bug-repair', worker: bugRepairWorker },
        {
          name: 'collaborative-submission',
          worker: collaborativeSubmissionWorker,
        },
      ],
      logger,
      clock: SYSTEM_CLOCK,
      shutdownGracePeriodMs: DEFAULTS.shutdownGracePeriodMs,
    });
    await supervisor.start();
    registration.start();
    let closed = false;
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolvePromise) => {
      resolveStopped = resolvePromise;
    });
    shutdownAll = async (reason) => {
      if (closed) return stopped;
      closed = true;
      try {
        registration!.stop();
        await supervisor.shutdown(reason);
        await codexExecutor!.close();
        await runner!.close();
        tokenResolver!.close();
        await store!.close();
        await logger.close();
        await lock.release();
      } finally {
        resolveStopped();
      }
    };
    return {
      instanceId,
      address: () => apiServer.address(),
      status: async () => supervisor.status(),
      shutdown: shutdownAll,
      waitUntilStopped: () => stopped,
    };
  } catch (error) {
    registration?.stop();
    await codexExecutor?.close().catch(() => undefined);
    await runner?.close().catch(() => undefined);
    tokenResolver?.close();
    await store?.close().catch(() => undefined);
    await logger.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
    throw error;
  }
}

export async function createLocalService(
  options: LocalServiceOptions = {},
  dependencies: LocalServiceDependencies = {},
) {
  return startLocalService(options, dependencies);
}

async function readOrCreateCapability(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = randomBytes(32).toString('base64url');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${value}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(path, 0o600);
    return value;
  }
}

export * from './channels/channel-manager.js';
export * from './config/config-service.js';
export * from './events/event-journal.js';
export * from './health/heartbeat.js';
export * from './logging/logger.js';
export * from './control-plane/collaborative-submission-worker.js';
export * from './scheduler/scheduler.js';
export * from './sessions/session-manager.js';
export * from './tasks/task-service.js';
export * from './control-plane/codex-app-server.js';
export * from './control-plane/project-binding-service.js';
export * from './control-plane/engineering-binding-service.js';
export * from './control-plane/binding-execution-coordinator.js';
export * from './control-plane/repair-worker.js';
export * from './control-plane/runner-registration.js';
export * from './control-plane/runner-state-store.js';
