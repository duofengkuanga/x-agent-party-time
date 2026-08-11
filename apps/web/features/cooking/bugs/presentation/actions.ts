'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireCurrentUser } from '@/server/auth/server';
import { logger } from '@/server/logging';
import {
  AllowedMediaTypeSchema,
  MAX_FILE_BYTES,
  type AllowedMediaType,
  type LocalFileStore,
} from '@/server/files/local-file-store';
import {
  PlatformError,
  publicError,
  type PlatformErrorCode,
} from '@/server/errors';
import {
  bugService,
  cookingFileStore,
} from '@/features/cooking/application/server';
import type {
  AssignBugInput,
  BugMutationResult,
  RequestRepairInput,
} from '../contract';

type ActionFailure = {
  ok: false;
  error: { code: PlatformErrorCode; message: string };
};

type UploadedReportAttachments = {
  actualResultAttachmentIds: string[];
  expectedResultAttachmentIds: string[];
};

export type BugActionResult =
  { ok: true; result: BugMutationResult } | ActionFailure;

export async function createBugAction(
  submissionId: string,
  formData: FormData,
): Promise<BugActionResult> {
  const user = await requireCurrentUser();
  return withUploadedFiles(user.id, formData, async (attachmentIds) =>
    bugService().createBug(user.id, submissionId, {
      mutationId: field(formData, 'mutationId'),
      submissionItemId: nullableField(formData, 'submissionItemId'),
      title: field(formData, 'title'),
      operationPath: optionalField(formData, 'operationPath'),
      actualResult: optionalField(formData, 'actualResult'),
      expectedResult: optionalField(formData, 'expectedResult'),
      ...attachmentIds,
    }),
  );
}

export async function updateBugReportAction(
  bugId: string,
  formData: FormData,
): Promise<BugActionResult> {
  const user = await requireCurrentUser();
  const existingActualResultAttachmentIds = stringList(
    formData,
    'existingActualResultAttachmentIds',
  );
  const existingExpectedResultAttachmentIds = stringList(
    formData,
    'existingExpectedResultAttachmentIds',
  );
  const result = await withUploadedFiles(
    user.id,
    formData,
    async (uploadedAttachmentIds) =>
      bugService().updateReport(user.id, bugId, {
        mutationId: field(formData, 'mutationId'),
        expectedVersion: integerField(formData, 'expectedVersion'),
        submissionItemId: nullableField(formData, 'submissionItemId'),
        title: field(formData, 'title'),
        operationPath: optionalField(formData, 'operationPath'),
        actualResult: optionalField(formData, 'actualResult'),
        expectedResult: optionalField(formData, 'expectedResult'),
        actualResultAttachmentIds: [
          ...existingActualResultAttachmentIds,
          ...uploadedAttachmentIds.actualResultAttachmentIds,
        ],
        expectedResultAttachmentIds: [
          ...existingExpectedResultAttachmentIds,
          ...uploadedAttachmentIds.expectedResultAttachmentIds,
        ],
      }),
  );
  if (result.ok)
    await Promise.all(
      result.result.unboundAttachmentIds.map((fileId) =>
        cookingFileStore().deleteUnbound(fileId, user.id),
      ),
    );
  return result;
}

export async function assignBugAction(
  bugId: string,
  input: AssignBugInput,
): Promise<BugActionResult> {
  return simpleBugAction((userId) =>
    bugService().assignBug(userId, bugId, input),
  );
}

export async function requestRepairAction(
  bugId: string,
  input: RequestRepairInput,
): Promise<BugActionResult> {
  return simpleBugAction((userId) =>
    bugService().requestRepair(userId, bugId, input),
  );
}

async function simpleBugAction(
  command: (userId: string) => BugMutationResult,
): Promise<BugActionResult> {
  const user = await requireCurrentUser();
  try {
    const result = command(user.id);
    refreshWorkspace(result.bug.submissionId);
    return { ok: true, result };
  } catch (error) {
    return actionError(error);
  }
}

