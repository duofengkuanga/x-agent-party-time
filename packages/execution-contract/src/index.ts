import { z } from 'zod';

export const ExecutionIdSchema = z.uuid();
export const InteractionIdSchema = z.uuid();
export const FileIdSchema = z.uuid();
export const BindingIdSchema = z.uuid();
export const RunnerIdSchema = z.uuid();
export const LeaseTokenSchema = z.string().min(32).max(256);
export const SessionIdSchema = z.string().trim().min(1).max(240);
export const JsonValueSchema = z.json();
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const ExecutionStateSchema = z.enum([
  'QUEUED',
  'CLAIMED',
  'RUNNING',
  'WAITING_FOR_INTERACTION',
  'CANCEL_REQUESTED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const ExecutionOwnerRefSchema = z.object({
  namespace: z.string().trim().min(1).max(80),
  kind: z.string().trim().min(1).max(80),
  id: z.string().trim().min(1).max(240),
});

export const ExecutionAttachmentSchema = z.object({
  id: FileIdSchema,
  originalName: z.string().trim().min(1).max(255),
  mediaType: z.enum([
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain',
    'application/json',
  ]),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const ExecutionLeaseSchema = z.object({
  expiresAt: z.iso.datetime(),
});

export const ExecutionFailureCodeSchema = z.enum([
  'BINDING_NOT_FOUND',
  'REPOSITORY_NOT_FOUND',
  'ATTACHMENT_DOWNLOAD_FAILED',
  'CODEX_START_FAILED',
  'CODEX_EXECUTION_FAILED',
  'CANCELLED_BY_REQUEST',
]);

export const ExecutionFailureSchema = z.object({
  code: ExecutionFailureCodeSchema,
  message: z.string().trim().min(1).max(1_000),
  retryable: z.boolean(),
});

export const ExecutionOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('SUCCEEDED'),
    result: JsonValueSchema,
  }),
  z.object({
    kind: z.literal('FAILED'),
    failure: ExecutionFailureSchema,
  }),
  z.object({
    kind: z.literal('CANCELLED'),
    reason: z.string().trim().min(1).max(1_000).optional(),
  }),
]);

export const ExecutionSchema = z.object({
  id: ExecutionIdSchema,
  owner: ExecutionOwnerRefSchema,
  attempt: z.number().int().positive(),
  previousExecutionId: ExecutionIdSchema.nullable(),
  runnerId: RunnerIdSchema,
  bindingId: BindingIdSchema,
  priority: z.number().int(),
  state: ExecutionStateSchema,
  promptKind: z.string().trim().min(1).max(120),
  promptVersion: z.number().int().positive(),
  renderedPrompt: z.string().min(1).max(200_000),
  renderedPromptHash: z.string().regex(/^[a-f0-9]{64}$/u),
  outputJsonSchema: JsonObjectSchema,
  attachments: z.array(ExecutionAttachmentSchema).max(25),
  resumeSessionId: SessionIdSchema.nullable(),
  sessionId: SessionIdSchema.nullable(),
  lease: ExecutionLeaseSchema.nullable(),
  outcome: ExecutionOutcomeSchema.nullable(),
  cancellationRequested: z.boolean(),
  createdAt: z.iso.datetime(),
  claimedAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});

export const EnqueueExecutionInputSchema = z.object({
  id: ExecutionIdSchema.optional(),
  owner: ExecutionOwnerRefSchema,
  attempt: z.number().int().positive(),
  previousExecutionId: ExecutionIdSchema.nullable().default(null),
  runnerId: RunnerIdSchema,
  bindingId: BindingIdSchema,
  priority: z.number().int().default(0),
  promptKind: z.string().trim().min(1).max(120),
  promptVersion: z.number().int().positive(),
  renderedPrompt: z.string().min(1).max(200_000),
  renderedPromptHash: z.string().regex(/^[a-f0-9]{64}$/u),
  outputJsonSchema: JsonObjectSchema,
  attachmentIds: z.array(FileIdSchema).max(25),
  resumeSessionId: SessionIdSchema.nullable().default(null),
});

export const ClaimedExecutionSchema = ExecutionSchema.extend({
  lease: ExecutionLeaseSchema.extend({
    token: LeaseTokenSchema,
  }),
  outcome: z.null(),
});

export const ExecutionClaimRequestSchema = z.object({
  availableSlots: z.number().int().min(0).max(32),
  waitMs: z.number().int().min(0).max(10_000).default(5_000),
});

export const ExecutionClaimResponseSchema = z.object({
  executions: z.array(ClaimedExecutionSchema).max(32),
});

export const ExecutionStartRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('STARTED'),
    leaseToken: LeaseTokenSchema,
    sessionId: SessionIdSchema,
  }),
  z.object({
    kind: z.literal('START_FAILED'),
    leaseToken: LeaseTokenSchema,
    failure: ExecutionFailureSchema,
  }),
]);

export const ExecutionMutationResponseSchema = z.object({
  execution: ExecutionSchema,
});

