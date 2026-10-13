import { z } from 'zod';
import type { ExecutionResultAssertion } from '@agent-party-time/execution-contract';

// These checks reject recognizable local paths and credential assignments. The
// Skill also limits the content to portable, non-secret historical context.
// Encode case folding in the pattern: JSON Schema does not carry RegExp flags.
const credentialName =
  'password|secret|token|api[_-]?key|authorization|credential'.replace(
    /[a-z]/gu,
    (letter) => `[${letter}${letter.toUpperCase()}]`,
  );
const absolutePath = String.raw`(?:(?:^|[\s"'=\x60([{<：:，,;；（【《“‘])(?:/(?!/)|~/)|\b[A-Za-z]:(?:\\|/(?!/))|(?<![A-Za-z0-9_./-])/(?:Users|home|private|var|tmp|Volumes|Applications|Library|opt|usr|root|workspace|data)(?:/|$))`;
const portableContext = new RegExp(
  String.raw`^(?![\s\S]*${absolutePath})(?![\s\S]*(?:${credentialName})["']?\s*[:=：]\s*\S+)[\s\S]*$`,
);
export const REPAIR_HANDOFF_TEXT_ASSERTION: ExecutionResultAssertion = {
  kind: 'JSON_STRING_PATTERN',
  resultPath: ['result', 'handoff'],
  pattern: portableContext.source,
};
export const UPDATE_HANDOFF_TEXT_ASSERTION: ExecutionResultAssertion = {
  kind: 'JSON_STRING_PATTERN',
  resultPath: ['result', 'handoffUse'],
  pattern: portableContext.source,
};
export const HandoffTextSchema = z
  .string()
  .trim()
  .max(1_000)
  .refine(
    (text) => portableContext.test(text),
    '交接只允许可移植的非敏感信息，不得包含本机绝对路径或凭据',
  );

const pathSegment = String.raw`(?:\.|[^./\\:\r\n~][^/\\:\r\n]*|\.[^./\\:\r\n][^/\\:\r\n]*|\.{2}[^/\\:\r\n]+)`;
export const HandoffRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(new RegExp(`^${pathSegment}(?:/${pathSegment})*$`), '必须使用仓库内的相对路径');

export const RepairHandoffSchema = z.strictObject({
  validationCommands: z
    .array(
      z.strictObject({
        validationIndex: z.number().int().min(0).max(4),
        command: HandoffTextSchema.min(1),
        workingDirectory: HandoffRelativePathSchema,
        runtime: HandoffTextSchema,
        conditions: HandoffTextSchema,
      }),
    )
    .max(10),
  environmentNotes: z
    .array(
      z.strictObject({
        issue: HandoffTextSchema,
        resolution: HandoffTextSchema,
        appliesWhen: HandoffTextSchema,
      }),
    )
    .max(5),
  impact: z
    .array(
      z.strictObject({
        path: HandoffRelativePathSchema,
        note: HandoffTextSchema,
      }),
    )
    .max(10),
  remainingWork: z.array(HandoffTextSchema).max(5),
  limitations: z.array(HandoffTextSchema).max(5),
});

export type RepairHandoff = z.infer<typeof RepairHandoffSchema>;
