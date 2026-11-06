import type { TestingScope } from '@/contracts/submissions/testingScope';

export function testTestingScope(
  headCommit = 'a'.repeat(40),
  baseCommit = '0'.repeat(40),
): TestingScope {
  return {
    review: { baseCommit, headCommit, verdict: 'READY' },
    points: [
      {
        kind: 'ORIGINAL',
        title: '复测原问题',
        steps: '按缺陷描述重现原操作。',
        expectedResult: '原问题不再出现，行为符合缺陷中的预期。',
      },
    ],
    limitations: [],
  };
}

export function testUpdateTestingScopes(
  positions = [0],
  headCommit = 'a'.repeat(40),
  engineeringAlias = 'repo-1',
) {
  return positions.map((candidatePosition) => ({
    candidatePosition,
    engineeringAlias,
    testingScope: testTestingScope(headCommit),
  }));
}
