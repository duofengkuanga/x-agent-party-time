export const APP_NAME = 'Agent Party Time';
export const CLI_NAME = 'xapt';
export const PACKAGE_NAME = 'agent-party-time';
export const PROTOCOL_VERSION = 'agent-party-time.v1';
export const CONTROL_PLANE_PROTOCOL_VERSION =
  'agent-party-time.control-plane.v1';
export const CONFIG_SCHEMA_VERSION = 1;

export const ENV_NAMES = {
  home: 'AGENT_PARTY_TIME_HOME',
  serverUrl: 'AGENT_PARTY_TIME_SERVER',
  logLevel: 'AGENT_PARTY_TIME_LOG_LEVEL',
  capabilityFile: 'AGENT_PARTY_TIME_CAPABILITY_FILE',
  controlPlaneUrl: 'AGENT_PARTY_TIME_CONTROL_PLANE_URL',
  controlPlaneHost: 'AGENT_PARTY_TIME_CONTROL_PLANE_HOST',
  controlPlanePort: 'AGENT_PARTY_TIME_CONTROL_PLANE_PORT',
  repairDispatchMaxBugs: 'AGENT_PARTY_TIME_REPAIR_DISPATCH_MAX_BUGS',
  repairDispatchDelayMs: 'AGENT_PARTY_TIME_REPAIR_DISPATCH_DELAY_MS',
  deploymentBatchMaxBugs: 'AGENT_PARTY_TIME_DEPLOYMENT_BATCH_MAX_BUGS',
  deploymentBatchDelayMs: 'AGENT_PARTY_TIME_DEPLOYMENT_BATCH_DELAY_MS',
  repairInfrastructureRetries: 'AGENT_PARTY_TIME_REPAIR_INFRASTRUCTURE_RETRIES',
  runnerName: 'AGENT_PARTY_TIME_RUNNER_NAME',
  codexExecutable: 'AGENT_PARTY_TIME_CODEX_EXECUTABLE',
} as const;

export const LOCAL_PATHS = {
  homeDirName: '.agent-party-time',
  accountFile: 'account.json',
  serviceDir: 'service',
  serviceConfigFile: 'service/config.json',
  serviceStateFile: 'service/state.sqlite',
  serviceLockFile: 'service/service.lock',
  serviceLogsDir: 'service/logs',
  serviceCapabilityFile: 'service/capability',
  runnerStateFile: 'service/runner.json',
  repairAttemptsDir: 'service/repair-attempts',
  controlPlaneDir: 'control-plane',
  controlPlaneStateFile: 'control-plane/state.sqlite',
  controlPlaneConfigFile: 'control-plane/config.json',
  controlPlaneAttachmentsDir: 'control-plane/attachments',
} as const;

export const DEFAULTS = {
  localApiHost: '127.0.0.1',
  localApiPort: 43_120,
  controlPlaneHost: '127.0.0.1',
  controlPlanePort: 43_121,
  controlPlaneUrl: 'http://127.0.0.1:43121',
  runnerHeartbeatIntervalMs: 5_000,
  runnerOfflineAfterMs: 20_000,
  repairDispatchMaxBugs: 5,
  repairDispatchDelayMs: 120_000,
  deploymentBatchMaxBugs: 5,
  deploymentBatchDelayMs: 120_000,
  repairInfrastructureRetries: 2,
  repairWorkerPollIntervalMs: 1_000,
  repairLeaseRenewIntervalMs: 20_000,
  heartbeatIntervalMs: 5_000,
  heartbeatStaleAfterMs: 20_000,
  wakeJobTimeoutMs: 60 * 60 * 1_000,
  codexRunTimeoutMs: 30 * 60 * 1_000,
  leaseDurationMs: 60_000,
  shutdownGracePeriodMs: 30_000,
  outboxRetryBaseDelayMs: 2_000,
  maxConcurrentRuns: 1,
  logLevel: 'info',
} as const;
