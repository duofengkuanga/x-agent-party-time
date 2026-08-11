'use server';

import {
  integerFormField,
  optionalFormField,
  requiredFormField,
  runInteractiveMutation,
  type InteractiveActionResult,
} from '@/features/cooking/shared/action-transport';
import { lifecycleService } from '../application/server';
import type {
  BugLifecycleMutationResult,
  CleanupMutationResult,
  CloseSubmissionMutationResult,
  LifecycleCommandInput,
  ResolveCleanupInteractionInput,
} from '../contract';

export type BugLifecycleActionResult =
  InteractiveActionResult<BugLifecycleMutationResult>;
export type CloseSubmissionActionResult =
  InteractiveActionResult<CloseSubmissionMutationResult>;
export type CleanupActionResult =
  InteractiveActionResult<CleanupMutationResult>;

export async function verifyBugAction(
  bugId: string,
  formData: FormData,
): Promise<BugLifecycleActionResult> {
  return runLifecycleUpload(formData, async (userId, attachmentIds) => {
    const result = requiredFormField(formData, 'result');
    const common = {
      mutationId: requiredFormField(formData, 'mutationId'),
      expectedVersion: integerFormField(formData, 'expectedVersion'),
      attachmentIds,
    };
    return lifecycleService().verifyBug(
      userId,
      bugId,
      result === 'PASSED'
        ? {
            ...common,
            result: 'PASSED',
            comment: optionalFormField(formData, 'comment'),
          }
        : {
            ...common,
            result: 'FAILED',
            feedback: requiredFormField(formData, 'feedback'),
          },
    );
  });
}

export async function reopenBugAction(
  bugId: string,
  formData: FormData,
): Promise<BugLifecycleActionResult> {
  return runLifecycleUpload(formData, (userId, attachmentIds) =>
    lifecycleService().reopenBug(userId, bugId, {
      mutationId: requiredFormField(formData, 'mutationId'),
      expectedVersion: integerFormField(formData, 'expectedVersion'),
      feedback: requiredFormField(formData, 'feedback'),
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

export async function restoreBugAction(
  bugId: string,
  input: LifecycleCommandInput,
): Promise<BugLifecycleActionResult> {
  return simpleAction((userId) =>
    lifecycleService().restoreBug(userId, bugId, input),
  );
}

export async function archiveBugAction(
  bugId: string,
  input: LifecycleCommandInput,
): Promise<BugLifecycleActionResult> {
  return simpleAction((userId) =>
    lifecycleService().archiveBug(userId, bugId, input),
  );
}

export async function unarchiveBugAction(
  bugId: string,
  input: LifecycleCommandInput,
): Promise<BugLifecycleActionResult> {
  return simpleAction((userId) =>
    lifecycleService().unarchiveBug(userId, bugId, input),
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

function runLifecycleUpload(
  formData: FormData,
  command: (
    userId: string,
    attachmentIds: string[],
  ) => BugLifecycleMutationResult | Promise<BugLifecycleMutationResult>,
): Promise<BugLifecycleActionResult> {
  return runInteractiveMutation({
    validationEvent: 'cooking_lifecycle_action_validation_failed',
    command: async ({ userId, uploadFiles }) => {
      const attachmentIds = await uploadFiles(formData, 'attachments');
      return {
        result: await command(userId, attachmentIds),
        boundFileIds: attachmentIds,
        refreshPaths: ['/cooking'],
      };
    },
  });
}

function simpleAction<T>(
  command: (userId: string) => T,
): Promise<InteractiveActionResult<T>> {
  return runInteractiveMutation({
    validationEvent: 'cooking_lifecycle_action_validation_failed',
    command: ({ userId }) => ({
      result: command(userId),
      refreshPaths: ['/cooking'],
    }),
  });
}
