import type {
  CollaborativeCommand,
  CollaborativeCommandResult,
  CollaborativeQuery,
  CollaborativeQueryResult,
  EngineeringBindingSummary,
  EngineeringDetail,
  EngineeringSummary,
  ProjectMemberSummary,
  SubmissionBug,
} from '@agent-party-time/shared/control-plane';
import type { ItemCatalog } from './model';

export async function loadProjectCatalog(projectId: string) {
  const [engineeringResult, collaborationResult] = await Promise.all([
    requestJson<{ items?: EngineeringSummary[]; error?: string }>(
      `/api/control-plane/projects/${projectId}/engineerings?includeArchived=false`,
    ),
    requestJson<{ members?: ProjectMemberSummary[]; error?: string }>(
      `/api/control-plane/projects/${projectId}/collaboration`,
    ),
  ]);
  const summaries = (engineeringResult.items ?? []).filter(
    (item) => !item.archivedAt && item.canViewTechnicalConfiguration,
  );
  const details = await Promise.all(
    summaries.map(async (summary) => {
      const [detailResult, bindingResult] = await Promise.all([
        requestJson<{ engineering?: EngineeringDetail; error?: string }>(
          `/api/control-plane/engineerings/${summary.id}`,
        ),
        requestJson<{ items?: EngineeringBindingSummary[]; error?: string }>(
          `/api/control-plane/engineerings/${summary.id}/bindings`,
        ),
      ]);
      if (!detailResult.engineering) return null;
      const bindings = bindingResult.items ?? [];
      if (bindings.length === 0) return null;
      return { engineering: detailResult.engineering, bindings };
    }),
  );
  return {
    catalog: details.filter((item): item is ItemCatalog => item !== null),
    members: collaborationResult.members ?? [],
  };
}

export async function collaborativeCommand(input: CollaborativeCommand) {
  return requestJson<CollaborativeCommandResult>(
    '/api/control-plane/collaborative/command',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify(input),
    },
  );
}

export async function collaborativeQuery(input: CollaborativeQuery) {
  return requestJson<CollaborativeQueryResult>(
    '/api/control-plane/collaborative/query',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      cache: 'no-store',
    },
  );
}

export async function requestJson<TResult>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const result = (await response.json()) as TResult & { error?: string };
  if (!response.ok) throw new Error(result.error ?? '请求失败');
  return result;
}

export async function fileUpload(file: File) {
  if (file.size > 10 * 1024 * 1024)
    throw new Error(`${file.name} 超过 10 兆字节限制`);
  const mediaTypes = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain',
    'application/json',
  ]);
  if (!mediaTypes.has(file.type))
    throw new Error(`${file.name} 的类型不受支持`);
  return {
    fileName: file.name,
    mediaType: file.type as
      | 'image/png'
      | 'image/jpeg'
      | 'image/webp'
      | 'text/plain'
      | 'application/json',
    sizeBytes: file.size,
    contentBase64: await fileToBase64(file),
  };
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取附件 ${file.name}`));
    reader.onload = () => {
      const value = String(reader.result ?? '');
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function downloadAttachment(attachmentId: string) {
  const result = await collaborativeQuery({
    kind: 'bug.attachment.get',
    attachmentId,
  });
  if (!result.attachment || !result.contentBase64)
    throw new Error('附件不存在');
  const binary = atob(result.contentBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(
    new Blob([bytes], { type: result.attachment.mediaType }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.attachment.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function bugLabel(bugs: SubmissionBug[], bugId: string) {
  const bug = bugs.find((candidate) => candidate.id === bugId);
  return bug
    ? `${bug.shortId.replace(/^BUG-/, '缺陷-')} ${bug.title}`
    : bugId.slice(0, 8);
}

export function formatCompactDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} 字节`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} 千字节`;
  return `${(value / 1024 / 1024).toFixed(1)} 兆字节`;
}

export function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
