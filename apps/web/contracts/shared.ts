import { z } from 'zod';

export const ManualHandoffResultViewSchema = z.object({
  outcome: z.literal('HANDED_OFF'),
  questions: z.array(z.string()).nullable(),
});

export const ValidationSchema = z.object({
  name: z.string().trim().min(1).max(240),
  status: z.enum(['PASSED', 'FAILED', 'SKIPPED']),
  detail: z.string().trim().max(300),
});

export const AttachmentViewSchema = z.object({
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

const SubmissionVisualBaseSchema = z.object({
  label: z.string().trim().min(1),
});

export const SubmissionVisualPresentationSchema = z.discriminatedUnion('state', [
  SubmissionVisualBaseSchema.extend({
    state: z.literal('IDLE'),
    symbol: z.literal('·'),
  }).strict(),
  SubmissionVisualBaseSchema.extend({
    state: z.literal('RUNNING'),
    symbol: z.literal('●'),
  }).strict(),
  SubmissionVisualBaseSchema.extend({
    state: z.literal('NEEDS_APPROVAL'),
    symbol: z.literal('!'),
  }).strict(),
  SubmissionVisualBaseSchema.extend({
    state: z.literal('NEEDS_INPUT'),
    symbol: z.literal('?'),
  }).strict(),
  SubmissionVisualBaseSchema.extend({
    state: z.literal('FAILED'),
    symbol: z.literal('×'),
  }).strict(),
  SubmissionVisualBaseSchema.extend({
    state: z.literal('WAITING_TO_RESUME'),
    symbol: z.literal('Ⅱ'),
  }).strict(),
  SubmissionVisualBaseSchema.extend({
    state: z.literal('QUEUED_FOR_ENGINEERING'),
    symbol: z.literal('…'),
    aheadCount: z.number().int().nonnegative(),
  }).strict(),
]);

const SubmissionInteractionQuestionOptionSchema = z.object({
  value: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable(),
});

const SubmissionInteractionQuestionSchema = z.object({
  id: z.string().trim().min(1),
  header: z.string().trim().min(1),
  question: z.string().trim().min(1),
  options: z.array(SubmissionInteractionQuestionOptionSchema),
});

const SubmissionInteractionBaseSchema = z.object({
  id: z.uuid(),
  executionId: z.uuid(),
  state: z.enum(['PENDING', 'RESOLVED']),
  canResolve: z.boolean(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});

export const SubmissionInteractionViewSchema = z.discriminatedUnion('kind', [
  SubmissionInteractionBaseSchema.extend({
    kind: z.literal('MANUAL_HANDOFF'),
    questions: z.array(z.string()).nullable(),
    request: z.null(),
    resolution: z.null(),
  }),
  SubmissionInteractionBaseSchema.extend({
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
    resolution: z.enum(['DECLINED', 'ACCEPTED_ONCE', 'ACCEPTED_FOR_SESSION']).nullable(),
  }),
  SubmissionInteractionBaseSchema.extend({
    kind: z.literal('USER_INPUT'),
    request: z
      .object({
        questions: z.array(SubmissionInteractionQuestionSchema).min(1),
      })
      .nullable(),
    resolution: z
      .object({
        answers: z.record(z.string(), z.array(z.string().trim().min(1)).min(1)),
      })
      .nullable(),
  }),
]);

export type SubmissionVisualPresentation = z.infer<
  typeof SubmissionVisualPresentationSchema
>;
export type SubmissionInteractionView = z.infer<typeof SubmissionInteractionViewSchema>;
