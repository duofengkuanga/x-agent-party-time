'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireCurrentUser } from '@/platform/auth/server';
import { publicError, type PlatformErrorCode } from '@/platform/errors';
import { logger } from '@/platform/logging';
import { repairService } from '../application/server';
import type {
  ContinueRepairInput,
  RepairMutationResult,
  ResolveRepairInteractionInput,
  StopRepairInput,
} from '../contract';

type RepairActionFailure = {
  ok: false;
  error: { code: PlatformErrorCode; message: string };
};

export type RepairActionResult =
  { ok: true; result: RepairMutationResult } | RepairActionFailure;

export async function continueRepairAction(
  bugId: string,
  input: ContinueRepairInput,
): Promise<RepairActionResult> {
  return runRepairAction((userId) =>
    repairService().continueRepair(userId, bugId, input),
  );
}

export async function stopRepairExecutionAction(
  bugId: string,
  input: StopRepairInput,
): Promise<RepairActionResult> {
  return runRepairAction((userId) =>
    repairService().stopExecution(userId, bugId, input),
  );
}

export async function resolveRepairInteractionAction(
  interactionId: string,
  input: ResolveRepairInteractionInput,
): Promise<RepairActionResult> {
  return runRepairAction((userId) =>
    repairService().resolveInteraction(userId, interactionId, input),
  );
}

async function runRepairAction(
  command: (userId: string) => RepairMutationResult,
): Promise<RepairActionResult> {
  const user = await requireCurrentUser();
  try {
    const result = command(user.id);
    revalidatePath('/cooking');
    return { ok: true, result };
  } catch (error) {
    if (error instanceof ZodError) {
      logger.error('cooking_repair_action_validation_failed', error, {
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
