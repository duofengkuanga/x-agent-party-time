'use server';

import {
  mutationAction,
  type InteractiveActionResult,
} from '@/app/actions/actionTransport';
import { updateService } from '../../../server/runtime/services';
import type {
  SynchronizeUpdateSessionInput,
  ResolveUpdateInteractionInput,
  RetryUpdateInput,
  UpdateMutationResult,
} from '../../../contracts/submissions/update';

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
  return runUpdateAction((userId) => updateService().retryUpdate(userId, batchId, input));
}

export async function synchronizeUpdateSessionAction(
  batchId: string,
  input: SynchronizeUpdateSessionInput,
): Promise<UpdateActionResult> {
  return runUpdateAction((userId) =>
    updateService().synchronizeSession(userId, batchId, input),
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

const runUpdateAction = mutationAction('submission_update_action_validation_failed');
