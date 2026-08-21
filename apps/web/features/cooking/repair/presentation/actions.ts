'use server';

import {
  runInteractiveMutation,
  type InteractiveActionResult,
} from '@/features/cooking/shared/action-transport';
import { repairService } from '../application/server';
import type {
  ContinueRepairInput,
  RepairMutationResult,
  ResolveRepairInteractionInput,
  SynchronizeRepairSessionInput,
} from '../contract';

export type RepairActionResult = InteractiveActionResult<RepairMutationResult>;

export async function continueRepairAction(
  bugId: string,
  input: ContinueRepairInput,
): Promise<RepairActionResult> {
  return runRepairAction((userId) =>
    repairService().continueRepair(userId, bugId, input),
  );
}

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

function runRepairAction(
  command: (userId: string) => RepairMutationResult,
): Promise<RepairActionResult> {
  return runInteractiveMutation({
    validationEvent: 'cooking_repair_action_validation_failed',
    command: ({ userId }) => ({
      result: command(userId),
      refreshPaths: ['/cooking'],
    }),
  });
}
