import { z } from 'zod';

function optionalTrimmedText(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .transform((value) => value || undefined)
    .optional();
}

export const BugDescriptionSchema = z.object({
  operationPath: optionalTrimmedText(4_000),
  actualResult: optionalTrimmedText(8_000),
  expectedResult: optionalTrimmedText(8_000),
  supplementalDescription: optionalTrimmedText(8_000),
});

export type BugDescription = z.infer<typeof BugDescriptionSchema>;

export interface BugDescriptionSource {
  operationPath?: string | null;
  actualResult?: string | null;
  expectedResult?: string | null;
  supplementalDescription?: string | null;
}

export function compactBugDescription(
  input: BugDescriptionSource,
): BugDescription {
  const parsed = BugDescriptionSchema.parse(
    Object.fromEntries(
      Object.entries(input).filter(([, value]) => value != null),
    ),
  );
  return Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== undefined),
  ) as BugDescription;
}

export function compactBugDescriptionFields<T extends BugDescriptionSource>(
  input: T,
): Omit<T, keyof BugDescriptionSource> & BugDescription {
  const {
    operationPath,
    actualResult,
    expectedResult,
    supplementalDescription,
    ...rest
  } = input;
  return {
    ...rest,
    ...compactBugDescription({
      operationPath,
      actualResult,
      expectedResult,
      supplementalDescription,
    }),
  };
}
