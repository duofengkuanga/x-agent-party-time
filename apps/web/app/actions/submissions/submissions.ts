'use server';

import { requireCurrentUser } from '@/app/auth';
import { publicError, type PlatformErrorCode } from '@/server/platform/errors/index';
import {
  runInteractiveMutation,
  type InteractiveActionResult,
} from '@/app/actions/actionTransport';
import { submissionCreationCatalog, submissionService } from '@/server/runtime/services';
import type {
  CreateSubmissionInput,
  AddSubmissionItemsInput,
  SubmissionCreationCatalog,
  TestSubmission,
  UpdateSubmissionInput,
  EnvironmentCommand,
  EnvironmentConflict,
} from '../../../contracts/submissions/submission';

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
): Promise<SubmissionActionResult & { conflicts?: EnvironmentConflict[] }> {
  const result = await runInteractiveMutation({
    validationEvent: 'submission_submission_action_validation_failed',
    command: ({ userId }) => {
      const result = submissionService().createSubmission(userId, projectId, input);
      return {
        result,
        refreshPaths: ['/submissions', `/submissions/${result.id}`],
      };
    },
  });
  if (!result.ok && ['RESOURCE_CONFLICT', 'STALE_STATE'].includes(result.error.code)) {
    const user = await requireCurrentUser();
    try {
      return {
        ...result,
        conflicts: submissionService().environmentConflicts(user.id, projectId, input),
      };
    } catch (error) {
      return actionError(error);
    }
  }
  return result;
}

export async function changeSubmissionEnvironmentAction(
  itemId: string,
  input: EnvironmentCommand,
): Promise<SubmissionActionResult> {
  return runInteractiveMutation({
    validationEvent: 'submission_environment_action_validation_failed',
    command: ({ userId }) => {
      const result = submissionService().changeEnvironment(userId, itemId, input);
      return { result, refreshPaths: ['/submissions', `/submissions/${result.id}`] };
    },
  });
}

export async function addSubmissionItemsAction(
  submissionId: string,
  input: AddSubmissionItemsInput,
): Promise<SubmissionActionResult & { conflicts?: EnvironmentConflict[] }> {
  const result = await runInteractiveMutation({
    validationEvent: 'submission_submission_action_validation_failed',
    command: ({ userId }) => {
      const result = submissionService().addItems(userId, submissionId, input);
      return { result, refreshPaths: ['/submissions', `/submissions/${result.id}`] };
    },
  });
  if (!result.ok && ['RESOURCE_CONFLICT', 'STALE_STATE'].includes(result.error.code)) {
    const user = await requireCurrentUser();
    try {
      return {
        ...result,
        conflicts: submissionService().addedItemConflicts(user.id, submissionId, input),
      };
    } catch (error) {
      return actionError(error);
    }
  }
  return result;
}

export async function updateSubmissionAction(
  submissionId: string,
  input: UpdateSubmissionInput,
): Promise<SubmissionActionResult> {
  return runInteractiveMutation({
    validationEvent: 'submission_submission_action_validation_failed',
    command: ({ userId }) => {
      const result = submissionService().updateSubmission(userId, submissionId, input);
      return {
        result,
        refreshPaths: ['/submissions', `/submissions/${result.id}`],
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
