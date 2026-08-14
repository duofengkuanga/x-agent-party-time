import {
  CompleteExecutionRequestSchema,
  ClaimedExecutionSchema,
  ExecutionStartRequestSchema,
} from '@agent-party-time/execution-contract';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const STATE_SCHEMA_VERSION = 2;

export const ConnectionStateSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    serverUrl: z.url(),
    runnerId: z.uuid(),
  })
  .strict();

export const LocalBindingSchema = z
  .object({
    bindingId: z.uuid(),
    repositoryPath: z
      .string()
      .min(1)
      .refine(isAbsolute, '仓库路径必须是本机绝对路径'),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const BindingStateSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    bindings: z.record(z.uuid(), LocalBindingSchema),
  })
  .strict();

export const ExecutionRecoveryStateSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    executionId: z.uuid(),
    bindingId: z.uuid(),
    phase: z.enum([
      'CLAIMED',
      'RUNNING',
      'WAITING_INTERACTION',
      'OUTCOME_PENDING',
    ]),
    sessionId: z.string().min(1).nullable(),
    claimedExecution: ClaimedExecutionSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const OutboxEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      schemaVersion: z.literal(STATE_SCHEMA_VERSION),
      id: z.uuid(),
      kind: z.literal('START'),
      executionId: z.uuid(),
      request: ExecutionStartRequestSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(STATE_SCHEMA_VERSION),
      id: z.uuid(),
      kind: z.literal('OUTCOME'),
      executionId: z.uuid(),
      request: CompleteExecutionRequestSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
]);

export const InstallStateSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    currentVersion: z.string().min(1),
    previousVersion: z.string().min(1).nullable(),
    installedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type ConnectionState = z.infer<typeof ConnectionStateSchema>;
export type BindingState = z.infer<typeof BindingStateSchema>;
export type ExecutionRecoveryState = z.infer<
  typeof ExecutionRecoveryStateSchema
>;
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;
export type InstallState = z.infer<typeof InstallStateSchema>;
