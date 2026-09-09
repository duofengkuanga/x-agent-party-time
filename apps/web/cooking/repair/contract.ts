import { z } from 'zod';
import {
  ExecutionStateSchema,
  type JsonObject,
} from '@agent-party-time/execution-contract';
import { BugIdSchema } from '@/cooking/bugs/contract';
import {
  CookingInteractionViewSchema,
  CookingMutationIdSchema,
  CookingVisualPresentationSchema,
} from '@/cooking/shared/contract';

export const CommitShaSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{7,64}$/u);

export const RepairValidationSchema = z.object({
  name: z.string().trim().min(1).max(240),
  status: z.enum(['PASSED', 'FAILED', 'SKIPPED']),
  detail: z.string().trim().max(300),
});

const RepositoryRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').some((segment) => segment === '..'),
    '必须是仓库内的相对路径',
  );

export const ManualOperationSchema = z
  .object({
    kind: z.literal('DATABASE_SQL'),
    paths: z.array(RepositoryRelativePathSchema).min(1).max(100),
  })
  .strict();

export const ManualOperationsSchema = z.array(ManualOperationSchema).max(5);

const RepairExecutionResultValueSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('COMPLETED'),
      completionKind: z.enum(['CHANGES_COMMITTED', 'TARGET_ALREADY_FIXED']),
      changes: z.array(z.string().trim().min(1).max(300)).max(5),
      validations: z.array(RepairValidationSchema).max(5),
      warnings: z.array(z.string().trim().min(1).max(300)).max(3),
      commits: z.array(CommitShaSchema).max(5),
      manualOperations: ManualOperationsSchema,
    })
    .strict()
    .superRefine((result, context) => {
      if (result.completionKind === 'CHANGES_COMMITTED') {
        if (result.commits.length === 0)
          context.addIssue({
            code: 'custom',
            path: ['commits'],
            message: '有代码改动的修复必须返回候选本地提交',
          });
        return;
      }
      if (result.changes.length > 0)
        context.addIssue({
          code: 'custom',
          path: ['changes'],
          message: '目标分支已修复时不得报告本次改动',
        });
      if (result.commits.length > 0)
        context.addIssue({
          code: 'custom',
          path: ['commits'],
          message: '目标分支已修复时不得返回候选本地提交',
        });
      if (result.manualOperations.length > 0)
        context.addIssue({
          code: 'custom',
          path: ['manualOperations'],
          message: '目标分支已修复时不得报告待执行的人工操作',
        });
      if (
        !result.validations.some(({ status }) => status === 'PASSED') ||
        result.validations.some(({ status }) => status === 'FAILED')
      )
        context.addIssue({
          code: 'custom',
          path: ['validations'],
          message: '目标分支已修复必须有成功且无失败的验证结果',
        });
    }),
  z
    .object({
      outcome: z.literal('FAILED'),
      failedStep: z.string().trim().min(1).max(240),
      reason: z.string().trim().min(1).max(500),
      completedActions: z.array(z.string().trim().min(1).max(300)).max(5),
      pendingActions: z.array(z.string().trim().min(1).max(300)).max(5),
    })
    .strict(),
]);

export const RepairExecutionResultSchema = z
  .object({ result: RepairExecutionResultValueSchema })
  .strict();

export const RepairOutputJsonSchema: JsonObject = {
  type: 'object',
  properties: {
    result: {
      anyOf: [repairCompletedOutputSchema(), repairFailedOutputSchema()],
    },
  },
  required: ['result'],
  additionalProperties: false,
};

function repairCompletedOutputSchema(): JsonObject {
  return {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['COMPLETED'] },
      completionKind: {
        type: 'string',
        enum: ['CHANGES_COMMITTED', 'TARGET_ALREADY_FIXED'],
      },
      changes: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 300 },
        maxItems: 5,
      },
      validations: {
        type: 'array',
        items: validationOutputSchema(),
        maxItems: 5,
      },
      warnings: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 300 },
        maxItems: 3,
      },
      commits: {
        type: 'array',
        items: { type: 'string', pattern: '^[a-f0-9]{7,64}$' },
        maxItems: 5,
      },
      manualOperations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['DATABASE_SQL'] },
            paths: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 2_000 },
              minItems: 1,
              maxItems: 100,
            },
          },
          required: ['kind', 'paths'],
          additionalProperties: false,
        },
        maxItems: 5,
      },
    },
    required: [
      'outcome',
      'completionKind',
      'changes',
      'validations',
      'warnings',
      'commits',
      'manualOperations',
    ],
    additionalProperties: false,
  };
}

function repairFailedOutputSchema(): JsonObject {
  return {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['FAILED'] },
      failedStep: { type: 'string', minLength: 1, maxLength: 240 },
      reason: { type: 'string', minLength: 1, maxLength: 500 },
      completedActions: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 300 },
        maxItems: 5,
      },
      pendingActions: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 300 },
        maxItems: 5,
      },
    },
    required: [
      'outcome',
      'failedStep',
      'reason',
      'completedActions',
      'pendingActions',
    ],
    additionalProperties: false,
  };
}

function validationOutputSchema(): JsonObject {
  return {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 240 },
      status: { type: 'string', enum: ['PASSED', 'FAILED', 'SKIPPED'] },
      detail: { type: 'string', maxLength: 300 },
    },
    required: ['name', 'status', 'detail'],
    additionalProperties: false,
  };
}

const RepairAttemptResultViewSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('COMPLETED'),
    changes: z.array(z.string()),
    validations: z.array(RepairValidationSchema),
    warnings: z.array(z.string()),
    commitCount: z.number().int().nonnegative(),
    commits: z.array(CommitShaSchema).nullable(),
  }),
  z.object({
    outcome: z.literal('FAILED'),
    failedStep: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    completedActions: z.array(z.string()),
    pendingActions: z.array(z.string()),
    failureCode: z.string().nullable(),
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
  synchronizationError: z.string().nullable(),
  timeline: z.array(RepairTimelineNodeSchema),
  availableActions: z.array(z.enum(['RETRY_REPAIR', 'SYNC_SESSION'])),
  presentation: z.object({
    statusLabel: z.string().trim().min(1),
    visual: CookingVisualPresentationSchema,
  }),
});

export const ContinueRepairInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
});

export const SynchronizeRepairSessionInputSchema = ContinueRepairInputSchema;

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
export type SynchronizeRepairSessionInput = z.infer<
  typeof SynchronizeRepairSessionInputSchema
>;
export type ResolveRepairInteractionInput = z.infer<
  typeof ResolveRepairInteractionInputSchema
>;
export type RepairWorkspaceProjection = z.infer<
  typeof RepairWorkspaceProjectionSchema
>;
export type RepairMutationResult = z.infer<typeof RepairMutationResultSchema>;
