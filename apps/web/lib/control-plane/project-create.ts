import { z } from 'zod';
import {
  CreateProjectCommandSchema,
  ProjectSlugSchema,
  UserIdSchema,
  type CreateProjectCommand,
} from '@agent-party-time/shared/control-plane';

const CreateWebProjectRequestSchema = z
  .object({
    slug: z.preprocess(
      (value) =>
        typeof value === 'string' && value.trim() === '' ? undefined : value,
      ProjectSlugSchema.optional(),
    ),
    title: z.preprocess(
      (value) =>
        typeof value === 'string' && value.trim() === '' ? undefined : value,
      z.string().trim().min(1).max(120).nullable().optional(),
    ),
    inviteeUserIds: z.array(UserIdSchema).max(50).default([]),
  })
  .superRefine((value, context) => {
    if (!value.slug && !value.title)
      context.addIssue({
        code: 'custom',
        path: ['title'],
        message: '请填写项目名称',
      });
    if (new Set(value.inviteeUserIds).size !== value.inviteeUserIds.length)
      context.addIssue({
        code: 'custom',
        path: ['inviteeUserIds'],
        message: '受邀开发人员不能重复',
      });
  });

export async function prepareProjectCreation(
  raw: unknown,
  idempotencyKey: string,
): Promise<{
  command: CreateProjectCommand;
  inviteeUserIds: string[];
}> {
  const input = CreateWebProjectRequestSchema.parse(raw);
  return {
    command: CreateProjectCommandSchema.parse({
      slug: input.slug ?? (await generatedProjectSlug(idempotencyKey)),
      title: input.title ?? null,
    }),
    inviteeUserIds: input.inviteeUserIds,
  };
}

export async function projectInvitationIdempotencyKey(
  projectCreationKey: string,
  inviteeUserId: string,
) {
  return `web-project-invite:${await stableToken(
    `${projectCreationKey}:${inviteeUserId}`,
  )}`;
}

async function generatedProjectSlug(idempotencyKey: string) {
  return `project-${await stableToken(idempotencyKey)}`;
}

async function stableToken(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