async function withUploadedFiles(
  userId: string,
  formData: FormData,
  command: (
    attachmentIds: UploadedReportAttachments,
  ) => Promise<BugMutationResult> | BugMutationResult,
): Promise<BugActionResult> {
  const files = {
    actualResultAttachmentIds: uploadedFiles(
      formData,
      'actualResultAttachments',
    ),
    expectedResultAttachmentIds: uploadedFiles(
      formData,
      'expectedResultAttachments',
    ),
  };
  const uploadedIds: string[] = [];
  const uploadedAttachmentIds: UploadedReportAttachments = {
    actualResultAttachmentIds: [],
    expectedResultAttachmentIds: [],
  };
  const store = cookingFileStore();
  try {
    for (const [attachmentKind, groupedFiles] of Object.entries(files) as Array<
      [keyof UploadedReportAttachments, File[]]
    >) {
      if (groupedFiles.length > 5)
        throw new PlatformError(
          'VALIDATION_FAILED',
          '实际结果和预期结果各最多上传 5 个附件',
        );
      for (const file of groupedFiles) {
        if (file.size > MAX_FILE_BYTES)
          throw new PlatformError('FILE_TOO_LARGE', '单个附件不能超过 10 MB');
        const stored = await store.put({
          bytes: new Uint8Array(await file.arrayBuffer()),
          originalName: file.name,
          mediaType: resolveAllowedMediaType(file),
          uploadedByUserId: userId,
        });
        uploadedIds.push(stored.id);
        uploadedAttachmentIds[attachmentKind].push(stored.id);
      }
    }
    const result = await command(uploadedAttachmentIds);
    await cleanupUnboundUploads(
      store,
      userId,
      uploadedIds,
      result.boundAttachmentIds,
    );
    refreshWorkspace(result.bug.submissionId);
    return { ok: true, result };
  } catch (error) {
    await cleanupUnboundUploads(store, userId, uploadedIds, []);
    return actionError(error);
  }
}

function uploadedFiles(formData: FormData, name: string): File[] {
  return formData
    .getAll(name)
    .filter(
      (value): value is File =>
        value instanceof File && value.size > 0 && Boolean(value.name),
    );
}

async function cleanupUnboundUploads(
  store: LocalFileStore,
  userId: string,
  uploadedIds: string[],
  boundIds: string[],
): Promise<void> {
  await Promise.all(
    uploadedIds
      .filter((fileId) => !boundIds.includes(fileId))
      .map((fileId) => store.deleteUnbound(fileId, userId)),
  );
}

function actionError(error: unknown): ActionFailure {
  if (error instanceof ZodError) {
    logger.error('cooking_bug_action_validation_failed', error, {
      issues: error.issues.map(({ code, path }) => ({
        code,
        location: path.join('.'),
      })),
    });
    return {
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: '提交内容不完整或格式不正确，请检查后重试。',
      },
    };
  }
  const visible = publicError(error);
  return {
    ok: false,
    error: { code: visible.code, message: visible.message },
  };
}

function refreshWorkspace(submissionId: string): void {
  revalidatePath('/cooking');
  revalidatePath(`/cooking/${submissionId}`);
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function optionalField(formData: FormData, name: string): string | undefined {
  const value = field(formData, name).trim();
  return value || undefined;
}

function nullableField(formData: FormData, name: string): string | null {
  return optionalField(formData, name) ?? null;
}

function integerField(formData: FormData, name: string): number {
  return Number(field(formData, name));
}

function stringList(formData: FormData, name: string): string[] {
  return formData
    .getAll(name)
    .filter((value): value is string => typeof value === 'string');
}

function resolveAllowedMediaType(file: File): AllowedMediaType {
  const normalizedMediaType = file.type.split(';', 1)[0]?.trim().toLowerCase();
  const parsed = AllowedMediaTypeSchema.safeParse(normalizedMediaType);
  if (parsed.success) return parsed.data;

  // Next's Server Action transport can replace a browser MIME type with
  // application/octet-stream. Only infer from an explicit allowlisted suffix.
  const extension = file.name.toLowerCase().match(/\.[^.]+$/u)?.[0];
  const inferredByExtension: Record<string, AllowedMediaType> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.txt': 'text/plain',
    '.json': 'application/json',
  };
  const inferred = extension ? inferredByExtension[extension] : undefined;
  if (
    inferred &&
    (!normalizedMediaType || normalizedMediaType === 'application/octet-stream')
  )
    return inferred;
  throw new PlatformError('VALIDATION_FAILED', '不支持这种附件格式');
}
