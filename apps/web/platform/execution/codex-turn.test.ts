import { expect, test } from 'bun:test';
import { createInitialCodexTurn } from './codex-turn';

test('Execution Brief Hash 不受对象键顺序影响', () => {
  const first = createInitialCodexTurn({
    requiredSkillName: 'agent-party-time-repair-bug',
    executionBrief: { bug: { title: '按钮失效', id: 'bug-1' }, attempt: 1 },
    outputJsonSchema: { type: 'object' },
  });
  const second = createInitialCodexTurn({
    requiredSkillName: 'agent-party-time-repair-bug',
    executionBrief: { attempt: 1, bug: { id: 'bug-1', title: '按钮失效' } },
    outputJsonSchema: { type: 'object' },
  });

  expect(first.executionBriefHash).toBe(second.executionBriefHash);
});
