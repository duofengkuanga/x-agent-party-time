import { z } from 'zod';
import {
  ExecutionStateSchema,
  type JsonObject,
} from '@agent-party-time/execution-contract';
import { BugIdSchema } from '@/features/cooking/bugs/contract';
import {
  CookingInteractionViewSchema,
  CookingMutationIdSchema,
  CookingVisualPresentationSchema,
} from '@/features/cooking/shared/contract';

export const CommitShaSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{7,64}$/u);

export const RepairValidationSchema = z.object({
  name: z.string().trim().min(1).max(240),
  status: z.enum(['PASSED', 'FAILED', 'SKIPPED']),
  detail: z.string().trim().min(1).max(2_000).optional(),
});

const RepairExecutionResultValueSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('COMPLETED'),
      summary: z.string().trim().min(1).max(4_000),
      changes: z.array(z.string().trim().min(1).max(2_000)).max(100),
      validations: z.array(RepairValidationSchema).max(100),
      warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
      commits: z.array(CommitShaSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('FAILED'),
      summary: z.string().trim().min(1).max(4_000),
      failedStep: z.string().trim().min(1).max(240),
      reason: z.string().trim().min(1).max(4_000),
      completedActions: z.array(z.string().trim().min(1).max(2_000)).max(100),
      pendingActions: z.array(z.string().trim().min(1).max(2_000)).max(100),
    })
    .strict(),
]);

export const RepairExecutionResultSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  if (source.outcome === 'COMPLETED') {
    if (
      !isNullPlaceholder(source.failedStep) ||
      !isNullPlaceholder(source.reason) ||
      !isEmptyArrayPlaceholder(source.completedActions) ||
      !isEmptyArrayPlaceholder(source.pendingActions)
    )
      return value;
    const {
      failedStep: _failedStep,
      reason: _reason,
      completedActions: _completedActions,
      pendingActions: _pendingActions,
      ...normalized
    } = source;
    return {
      ...normalized,
      validations: Array.isArray(source.validations)
        ? source.validations.map((validation) => {
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
        : source.validations,
    };
  }
  if (source.outcome === 'FAILED') {
    if (
      !isEmptyArrayPlaceholder(source.changes) ||
      !isEmptyArrayPlaceholder(source.validations) ||
      !isEmptyArrayPlaceholder(source.warnings) ||
      !isEmptyArrayPlaceholder(source.commits)
    )
      return value;
    const {
      changes: _changes,
      validations: _validations,
      warnings: _warnings,
      commits: _commits,
      ...normalized
    } = source;
    return normalized;
  }
  return value;
}, RepairExecutionResultValueSchema);

function isNullPlaceholder(value: unknown): boolean {
  return value === undefined || value === null;
}

function isEmptyArrayPlaceholder(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

export const RepairOutputJsonSchema: JsonObject = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['COMPLETED', 'FAILED'] },
    summary: { type: 'string', minLength: 1, maxLength: 4_000 },
    changes: {
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
    commits: {
      type: 'array',
      items: { type: 'string', pattern: '^[a-f0-9]{7,64}$' },
      minItems: 0,
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
    completedActions: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 2_000 },
      maxItems: 100,
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
    'changes',
    'validations',
    'warnings',
    'commits',
    'failedStep',
    'reason',
    'completedActions',
    'pendingActions',
  ],
  additionalProperties: false,
};

const RepairAttemptResultViewSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('COMPLETED'),
    changes: z.array(z.string()),
    validations: z.array(RepairValidationSchema),
    warnings: z.array(z.string()),
    commitCount: z.number().int().positive(),
    commits: z.array(CommitShaSchema).nullable(),
    rawSummary: z.string().nullable(),
  }),
  z.object({
    outcome: z.literal('FAILED'),
    failedStep: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    completedActions: z.array(z.string()),
    pendingActions: z.array(z.string()),
    failureCode: z.string().nullable(),
    rawSummary: z.string().nullable(),
  }),
]);

export const RepairTimelineNodeSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal('BUG_REGISTERED'),
    occurredAt: z.iso.datetime(),
  }),
  z.object({
    id: z.uuid(),
    kind: z.literal('REPAIR_ATTEMPT'),
    executionId: z.uuid(),
    sessionId: z.string().trim().min(1).nullable(),
    attempt: z.number().int().positive(),
    executionState: ExecutionStateSchema,
    agentName: z.string().trim().min(1),
    queuedAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    interactions: z.array(CookingInteractionViewSchema),
    result: RepairAttemptResultViewSchema.nullable(),
  }),
]);

export const BugRepairViewSchema = z.object({
  pendingCommits: z.array(CommitShaSchema).nullable(),
  sessionAvailable: z.boolean(),
  timeline: z.array(RepairTimelineNodeSchema),
  availableActions: z.array(z.literal('RETRY_REPAIR')),
  presentation: z.object({
    statusLabel: z.string().trim().min(1),
    visual: CookingVisualPresentationSchema,
  }),
});

export const ContinueRepairInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
});

export const ResolveRepairInteractionInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  resolution: z.json(),
});

export const RepairWorkspaceProjectionSchema = z.object({
  repairByBug: z.record(BugIdSchema, BugRepairViewSchema),
});

export const RepairMutationResultSchema = z.object({
  bugId: BugIdSchema,
  bugVersion: z.number().int().positive(),
  executionId: z.uuid(),
  revision: z.number().int().positive(),
});

export type RepairExecutionResult = z.infer<typeof RepairExecutionResultSchema>;
export type BugRepairView = z.infer<typeof BugRepairViewSchema>;
export type ContinueRepairInput = z.infer<typeof ContinueRepairInputSchema>;
export type ResolveRepairInteractionInput = z.infer<
  typeof ResolveRepairInteractionInputSchema
>;
export type RepairWorkspaceProjection = z.infer<
  typeof RepairWorkspaceProjectionSchema
>;
export type RepairMutationResult = z.infer<typeof RepairMutationResultSchema>;
