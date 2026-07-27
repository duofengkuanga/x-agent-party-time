'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireCurrentUser } from '@/platform/auth/server';
import {
  PlatformError,
  publicError,
  type PlatformErrorCode,
} from '@/platform/errors';
import {
  AllowedMediaTypeSchema,
  MAX_FILE_BYTES,
} from '@/platform/files/local-file-store';
import { logger } from '@/platform/logging';
import { cookingFileStore } from '@/modules/cooking/application/server';
import { lifecycleService } from '../application/server';
import type {
  BugLifecycleMutationResult,
  CleanupMutationResult,
  CloseSubmissionMutationResult,
  LifecycleCommandInput,
  ResolveCleanupInteractionInput,
} from '../contract';

type ActionFailure = {
  ok: false;
  error: { code: PlatformErrorCode; message: string };
};

export type BugLifecycleActionResult =
  { ok: true; result: BugLifecycleMutationResult } | ActionFailure;
export type CloseSubmissionActionResult =
  { ok: true; result: CloseSubmissionMutationResult } | ActionFailure;
export type CleanupActionResult =
  { ok: true; result: CleanupMutationResult } | ActionFailure;

export async function verifyBugAction(
  bugId: string,
  formData: FormData,
): Promise<BugLifecycleActionResult> {
  return withUploads(formData, async (userId, attachmentIds) => {
    const result = field(formData, 'result');
    const common = {
      mutationId: field(formData, 'mutationId'),
      expectedVersion: integerField(formData, 'expectedVersion'),
      attachmentIds,
    };
    return lifecycleService().verifyBug(
      userId,
      bugId,
      result === 'PASSED'
        ? {
            ...common,
            result: 'PASSED',
            comment: optionalField(formData, 'comment'),
          }
        : {
            ...common,
            result: 'FAILED',
            feedback: field(formData, 'feedback'),
          },
    );
  });
}

export async function reopenBugAction(
  bugId: string,
  formData: FormData,
): Promise<BugLifecycleActionResult> {
  return withUploads(formData, (userId, attachmentIds) =>
    lifecycleService().reopenBug(userId, bugId, {
      mutationId: field(formData, 'mutationId'),
      expectedVersion: integerField(formData, 'expectedVersion'),
      feedback: field(formData, 'feedback'),
      attachmentIds,
    }),
  );
}

export async function cancelBugAction(
  bugId: string,
  input: LifecycleCommandInput,
): Promise<BugLifecycleActionResult> {
  return simpleAction((userId) =>
    lifecycleService().cancelBug(userId, bugId, input),
  );
}

export async function closeSubmissionAction(
  submissionId: string,
  input: LifecycleCommandInput,
): Promise<CloseSubmissionActionResult> {
  return simpleAction((userId) =>
    lifecycleService().closeSubmission(userId, submissionId, input),
  );
}

export async function retryCleanupAction(
  cleanupId: string,
  input: LifecycleCommandInput,
): Promise<CleanupActionResult> {
  return simpleAction((userId) =>
    lifecycleService().retryCleanup(userId, cleanupId, input),
  );
}

export async function resolveCleanupInteractionAction(
  interactionId: string,
  input: ResolveCleanupInteractionInput,
): Promise<CleanupActionResult> {
  return simpleAction((userId) =>
    lifecycleService().resolveCleanupInteraction(userId, interactionId, input),
  );
}

async function withUploads(
  formData: FormData,
  command: (
    userId: string,
    attachmentIds: string[],
  ) => BugLifecycleMutationResult | Promise<BugLifecycleMutationResult>,
): Promise<BugLifecycleActionResult> {
  const user = await requireCurrentUser();
  const uploadedIds: string[] = [];
  try {
    for (const entry of formData.getAll('attachments')) {
      if (!(entry instanceof File) || entry.size === 0) continue;
      if (entry.size > MAX_FILE_BYTES)
        throw new PlatformError('FILE_TOO_LARGE', '单个附件不能超过 10 MB');
      const stored = await cookingFileStore().put({
        bytes: new Uint8Array(await entry.arrayBuffer()),
        originalName: entry.name,
        mediaType: AllowedMediaTypeSchema.parse(entry.type),
        uploadedByUserId: user.id,
      });
      uploadedIds.push(stored.id);
    }
    const result = await command(user.id, uploadedIds);
    revalidatePath('/cooking');
    return { ok: true, result };
  } catch (error) {
    await Promise.all(
      uploadedIds.map((fileId) =>
        cookingFileStore().deleteUnbound(fileId, user.id),
      ),
    );
    return actionError(error);
  }
}

async function simpleAction<T>(
  command: (userId: string) => T,
): Promise<{ ok: true; result: T } | ActionFailure> {
  const user = await requireCurrentUser();
  try {
    const result = command(user.id);
    revalidatePath('/cooking');
    return { ok: true, result };
  } catch (error) {
    return actionError(error);
  }
}

function actionError(error: unknown): ActionFailure {
  if (error instanceof ZodError) {
    logger.error('cooking_lifecycle_action_validation_failed', error, {
      issues: error.issues.map(({ code, path }) => ({
        code,
        location: path.join('.'),
      })),
    });
    return {
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: '提交内容不完整或格式不正确，请检查后重试。',
      },
    };
  }
  const visible = publicError(error);
  return {
    ok: false,
    error: { code: visible.code, message: visible.message },
  };
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string')
    throw new PlatformError('VALIDATION_FAILED', '提交内容不完整');
  return value;
}

function optionalField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function integerField(formData: FormData, name: string): number {
  const value = Number(field(formData, name));
  if (!Number.isInteger(value))
    throw new PlatformError('VALIDATION_FAILED', '提交版本无效');
  return value;
}
