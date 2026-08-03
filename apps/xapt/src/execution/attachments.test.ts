import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaimedExecution } from '@agent-party-time/execution-contract';
import { xaptPaths } from '../platform/paths';
import { AttachmentMaterializer, type ExecutionFileHttp } from './attachments';

const homes: string[] = [];
const bytes = new TextEncoder().encode('attachment-content');

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

test('附件下载后强制校验长度与 SHA，并使用私有缓存文件名', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xapt-attachments-'));
  homes.push(home);
  const materializer = new AttachmentMaterializer(
    { downloadExecutionFile: async () => bytes } as ExecutionFileHttp,
    xaptPaths(home),
  );

  const [attachment] = await materializer.materialize(
    'https://apt.example.com',
    'credential-secret-at-least-thirty-two-characters',
    execution(createHash('sha256').update(bytes).digest('hex')),
  );
  const attachmentPath = attachment?.path;

  expect(attachment).toMatchObject({
    fileId: '00000000-0000-4000-8000-000000000501',
    originalName: 'private-note.txt',
    path: expect.stringContaining('00000000-0000-4000-8000-000000000501.txt'),
  });
  expect(typeof attachmentPath).toBe('string');
  expect((await stat(attachmentPath!)).mode & 0o777).toBe(0o600);
});

test('SHA 不匹配时拒绝物化', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xapt-attachments-'));
  homes.push(home);
  const materializer = new AttachmentMaterializer(
    { downloadExecutionFile: async () => bytes } as ExecutionFileHttp,
    xaptPaths(home),
  );

  await expect(
    materializer.materialize(
      'https://apt.example.com',
      'credential-secret-at-least-thirty-two-characters',
      execution('0'.repeat(64)),
    ),
  ).rejects.toThrow('附件内容校验失败');
});

function execution(sha256: string): ClaimedExecution {
  return {
    id: '00000000-0000-4000-8000-000000000500',
    attachments: [
      {
        id: '00000000-0000-4000-8000-000000000501',
        originalName: '../private-note.txt',
        mediaType: 'text/plain',
        sizeBytes: bytes.byteLength,
        sha256,
      },
    ],
    lease: {
      token: 'lease-token-at-least-thirty-two-characters',
      expiresAt: '2026-08-03T09:00:00.000Z',
    },
  } as ClaimedExecution;
}