export const ExecutionRenewRequestSchema = z.object({
  leaseToken: LeaseTokenSchema,
});

export const ExecutionRenewResponseSchema = z.object({
  expiresAt: z.iso.datetime(),
  cancellationRequested: z.boolean(),
});

export const InteractionKindSchema = z.enum(['APPROVAL', 'USER_INPUT']);
export const InteractionStateSchema = z.enum([
  'PENDING',
  'RESOLVED',
  'INVALIDATED',
]);

export const ExecutionInteractionSchema = z.object({
  id: InteractionIdSchema,
  executionId: ExecutionIdSchema,
  kind: InteractionKindSchema,
  method: z.string().trim().min(1).max(160),
  payload: JsonValueSchema,
  state: InteractionStateSchema,
  resolution: JsonValueSchema.nullable(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});

export const OpenInteractionRequestSchema = z.object({
  leaseToken: LeaseTokenSchema,
  kind: InteractionKindSchema,
  method: z.string().trim().min(1).max(160),
  payload: JsonValueSchema,
});

export const OpenInteractionResponseSchema = z.object({
  interaction: ExecutionInteractionSchema,
});

export const WaitInteractionRequestSchema = z.object({
  executionId: ExecutionIdSchema,
  leaseToken: LeaseTokenSchema,
  waitMs: z.number().int().min(0).max(10_000).default(5_000),
});

export const WaitInteractionResponseSchema = z.object({
  interaction: ExecutionInteractionSchema,
});

export const CompleteExecutionRequestSchema = z.object({
  leaseToken: LeaseTokenSchema,
  sessionId: SessionIdSchema,
  outcome: ExecutionOutcomeSchema,
});

export const RunnerActivitySchema = z.object({
  activeExecutionCount: z.number().int().nonnegative(),
  waitingInteractionCount: z.number().int().nonnegative(),
});

export type JsonValue = z.infer<typeof JsonValueSchema>;
export type JsonObject = z.infer<typeof JsonObjectSchema>;
export type Execution = z.infer<typeof ExecutionSchema>;
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;
export type ExecutionOwnerRef = z.infer<typeof ExecutionOwnerRefSchema>;
export type ExecutionAttachment = z.infer<typeof ExecutionAttachmentSchema>;
export type ExecutionFailure = z.infer<typeof ExecutionFailureSchema>;
export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>;
export type EnqueueExecutionInput = z.infer<typeof EnqueueExecutionInputSchema>;
export type ClaimedExecution = z.infer<typeof ClaimedExecutionSchema>;
export type ExecutionClaimRequest = z.infer<typeof ExecutionClaimRequestSchema>;
export type ExecutionClaimResponse = z.infer<
  typeof ExecutionClaimResponseSchema
>;
export type ExecutionStartRequest = z.infer<typeof ExecutionStartRequestSchema>;
export type ExecutionRenewRequest = z.infer<typeof ExecutionRenewRequestSchema>;
export type ExecutionRenewResponse = z.infer<
  typeof ExecutionRenewResponseSchema
>;
export type ExecutionInteraction = z.infer<typeof ExecutionInteractionSchema>;
export type OpenInteractionRequest = z.infer<
  typeof OpenInteractionRequestSchema
>;
export type WaitInteractionRequest = z.infer<
  typeof WaitInteractionRequestSchema
>;
export type CompleteExecutionRequest = z.infer<
  typeof CompleteExecutionRequestSchema
>;
export type RunnerActivity = z.infer<typeof RunnerActivitySchema>;

export function sanitizeExecutionInteractionPayload(
  method: string,
  value: unknown,
): JsonValue {
  const payload = jsonRecord(value);
  const keys =
    method === 'item/commandExecution/requestApproval'
      ? ['command', 'reason']
      : method === 'item/fileChange/requestApproval'
        ? ['reason']
        : method === 'item/permissions/requestApproval'
          ? ['permissions', 'reason']
          : method === 'item/tool/requestUserInput'
            ? ['questions']
            : [];
  return Object.fromEntries(
    keys.flatMap((key) =>
      payload[key] === undefined
        ? []
        : [[key, sanitizeInteractionValue(payload[key], key)]],
    ),
  );
}

function sanitizeInteractionValue(value: unknown, key = ''): JsonValue {
  if (/cwd|directory|path|root/iu.test(key)) return '本机路径已隐藏';
  if (typeof value === 'string') return redactAbsolutePaths(value);
  if (Array.isArray(value))
    return value.map((item) => sanitizeInteractionValue(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeInteractionValue(childValue, childKey),
      ]),
    );
  return JsonValueSchema.parse(value ?? null);
}

function redactAbsolutePaths(value: string): string {
  return value
    .replace(/(^|[\s"'=(])\/(?!\/)[^\s"'`,;)]+/gu, '$1本机路径已隐藏')
    .replace(/(^|[\s"'=(])[a-z]:\\[^\s"'`,;)]+/giu, '$1本机路径已隐藏');
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
