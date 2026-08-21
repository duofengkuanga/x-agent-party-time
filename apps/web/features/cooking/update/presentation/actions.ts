'use server';

import {
  formField,
  integerFormField,
  optionalFormField,
  runInteractiveMutation,
  type InteractiveActionResult,
} from '@/features/cooking/shared/action-transport';
import { updateService } from '../application/server';
import type {
  RetryUpdateInput,
  SynchronizeUpdateSessionInput,
  ResolveUpdateInteractionInput,
  UpdateMutationResult,
} from '../contract';

export type UpdateActionResult = InteractiveActionResult<UpdateMutationResult>;

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

export async function synchronizeUpdateSessionAction(
  batchId: string,
  input: SynchronizeUpdateSessionInput,
): Promise<UpdateActionResult> {
  return runUpdateAction((userId) =>
    updateService().synchronizeSession(userId, batchId, input),
  );
}

export async function reportExternalDeploymentAction(
  batchId: string,
  formData: FormData,
): Promise<UpdateActionResult> {
  return runInteractiveMutation({
    validationEvent: 'cooking_update_action_validation_failed',
    command: async ({ userId, uploadFiles }) => {
      const attachmentIds = await uploadFiles(formData, 'attachments');
      const mutationId = formField(formData, 'mutationId');
      const expectedVersion = integerFormField(formData, 'expectedVersion');
      const outcome = formField(formData, 'outcome');
      const summary = optionalFormField(formData, 'summary');
      const input =
        outcome === 'FAILED'
          ? {
              mutationId,
              expectedVersion,
              outcome: 'FAILED' as const,
              summary: summary ?? '',
              attachmentIds,
            }
          : {
              mutationId,
              expectedVersion,
              outcome: 'SUCCEEDED' as const,
              summary,
              attachmentIds,
            };
      return {
        result: updateService().reportExternalDeployment(
          userId,
          batchId,
          input,
        ),
        boundFileIds: attachmentIds,
        refreshPaths: ['/cooking'],
      };
    },
  });
}

export async function resolveUpdateInteractionAction(
  interactionId: string,
  input: ResolveUpdateInteractionInput,
): Promise<UpdateActionResult> {
  return runUpdateAction((userId) =>
    updateService().resolveInteraction(userId, interactionId, input),
  );
}

function runUpdateAction(
  command: (userId: string) => UpdateMutationResult,
): Promise<UpdateActionResult> {
  return runInteractiveMutation({
    validationEvent: 'cooking_update_action_validation_failed',
    command: ({ userId }) => ({
      result: command(userId),
      refreshPaths: ['/cooking'],
    }),
  });
}
