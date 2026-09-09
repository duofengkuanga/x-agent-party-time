import { join } from 'node:path';
import type { MaterializedAttachment } from '../execution/attachments';
import type { CodexExecutionInput } from './contract';
import { CodexAppServerError } from './errors';
import { asRecord, requiredString } from './wire-values';

export function codexUserInput(input: CodexExecutionInput): unknown[] {
  const text = textWithAttachments(
    input.text,
    input.attachments,
    Boolean(input.skill),
  );
  return [
    {
      type: 'text',
      text: input.skill ? `$${input.skill.name}\n\n${text}` : text,
      text_elements: [],
    },
    ...(input.skill
      ? [
          {
            type: 'skill',
            name: input.skill.name,
            path: join(input.skill.path, 'SKILL.md'),
          },
        ]
      : []),
  ];
}

function textWithAttachments(
  text: string,
  attachments: MaterializedAttachment[],
  initial: boolean,
): string {
  if (!attachments.length) return text;
  const mappings = attachments.map(({ fileId, originalName, path }) => ({
    fileId,
    originalName,
    path,
  }));
  if (initial) return materializeInitialAttachments(text, mappings);
  return `${text}\n\n新增附件本机路径：${JSON.stringify(mappings)}`;
}

function materializeInitialAttachments(
  text: string,
  mappings: Array<{ fileId: string; originalName: string; path: string }>,
): string {
  const brief = JSON.parse(text) as Record<string, unknown>;
  const references = Array.isArray(brief.attachmentReferences)
    ? brief.attachmentReferences
    : [];
  if (!references.length)
    throw new CodexAppServerError('初始任务缺少附件引用', null);
  const paths = new Map(mappings.map((mapping) => [mapping.fileId, mapping]));
  const evidence = references.map((reference) => {
    const value = asRecord(reference);
    const fileId = requiredString(value, 'fileId');
    const role = requiredString(value, 'role');
    const mapping = paths.get(fileId);
    if (!mapping) throw new CodexAppServerError('任务附件路径映射缺失', null);
    return { role, name: mapping.originalName, path: mapping.path };
  });
  const { attachmentReferences: _attachmentReferences, ...withoutReferences } =
    brief;
  return JSON.stringify({ ...withoutReferences, attachments: evidence });
}
