import {
  CompleteExecutionRequestSchema,
  ClaimedExecutionSchema,
  ExecutionStartRequestSchema,
} from '@agent-party-time/execution-contract';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const CONNECTION_STATE_SCHEMA_VERSION = 1;
export const IDENTITY_STATE_SCHEMA_VERSION = 1;
export const BINDING_STATE_SCHEMA_VERSION = 1;
export const EXECUTION_STATE_SCHEMA_VERSION = 2;
export const RESULT_BASELINE_STATE_SCHEMA_VERSION = 1;
export const OUTBOX_STATE_SCHEMA_VERSION = 2;
export const INSTALL_STATE_SCHEMA_VERSION = 1;

export const ConnectionStateSchema = z.strictObject({
  schemaVersion: z.literal(CONNECTION_STATE_SCHEMA_VERSION),
  serverUrl: z.url(),
  runnerId: z.uuid(),
});

export const IdentityStateSchema = z.strictObject({
  schemaVersion: z.literal(IDENTITY_STATE_SCHEMA_VERSION),
  installationId: z.uuid(),
  createdAt: z.iso.datetime(),
});

export const LocalBindingSchema = z.strictObject({
  bindingId: z.uuid(),
  repositoryPath: z.string().min(1).refine(isAbsolute, '仓库路径必须是本机绝对路径'),
  updatedAt: z.iso.datetime(),
});

export const BindingStateSchema = z.strictObject({
  schemaVersion: z.literal(BINDING_STATE_SCHEMA_VERSION),
  bindings: z.record(z.uuid(), LocalBindingSchema),
});

export const ExecutionRecoveryStateSchema = z.strictObject({
  schemaVersion: z.literal(EXECUTION_STATE_SCHEMA_VERSION),
  executionId: z.uuid(),
  bindingId: z.uuid(),
  phase: z.enum(['CLAIMED', 'RUNNING', 'WAITING_INTERACTION', 'OUTCOME_PENDING']),
  sessionId: z.string().min(1).nullable(),
  claimedExecution: ClaimedExecutionSchema,
  updatedAt: z.iso.datetime(),
});

export const ExecutionResultBaselineStateSchema = z.strictObject({
  schemaVersion: z.literal(RESULT_BASELINE_STATE_SCHEMA_VERSION),
  executionId: z.uuid(),
  baseline: z.strictObject({ gitHead: z.string().trim().min(1) }).nullable(),
});

export const OutboxEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    schemaVersion: z.literal(OUTBOX_STATE_SCHEMA_VERSION),
    id: z.uuid(),
    kind: z.literal('START'),
    executionId: z.uuid(),
    request: ExecutionStartRequestSchema,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    schemaVersion: z.literal(OUTBOX_STATE_SCHEMA_VERSION),
    id: z.uuid(),
    kind: z.literal('OUTCOME'),
    executionId: z.uuid(),
    request: CompleteExecutionRequestSchema,
    createdAt: z.iso.datetime(),
  }),
]);

export const InstallStateSchema = z.strictObject({
  schemaVersion: z.literal(INSTALL_STATE_SCHEMA_VERSION),
  currentVersion: z.string().min(1),
  previousVersion: z.string().min(1).nullable(),
  installedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ConnectionState = z.infer<typeof ConnectionStateSchema>;
export type BindingState = z.infer<typeof BindingStateSchema>;
export type ExecutionRecoveryState = z.infer<typeof ExecutionRecoveryStateSchema>;
export type ExecutionResultBaselineState = z.infer<
  typeof ExecutionResultBaselineStateSchema
>;
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;
export type InstallState = z.infer<typeof InstallStateSchema>;
