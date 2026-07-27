import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';

export const AllowedMediaTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'application/json',
]);

export const StoredFileSchema = z.object({
  id: z.uuid(),
  storageKey: z.string().regex(/^[a-f0-9]{48}$/u),
  originalName: z.string().trim().min(1).max(255),
  mediaType: AllowedMediaTypeSchema,
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  uploadedByUserId: z.string().trim().min(1).max(80),
  createdAt: z.iso.datetime(),
});

export type StoredFile = z.infer<typeof StoredFileSchema>;
export type AllowedMediaType = z.infer<typeof AllowedMediaTypeSchema>;

type StoredFileRow = {
  id: string;
  storage_key: string;
  original_name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by_user_id: string;
  created_at: string;
};

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export class LocalFileStore {
  private readonly root: string;

  constructor(
    private readonly db: AppDatabase,
    root: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = resolve(root);
  }

  async put(input: {
    bytes: Uint8Array;
    originalName: string;
    mediaType: AllowedMediaType;
    uploadedByUserId: string;
  }): Promise<StoredFile> {
    const mediaType = AllowedMediaTypeSchema.parse(input.mediaType);
    const originalName = input.originalName.trim();
    if (!originalName || originalName.length > 255)
      throw new PlatformError('VALIDATION_FAILED', '附件文件名无效');
    if (input.bytes.byteLength === 0)
      throw new PlatformError('VALIDATION_FAILED', '附件不能为空');
    if (input.bytes.byteLength > MAX_FILE_BYTES)
      throw new PlatformError('FILE_TOO_LARGE', '单个附件不能超过 10 MB');

    const storedFile = StoredFileSchema.parse({
      id: randomUUID(),
      storageKey: randomBytes(24).toString('hex'),
      originalName,
      mediaType,
      sizeBytes: input.bytes.byteLength,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      uploadedByUserId: input.uploadedByUserId,
      createdAt: this.now().toISOString(),
    });
    const finalPath = this.contentPath(storedFile.storageKey);
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(temporaryPath, input.bytes, { flag: 'wx' });

    try {
      await rename(temporaryPath, finalPath);
      this.db
        .prepare(
          `INSERT INTO platform_file(
             id, storage_key, original_name, media_type, size_bytes,
             sha256, uploaded_by_user_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          storedFile.id,
          storedFile.storageKey,
          storedFile.originalName,
          storedFile.mediaType,
          storedFile.sizeBytes,
          storedFile.sha256,
          storedFile.uploadedByUserId,
          storedFile.createdAt,
        );
      return storedFile;
    } catch (error) {
      await rm(temporaryPath, { force: true });
      await rm(finalPath, { force: true });
      throw error;
    }
  }

  get(fileId: string): StoredFile | null {
    const row = this.db
      .prepare(
        `SELECT id, storage_key, original_name, media_type, size_bytes,
                sha256, uploaded_by_user_id, created_at
         FROM platform_file WHERE id = ?`,
      )
      .get(fileId) as StoredFileRow | undefined;
    return row ? mapStoredFile(row) : null;
  }

  async read(fileId: string): Promise<{ file: StoredFile; bytes: Uint8Array }> {
    const file = this.get(fileId);
    if (!file) throw new PlatformError('NOT_FOUND', '附件不存在');
    return { file, bytes: await readFile(this.contentPath(file.storageKey)) };
  }

  async deleteUnbound(
    fileId: string,
    uploadedByUserId: string,
  ): Promise<boolean> {
    const file = this.get(fileId);
    if (!file || file.uploadedByUserId !== uploadedByUserId) return false;
    const deletion = this.db
      .prepare(
        `DELETE FROM platform_file
         WHERE id = ? AND uploaded_by_user_id = ?`,
      )
      .run(fileId, uploadedByUserId);
    if (deletion.changes !== 1) return false;
    await rm(this.contentPath(file.storageKey), { force: true });
    return true;
  }

  private contentPath(storageKey: string): string {
    if (!/^[a-f0-9]{48}$/u.test(storageKey))
      throw new PlatformError('VALIDATION_FAILED', '附件存储键无效');
    const path = resolve(this.root, storageKey.slice(0, 2), storageKey);
    if (!path.startsWith(`${this.root}/`))
      throw new PlatformError('VALIDATION_FAILED', '附件路径无效');
    return path;
  }
}

function mapStoredFile(row: StoredFileRow): StoredFile {
  const parsed = StoredFileSchema.safeParse({
    id: row.id,
    storageKey: row.storage_key,
    originalName: row.original_name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    uploadedByUserId: row.uploaded_by_user_id,
    createdAt: row.created_at,
  });
  if (!parsed.success)
    throw new PlatformError('INTERNAL_ERROR', '附件元数据无效', {
      cause: parsed.error,
    });
  return parsed.data;
}
