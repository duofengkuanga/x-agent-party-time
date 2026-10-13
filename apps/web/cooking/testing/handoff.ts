import type { RepairHandoff } from '@/cooking/repair/handoff';
import type { UpdateHandoffUse } from '@/cooking/update/contract';

export function testRepairHandoff(): RepairHandoff {
  return {
    validationCommands: [],
    environmentNotes: [],
    impact: [],
    remainingWork: [],
    limitations: [],
  };
}

export function testHandoffUse(): UpdateHandoffUse {
  return { adopted: [], rechecked: [], validationCommands: [] };
}
