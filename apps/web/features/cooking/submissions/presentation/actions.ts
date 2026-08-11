'use server';

import { requireCurrentUser } from '@/server/auth/server';
import { publicError, type PlatformErrorCode } from '@/server/errors';
import {
  runInteractiveMutation,
  type InteractiveActionResult,
} from '@/features/cooking/shared/action-transport';
import {
  submissionCreationCatalog,
  submissionService,
} from '@/features/cooking/application/server';
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

export type SubmissionActionResult = InteractiveActionResult<TestSubmission>;

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
  return runInteractiveMutation({
    validationEvent: 'cooking_submission_action_validation_failed',
    command: ({ userId }) => {
      const result = submissionService().createSubmission(
        userId,
        projectId,
        input,
      );
      return {
        result,
        refreshPaths: ['/cooking', `/cooking/${result.id}`],
      };
    },
  });
}

export async function updateSubmissionAction(
  submissionId: string,
  input: UpdateSubmissionInput,
): Promise<SubmissionActionResult> {
  return runInteractiveMutation({
    validationEvent: 'cooking_submission_action_validation_failed',
    command: ({ userId }) => {
      const result = submissionService().updateSubmission(
        userId,
        submissionId,
        input,
      );
      return {
        result,
        refreshPaths: ['/cooking', `/cooking/${result.id}`],
      };
    },
  });
}

function actionError(error: unknown): SubmissionActionFailure {
  const visible = publicError(error);
  return {
    ok: false,
    error: { code: visible.code, message: visible.message },
  };
}
