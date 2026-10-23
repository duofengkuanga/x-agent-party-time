'use server';

import {
  mutationAction,
  type InteractiveActionResult,
} from '@/app/actions/actionTransport';
import { repairService } from '../../../server/runtime/services';
import type {
  RepairMutationResult,
  ResolveRepairInteractionInput,
  SynchronizeRepairSessionInput,
} from '../../../contracts/submissions/repair';

export type RepairActionResult = InteractiveActionResult<RepairMutationResult>;

export async function synchronizeRepairSessionAction(
  bugId: string,
  input: SynchronizeRepairSessionInput,
): Promise<RepairActionResult> {
  return runRepairAction((userId) =>
    repairService().synchronizeSession(userId, bugId, input),
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

const runRepairAction = mutationAction('submission_repair_action_validation_failed');
