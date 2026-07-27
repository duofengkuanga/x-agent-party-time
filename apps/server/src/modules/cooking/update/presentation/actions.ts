'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireCurrentUser } from '@/platform/auth/server';
import { publicError, type PlatformErrorCode } from '@/platform/errors';
import { logger } from '@/platform/logging';
import { updateService } from '../application/server';
import type {
  ContinueUpdateInput,
  ResolveUpdateInteractionInput,
  UpdateBatchCommandInput,
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

export async function continueUpdateAction(
  batchId: string,
  input: ContinueUpdateInput,
): Promise<UpdateActionResult> {
  return runUpdateAction((userId) =>
    updateService().continueUpdate(userId, batchId, input),
  );
}

export async function cancelUpdateBatchAction(
  batchId: string,
  input: UpdateBatchCommandInput,
): Promise<UpdateActionResult> {
  return runUpdateAction((userId) =>
    updateService().cancelBatch(userId, batchId, input),
  );
}

export async function stopUpdateExecutionAction(
  batchId: string,
  input: UpdateBatchCommandInput,
): Promise<UpdateActionResult> {
  return runUpdateAction((userId) =>
    updateService().stopExecution(userId, batchId, input),
  );
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
}
