import type { RepairHandoff } from '@/contracts/submissions/handoff';
import type { UpdateHandoffUse } from '@/contracts/submissions/update';

export function testRepairHandoff(): RepairHandoff {
  return {
    convention: null,
    artifact: null,
    suggestedSkills: [],
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
