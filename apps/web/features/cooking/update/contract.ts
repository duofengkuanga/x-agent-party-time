import { z } from 'zod';
import {
  ExecutionStateSchema,
  type JsonObject,
} from '@agent-party-time/execution-contract';
import { BugIdSchema } from '@/features/cooking/bugs/contract';
import { CommitShaSchema } from '@/features/cooking/repair/contract';
import {
  CookingInteractionViewSchema,
  CookingMutationIdSchema,
  CookingVisualPresentationSchema,
} from '@/features/cooking/shared/contract';
import {
  SubmissionIdSchema,
  SubmissionItemIdSchema,
} from '@/features/cooking/submissions/contract';

export const UpdateBatchIdSchema = z.uuid();
export const UpdateAttemptIdSchema = z.uuid();
export const ExternalDeploymentReportIdSchema = z.uuid();
export const UpdateBatchStateSchema = z.enum([
  'READY',
  'RUNNING',
  'WAITING_EXTERNAL',
  'FAILED',
  'COMPLETED',
]);

export const UpdateValidationSchema = z.object({
  name: z.string().trim().min(1).max(240),
  status: z.enum(['PASSED', 'FAILED', 'SKIPPED']),
  detail: z.string().trim().min(1).max(2_000).optional(),
});

const CompletedUpdateExecutionResultSchema = z
  .object({
    outcome: z.literal('COMPLETED'),
    summary: z.string().trim().min(1).max(4_000),
    completedActions: z.array(z.string().trim().min(1).max(2_000)).max(100),
    validations: z.array(UpdateValidationSchema).max(100),
    warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  })
  .strict();

const PushedUpdateExecutionResultSchema = z
  .object({
    outcome: z.literal('PUSHED'),
    summary: z.string().trim().min(1).max(4_000),
    completedActions: z.array(z.string().trim().min(1).max(2_000)).max(100),
    validations: z.array(UpdateValidationSchema).max(100),
    warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  })
  .strict();

const FailedUpdateExecutionResultSchema = z
  .object({
    outcome: z.literal('FAILED'),
    summary: z.string().trim().min(1).max(4_000),
    failedStep: z.string().trim().min(1).max(240),
    reason: z.string().trim().min(1).max(4_000),
    completedActions: z.array(z.string().trim().min(1).max(2_000)).max(100),
    validations: z.array(UpdateValidationSchema).max(100).default([]),
    warnings: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
    pendingActions: z.array(z.string().trim().min(1).max(2_000)).max(100),
  })
  .strict();

export const LocalScriptUpdateExecutionResultSchema = z.preprocess(
  normalizeUpdateExecutionResult,
  z.discriminatedUnion('outcome', [
    CompletedUpdateExecutionResultSchema,
    FailedUpdateExecutionResultSchema,
  ]),
);

export const CiCdUpdateExecutionResultSchema = z.preprocess(
  normalizeUpdateExecutionResult,
  z.discriminatedUnion('outcome', [
    PushedUpdateExecutionResultSchema,
    FailedUpdateExecutionResultSchema,
  ]),
);

export const LocalScriptUpdateOutputJsonSchema = updateOutputJsonSchema([
  'COMPLETED',
  'FAILED',
]);
export const CiCdUpdateOutputJsonSchema = updateOutputJsonSchema([
  'PUSHED',
  'FAILED',
]);

export const PendingDeliveryViewSchema = z.object({
  submissionItemId: SubmissionItemIdSchema,
  lastCandidateAt: z.iso.datetime(),
  eligibleAt: z.iso.datetime(),
  availableActions: z.array(z.literal('FREEZE_NOW')),
});

export const UpdateBatchEntryViewSchema = z.object({
  bugId: BugIdSchema,
  bugShortId: z.number().int().positive(),
  bugTitle: z.string().trim().min(1).max(240),
  commits: z.array(CommitShaSchema).nullable(),
});

const UpdateAttemptResultViewSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.enum(['COMPLETED', 'PUSHED']),
    completedActions: z.array(z.string()),
    validations: z.array(UpdateValidationSchema),
    warnings: z.array(z.string()),
    rawSummary: z.string().nullable(),
  }),
  z.object({
    outcome: z.literal('FAILED'),
    failedStep: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    completedActions: z.array(z.string()),
    validations: z.array(UpdateValidationSchema),
    warnings: z.array(z.string()),
    pendingActions: z.array(z.string()),
    failureCode: z.string().nullable(),
    rawSummary: z.string().nullable(),
  }),
]);

export const UpdateAttachmentViewSchema = z.object({
  id: z.uuid(),
  originalName: z.string().trim().min(1).max(255),
  mediaType: z.enum([
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain',
    'application/json',
  ]),
  sizeBytes: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});

export const UpdateBatchTimelineNodeSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal('BATCH_FORMED'),
    occurredAt: z.iso.datetime(),
    bugCount: z.number().int().positive(),
  }),
  z.object({
    id: UpdateAttemptIdSchema,
    kind: z.literal('UPDATE_ATTEMPT'),
    executionId: z.uuid(),
    sessionId: z.string().trim().min(1).nullable(),
    attempt: z.number().int().positive(),
    executionState: ExecutionStateSchema,
    queuedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    interactions: z.array(CookingInteractionViewSchema),
    result: UpdateAttemptResultViewSchema.nullable(),
  }),
  z.object({
    id: ExternalDeploymentReportIdSchema,
    kind: z.literal('EXTERNAL_REPORT'),
    round: z.number().int().positive(),
    outcome: z.enum(['SUCCEEDED', 'FAILED']),
    summary: z.string().nullable(),
    attachments: z.array(UpdateAttachmentViewSchema),
    occurredAt: z.iso.datetime(),
  }),
]);

export const UpdateBatchViewSchema = z.object({
  id: UpdateBatchIdSchema,
  submissionId: SubmissionIdSchema,
  submissionItemId: SubmissionItemIdSchema,
  state: UpdateBatchStateSchema,
  version: z.number().int().positive(),
  activeExecutionId: z.uuid().nullable(),
  frozenAt: z.iso.datetime(),
  engineeringName: z.string().trim().min(1),
  targetBranch: z.string().trim().min(1),
  environmentName: z.string().trim().min(1),
  deploymentKind: z.enum(['LOCAL_SCRIPT', 'CI_CD']),
  entries: z.array(UpdateBatchEntryViewSchema).min(1),
  timeline: z.array(UpdateBatchTimelineNodeSchema),
  availableActions: z.array(z.enum(['RETRY_UPDATE', 'REPORT_EXTERNAL'])),
  presentation: z.object({
    statusLabel: z.string().trim().min(1),
    visual: CookingVisualPresentationSchema,
  }),
});

export const UpdateWorkspaceProjectionSchema = z.object({
  pendingDeliveries: z.array(PendingDeliveryViewSchema),
  updateBatches: z.array(UpdateBatchViewSchema),
});

export const FreezeUpdateInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
});

export const RetryUpdateInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
});

export const ExternalDeploymentReportInputSchema = z.discriminatedUnion(
  'outcome',
  [
    z.object({
      mutationId: CookingMutationIdSchema,
      expectedVersion: z.number().int().positive(),
      outcome: z.literal('SUCCEEDED'),
      summary: z.string().trim().min(1).max(8_000).optional(),
      attachmentIds: z.array(z.uuid()).max(5),
    }),
    z.object({
      mutationId: CookingMutationIdSchema,
      expectedVersion: z.number().int().positive(),
      outcome: z.literal('FAILED'),
      summary: z.string().trim().min(1).max(8_000),
      attachmentIds: z.array(z.uuid()).max(5),
    }),
  ],
);

export const UpdateBatchCommandInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
});

export const ResolveUpdateInteractionInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  resolution: z.json(),
});

