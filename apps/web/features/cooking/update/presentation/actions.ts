'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireCurrentUser } from '@/server/auth/server';
import {
  PlatformError,
  publicError,
  type PlatformErrorCode,
} from '@/server/errors';
import {
  AllowedMediaTypeSchema,
  MAX_FILE_BYTES,
} from '@/server/files/local-file-store';
import { logger } from '@/server/logging';
import { cookingFileStore } from '@/features/cooking/application/server';
import { updateService } from '../application/server';
import type {
  RetryUpdateInput,
  ResolveUpdateInteractionInput,
  UpdateMutationResult,
} from '../contract';

type UpdateActionFailure = {
  ok: false;
  error: { code: PlatformErrorCode; message: string };
};

export type UpdateActionResult =
  { ok: true; result: UpdateMutationResult } | UpdateActionFailure;

export async function freezeUpdateNowAction(
  submissionItemId: string,
  input: { mutationId: string },
): Promise<UpdateActionResult> {
  return runUpdateAction((userId) =>
    updateService().freezeNow(userId, submissionItemId, input),
  );
}

export async function retryUpdateAction(
  batchId: string,
  input: RetryUpdateInput,
): Promise<UpdateActionResult> {
  return runUpdateAction((userId) =>
    updateService().retryUpdate(userId, batchId, input),
  );
}

export async function reportExternalDeploymentAction(
  batchId: string,
  formData: FormData,
): Promise<UpdateActionResult> {
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
    const mutationId = field(formData, 'mutationId');
    const expectedVersion = integerField(formData, 'expectedVersion');
    const outcome = field(formData, 'outcome');
    const summary = optionalField(formData, 'summary');
    const input =
      outcome === 'FAILED'
        ? {
            mutationId,
            expectedVersion,
            outcome: 'FAILED' as const,
            summary: summary ?? '',
            attachmentIds: uploadedIds,
          }
        : {
            mutationId,
            expectedVersion,
            outcome: 'SUCCEEDED' as const,
            summary,
            attachmentIds: uploadedIds,
          };
    const result = updateService().reportExternalDeployment(
      user.id,
      batchId,
      input,
    );
    revalidatePath('/cooking');
    return { ok: true, result };
  } catch (error) {
    await Promise.all(
      uploadedIds.map((fileId) =>
        cookingFileStore().deleteUnbound(fileId, user.id),
      ),
    );
    return updateActionError(error);
  }
}

export async function resolveUpdateInteractionAction(
  interactionId: string,
  input: ResolveUpdateInteractionInput,
): Promise<UpdateActionResult> {
  return runUpdateAction((userId) =>
    updateService().resolveInteraction(userId, interactionId, input),
  );
}

async function runUpdateAction(
  command: (userId: string) => UpdateMutationResult,
): Promise<UpdateActionResult> {
  const user = await requireCurrentUser();
  try {
    const result = command(user.id);
    revalidatePath('/cooking');
    return { ok: true, result };
  } catch (error) {
    return updateActionError(error);
  }
}

function updateActionError(error: unknown): UpdateActionFailure {
  if (error instanceof ZodError) {
    logger.error('cooking_update_action_validation_failed', error, {
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
