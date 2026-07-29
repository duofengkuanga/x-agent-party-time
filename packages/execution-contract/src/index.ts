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
  'WAITING_TO_RESUME',
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

export const ExecutionWorkspaceSchema = z.discriminatedUnion('isolation', [
  z
    .object({
      key: z.string().trim().min(1).max(240),
      isolation: z.literal('BRANCH_WORKTREE'),
      baseRef: z.string().trim().min(1).max(240),
      branch: z.string().trim().min(1).max(240),
    })
    .strict(),
  z
    .object({
      key: z.string().trim().min(1).max(240),
      isolation: z.literal('DETACHED_WORKTREE'),
      baseRef: z.string().trim().min(1).max(240),
    })
    .strict(),
  z
    .object({
      key: z.string().trim().min(1).max(240),
      isolation: z.literal('CLEANUP_WORKTREES'),
      workspaceKeys: z.array(z.string().trim().min(1).max(240)).min(1).max(100),
      completionResult: JsonValueSchema,
    })
    .strict(),
]);

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
  workspace: ExecutionWorkspaceSchema.nullable(),
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
  workspace: ExecutionWorkspaceSchema.nullable().default(null),
  attachmentIds: z.array(FileIdSchema).max(25),
  resumeSessionId: SessionIdSchema.nullable().default(null),
});

export const ClaimedExecutionSchema = ExecutionSchema.extend({
  lease: ExecutionLeaseSchema.extend({
    token: LeaseTokenSchema,
  }),
  outcome: z.null(),
  recoveredInteraction: z
    .object({
      method: z.string().trim().min(1).max(160),
      payload: JsonValueSchema,
      resolution: JsonValueSchema,
    })
    .strict()
    .nullable(),
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
  laneAcquired: z.boolean(),
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
export type ExecutionWorkspace = z.infer<typeof ExecutionWorkspaceSchema>;
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
export type WaitInteractionResponse = z.infer<
  typeof WaitInteractionResponseSchema
>;
export type CompleteExecutionRequest = z.infer<
  typeof CompleteExecutionRequestSchema
>;
export type RunnerActivity = z.infer<typeof RunnerActivitySchema>;

const ApprovalResolutionSchema = z
  .object({
    decision: z.enum(['decline', 'accept', 'acceptForSession']),
  })
  .strict();

const PermissionResolutionSchema = z
  .object({
    permissions: JsonObjectSchema,
    scope: z.enum(['turn', 'session']),
  })
  .strict();

const UserInputResolutionSchema = z
  .object({
    answers: z.record(
      z.string().trim().min(1),
      z
        .object({
          answers: z.array(z.string().trim().min(1)).min(1),
        })
        .strict(),
    ),
  })
  .strict();

export function parseExecutionInteractionResolution(
  method: string,
  payloadValue: JsonValue,
  resolutionValue: JsonValue,
): JsonValue {
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval'
  )
    return ApprovalResolutionSchema.parse(resolutionValue);
  if (method === 'item/permissions/requestApproval') {
    const resolution = PermissionResolutionSchema.parse(resolutionValue);
    const requested = jsonRecord(payloadValue).permissions;
    if (!isJsonSubset(resolution.permissions, requested))
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['permissions'],
          message: '只能提交 Codex 实际请求的权限',
        },
      ]);
    if (
      Object.keys(resolution.permissions).length === 0 &&
      resolution.scope !== 'turn'
    )
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['scope'],
          message: '拒绝权限请求只能使用 turn scope',
        },
      ]);
    return resolution;
  }
  if (method === 'item/tool/requestUserInput') {
    const resolution = UserInputResolutionSchema.parse(resolutionValue);
    const questions = jsonRecord(payloadValue).questions;
    const questionIds = Array.isArray(questions)
      ? questions.flatMap((question) => {
          const id = jsonRecord(question).id;
          return typeof id === 'string' ? [id] : [];
        })
      : [];
    const answerIds = Object.keys(resolution.answers);
    if (
      questionIds.length === 0 ||
      questionIds.length !== answerIds.length ||
      questionIds.some((id) => !answerIds.includes(id))
    )
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['answers'],
          message: '必须一次提交全部 Codex questions 的回答',
        },
      ]);
    return resolution;
  }
  throw new z.ZodError([
    {
      code: 'custom',
      path: ['method'],
      message: '不支持的 Codex Interaction method',
    },
  ]);
}

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

function isJsonSubset(candidate: unknown, requested: unknown): boolean {
  if (
    candidate === null ||
    typeof candidate === 'string' ||
    typeof candidate === 'number' ||
    typeof candidate === 'boolean'
  )
    return candidate === requested;
  if (Array.isArray(candidate))
    return (
      Array.isArray(requested) &&
      candidate.every((value) =>
        requested.some((requestedValue) => isJsonSubset(value, requestedValue)),
      )
    );
  if (candidate && typeof candidate === 'object') {
    if (!requested || typeof requested !== 'object' || Array.isArray(requested))
      return false;
    const requestedRecord = requested as Record<string, unknown>;
    return Object.entries(candidate).every(
      ([key, value]) =>
        key in requestedRecord && isJsonSubset(value, requestedRecord[key]),
    );
  }
  return false;
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