export const UpdateMutationResultSchema = z.object({
  batchId: UpdateBatchIdSchema,
  batchVersion: z.number().int().positive(),
  executionId: z.uuid().nullable(),
  revision: z.number().int().positive(),
});

export type LocalScriptUpdateExecutionResult = z.infer<
  typeof LocalScriptUpdateExecutionResultSchema
>;
export type CiCdUpdateExecutionResult = z.infer<
  typeof CiCdUpdateExecutionResultSchema
>;
export type PendingDeliveryView = z.infer<typeof PendingDeliveryViewSchema>;
export type UpdateBatchView = z.infer<typeof UpdateBatchViewSchema>;
export type UpdateWorkspaceProjection = z.infer<
  typeof UpdateWorkspaceProjectionSchema
>;
export type FreezeUpdateInput = z.infer<typeof FreezeUpdateInputSchema>;
export type RetryUpdateInput = z.infer<typeof RetryUpdateInputSchema>;
export type ExternalDeploymentReportInput = z.infer<
  typeof ExternalDeploymentReportInputSchema
>;
export type UpdateBatchCommandInput = z.infer<
  typeof UpdateBatchCommandInputSchema
>;
export type ResolveUpdateInteractionInput = z.infer<
  typeof ResolveUpdateInteractionInputSchema
>;
export type UpdateMutationResult = z.infer<typeof UpdateMutationResultSchema>;

function normalizeUpdateExecutionResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  if (source.outcome === 'COMPLETED' || source.outcome === 'PUSHED') {
    if (
      !isNullPlaceholder(source.failedStep) ||
      !isNullPlaceholder(source.reason) ||
      !isEmptyArrayPlaceholder(source.pendingActions)
    )
      return value;
    const {
      failedStep: _failedStep,
      reason: _reason,
      pendingActions: _pendingActions,
      ...normalized
    } = source;
    return {
      ...normalized,
      validations: normalizeValidationDetails(source.validations),
    };
  }
  if (source.outcome === 'FAILED') {
    if (
      !isEmptyArrayPlaceholder(source.validations) ||
      !isEmptyArrayPlaceholder(source.warnings)
    )
      return value;
    const {
      validations: _validations,
      warnings: _warnings,
      ...normalized
    } = source;
    return normalized;
  }
  return value;
}

function normalizeValidationDetails(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((validation) => {
        if (
          validation &&
          typeof validation === 'object' &&
          !Array.isArray(validation) &&
          Reflect.get(validation, 'detail') === null
        ) {
          const { detail: _detail, ...normalized } = validation as Record<
            string,
            unknown
          >;
          return normalized;
        }
        return validation;
      })
    : value;
}

function isNullPlaceholder(value: unknown): boolean {
  return value === undefined || value === null;
}

function isEmptyArrayPlaceholder(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function updateOutputJsonSchema(
  outcomes: ['COMPLETED' | 'PUSHED', 'FAILED'],
): JsonObject {
  return {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: outcomes },
      summary: { type: 'string', minLength: 1, maxLength: 4_000 },
      completedActions: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 2_000 },
        maxItems: 100,
      },
      validations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 240 },
            status: {
              type: 'string',
              enum: ['PASSED', 'FAILED', 'SKIPPED'],
            },
            detail: {
              type: ['string', 'null'],
              minLength: 1,
              maxLength: 2_000,
            },
          },
          required: ['name', 'status', 'detail'],
          additionalProperties: false,
        },
        maxItems: 100,
      },
      warnings: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 2_000 },
        maxItems: 100,
      },
      failedStep: {
        type: ['string', 'null'],
        minLength: 1,
        maxLength: 240,
      },
      reason: {
        type: ['string', 'null'],
        minLength: 1,
        maxLength: 4_000,
      },
      pendingActions: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 2_000 },
        maxItems: 100,
      },
    },
    required: [
      'outcome',
      'summary',
      'completedActions',
      'validations',
      'warnings',
      'failedStep',
      'reason',
      'pendingActions',
    ],
    additionalProperties: false,
  };
}
