import { z } from 'zod';

export const CookingMutationIdSchema = z.uuid();

const CookingVisualBaseSchema = z.object({
  label: z.string().trim().min(1),
});

export const CookingVisualPresentationSchema = z.discriminatedUnion('state', [
  CookingVisualBaseSchema.extend({
    state: z.literal('IDLE'),
    symbol: z.literal('·'),
  }).strict(),
  CookingVisualBaseSchema.extend({
    state: z.literal('RUNNING'),
    symbol: z.literal('●'),
  }).strict(),
  CookingVisualBaseSchema.extend({
    state: z.literal('NEEDS_APPROVAL'),
    symbol: z.literal('!'),
  }).strict(),
  CookingVisualBaseSchema.extend({
    state: z.literal('NEEDS_INPUT'),
    symbol: z.literal('?'),
  }).strict(),
  CookingVisualBaseSchema.extend({
    state: z.literal('FAILED'),
    symbol: z.literal('×'),
  }).strict(),
  CookingVisualBaseSchema.extend({
    state: z.literal('WAITING_TO_RESUME'),
    symbol: z.literal('Ⅱ'),
  }).strict(),
  CookingVisualBaseSchema.extend({
    state: z.literal('QUEUED_FOR_ENGINEERING'),
    symbol: z.literal('…'),
    aheadCount: z.number().int().nonnegative(),
  }).strict(),
]);

export const CookingInteractionQuestionOptionSchema = z.object({
  value: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable(),
});

export const CookingInteractionQuestionSchema = z.object({
  id: z.string().trim().min(1),
  header: z.string().trim().min(1),
  question: z.string().trim().min(1),
  options: z.array(CookingInteractionQuestionOptionSchema),
});

const CookingInteractionBaseSchema = z.object({
  id: z.uuid(),
  executionId: z.uuid(),
  state: z.enum(['PENDING', 'RESOLVED']),
  canResolve: z.boolean(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});

export const CookingInteractionViewSchema = z.discriminatedUnion('kind', [
  CookingInteractionBaseSchema.extend({
    kind: z.literal('APPROVAL'),
    request: z
      .object({
        type: z.enum(['COMMAND', 'FILE_CHANGE', 'PERMISSION']),
        title: z.string().trim().min(1),
        purpose: z.string().trim().min(1).nullable(),
        command: z.string().trim().min(1).nullable(),
        permissions: z.json().nullable(),
      })
      .nullable(),
    resolution: z
      .enum(['DECLINED', 'ACCEPTED_ONCE', 'ACCEPTED_FOR_SESSION'])
      .nullable(),
  }),
  CookingInteractionBaseSchema.extend({
    kind: z.literal('USER_INPUT'),
    request: z
      .object({
        questions: z.array(CookingInteractionQuestionSchema).min(1),
      })
      .nullable(),
    resolution: z
      .object({
        answers: z.record(z.string(), z.array(z.string().trim().min(1)).min(1)),
      })
      .nullable(),
  }),
]);

export type CookingVisualPresentation = z.infer<
  typeof CookingVisualPresentationSchema
>;
export type CookingInteractionView = z.infer<
  typeof CookingInteractionViewSchema
>;
