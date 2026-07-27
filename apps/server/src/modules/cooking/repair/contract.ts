import { z } from 'zod';
import {
  ExecutionInteractionSchema,
  ExecutionStateSchema,
  type JsonObject,
} from '@agent-party-time/execution-contract';
import { BugIdSchema } from '@/modules/cooking/bugs/contract';
import { CookingMutationIdSchema } from '@/modules/cooking/shared/contract';

export const CommitShaSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{7,64}$/u);

const RepairExecutionResultValueSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('COMPLETED'),
      summary: z.string().trim().min(1).max(4_000),
      commits: z.array(CommitShaSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('FAILED'),
      summary: z.string().trim().min(1).max(4_000),
    })
    .strict(),
]);

export const RepairExecutionResultSchema = z.preprocess((value) => {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Reflect.get(value, 'outcome') === 'FAILED' &&
    Array.isArray(Reflect.get(value, 'commits')) &&
    Reflect.get(value, 'commits').length === 0
  ) {
    const { commits: _commits, ...normalized } = value as Record<
      string,
      unknown
    >;
    return normalized;
  }
  return value;
}, RepairExecutionResultValueSchema);

export const RepairOutputJsonSchema: JsonObject = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['COMPLETED', 'FAILED'] },
    summary: { type: 'string', minLength: 1, maxLength: 4_000 },
    commits: {
      type: 'array',
      items: { type: 'string', pattern: '^[a-f0-9]{7,64}$' },
      minItems: 0,
      maxItems: 100,
    },
  },
  required: ['outcome', 'summary', 'commits'],
  additionalProperties: false,
};

export const RepairAttemptViewSchema = z.object({
  id: z.uuid(),
  executionId: z.uuid(),
  attempt: z.number().int().positive(),
  executionState: ExecutionStateSchema,
  summary: z.string().nullable(),
  technicalFailure: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

export const BugRepairViewSchema = z.object({
  pendingCommits: z.array(CommitShaSchema).nullable(),
  sessionAvailable: z.boolean(),
  attempts: z.array(RepairAttemptViewSchema),
  availableActions: z.array(z.enum(['CONTINUE_REPAIR', 'STOP_EXECUTION'])),
  presentation: z.object({
    statusLabel: z.string().trim().min(1),
  }),
});

export const RepairInteractionViewSchema = ExecutionInteractionSchema.pick({
  id: true,
  executionId: true,
  kind: true,
  state: true,
  createdAt: true,
}).extend({
  bugId: z.uuid(),
  bugShortId: z.number().int().positive(),
  method: z.string().nullable(),
  payload: z.json().nullable(),
  canResolve: z.boolean(),
});

export const ContinueRepairInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  content: z.string().trim().min(1).max(8_000),
});

export const ResolveRepairInteractionInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  resolution: z.json(),
});

export const StopRepairInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
});

export const RepairWorkspaceProjectionSchema = z.object({
  repairByBug: z.record(BugIdSchema, BugRepairViewSchema),
  pendingInteractions: z.array(RepairInteractionViewSchema),
});

export const RepairMutationResultSchema = z.object({
  bugId: BugIdSchema,
  bugVersion: z.number().int().positive(),
  executionId: z.uuid(),
  revision: z.number().int().positive(),
});

export type RepairExecutionResult = z.infer<typeof RepairExecutionResultSchema>;
export type BugRepairView = z.infer<typeof BugRepairViewSchema>;
export type RepairInteractionView = z.infer<typeof RepairInteractionViewSchema>;
export type ContinueRepairInput = z.infer<typeof ContinueRepairInputSchema>;
export type ResolveRepairInteractionInput = z.infer<
  typeof ResolveRepairInteractionInputSchema
>;
export type StopRepairInput = z.infer<typeof StopRepairInputSchema>;
export type RepairWorkspaceProjection = z.infer<
  typeof RepairWorkspaceProjectionSchema
>;
export type RepairMutationResult = z.infer<typeof RepairMutationResultSchema>;
