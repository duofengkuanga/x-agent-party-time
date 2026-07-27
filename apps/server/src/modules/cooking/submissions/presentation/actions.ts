'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireCurrentUser } from '@/platform/auth/server';
import { publicError, type PlatformErrorCode } from '@/platform/errors';
import {
  submissionCreationCatalog,
  submissionService,
} from '@/modules/cooking/application/server';
import type {
  CreateSubmissionInput,
  SubmissionCreationCatalog,
  TestSubmission,
  UpdateSubmissionInput,
} from '../contract';

type SubmissionActionFailure = {
  ok: false;
  error: { code: PlatformErrorCode; message: string };
};

export type SubmissionActionResult =
  { ok: true; submission: TestSubmission } | SubmissionActionFailure;

export type SubmissionCatalogActionResult =
  { ok: true; catalog: SubmissionCreationCatalog } | SubmissionActionFailure;

export async function loadSubmissionCreationCatalogAction(): Promise<SubmissionCatalogActionResult> {
  const user = await requireCurrentUser();
  try {
    return {
      ok: true,
      catalog: submissionCreationCatalog(user.id),
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function createSubmissionAction(
  projectId: string,
  input: CreateSubmissionInput,
): Promise<SubmissionActionResult> {
  const user = await requireCurrentUser();
  try {
    const submission = submissionService().createSubmission(
      user.id,
      projectId,
      input,
    );
    revalidateSubmission(submission.id);
    return { ok: true, submission };
  } catch (error) {
    return actionError(error);
  }
}

export async function updateSubmissionAction(
  submissionId: string,
  input: UpdateSubmissionInput,
): Promise<SubmissionActionResult> {
  const user = await requireCurrentUser();
  try {
    const submission = submissionService().updateSubmission(
      user.id,
      submissionId,
      input,
    );
    revalidateSubmission(submission.id);
    return { ok: true, submission };
  } catch (error) {
    return actionError(error);
  }
}

function actionError(error: unknown): SubmissionActionFailure {
  if (error instanceof ZodError) {
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

function revalidateSubmission(submissionId: string): void {
  revalidatePath('/cooking');
  revalidatePath(`/cooking/${submissionId}`);
}
