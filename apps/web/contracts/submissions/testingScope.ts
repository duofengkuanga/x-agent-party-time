import { z } from 'zod';
import { HandoffRelativePathSchema, HandoffTextSchema } from './handoff';

export const CommitShaSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

const TestPointFields = {
  title: HandoffTextSchema.min(1).max(120),
  steps: HandoffTextSchema.min(1),
  expectedResult: HandoffTextSchema.min(1),
};
const OriginalTestPointSchema = z.strictObject({
  kind: z.literal('ORIGINAL'),
  ...TestPointFields,
});
const RegressionTestPointSchema = z.strictObject({
  kind: z.literal('DERIVED'),
  ...TestPointFields,
  reason: HandoffTextSchema.min(1).max(300),
  evidence: z
    .array(
      z.strictObject({ path: HandoffRelativePathSchema, note: HandoffTextSchema.min(1) }),
    )
    .min(1)
    .max(5),
});

export const TestingScopeSchema = z
  .strictObject({
    review: z.strictObject({
      baseCommit: CommitShaSchema,
      headCommit: CommitShaSchema,
      verdict: z.literal('READY'),
    }),
    points: z
      .array(
        z.discriminatedUnion('kind', [
          OriginalTestPointSchema,
          RegressionTestPointSchema,
        ]),
      )
      .min(1)
      .max(20),
    limitations: z.array(HandoffTextSchema.min(1)).max(5),
  })
  .refine(
    (scope) => scope.points.some((point) => point.kind === 'ORIGINAL'),
    '测试范围必须包含原问题的验收点',
  );

// Only business instructions cross the tester projection; source evidence stays
// in the stored result and the responsible developer's frozen Repair Handoff.
export const TestingScopeViewSchema = z.object({
  points: z.array(
    z.discriminatedUnion('kind', [
      OriginalTestPointSchema,
      RegressionTestPointSchema.omit({ evidence: true }),
    ]),
  ),
  limitations: TestingScopeSchema.shape.limitations,
});

export const UpdateTestingScopeSchema = z.strictObject({
  candidatePosition: z.number().int().nonnegative(),
  engineeringAlias: z.string().regex(/^repo-[1-9]\d*$/u),
  testingScope: TestingScopeSchema,
});
export const UpdateTestingScopeViewSchema = UpdateTestingScopeSchema.extend({
  testingScope: TestingScopeViewSchema,
});

export type TestingScope = z.infer<typeof TestingScopeSchema>;
export type TestingScopeView = z.infer<typeof TestingScopeViewSchema>;

export function projectTestingScope(scope: TestingScope): TestingScopeView {
  return {
    points: scope.points.map((point) =>
      point.kind === 'DERIVED'
        ? {
            kind: point.kind,
            title: point.title,
            steps: point.steps,
            expectedResult: point.expectedResult,
            reason: point.reason,
          }
        : { ...point },
    ),
    limitations: scope.limitations,
  };
}
