import { revalidatePath } from 'next/cache';
import { redirect, RedirectType } from 'next/navigation';
import { ZodError } from 'zod';
import { requireCurrentUser } from '@/server/auth/server';
import {
  PlatformError,
  publicError,
  type PlatformErrorCode,
} from '@/server/errors';
import {
  AllowedMediaTypeSchema,
  MAX_FILE_BYTES,
  type AllowedMediaType,
} from '@/server/files/local-file-store';
import { logger } from '@/server/logging';
import { messageRedirectPath } from '@/server/http/message-redirect';
import { cookingFileStore } from '@/features/cooking/application/server';

export type ActionFailure = {
  ok: false;
  error: { code: PlatformErrorCode; message: string };
};

export type InteractiveActionResult<T> =
  { ok: true; result: T } | ActionFailure;

export type InteractiveActionContext = {
  userId: string;
  uploadFiles: (
    formData: FormData,
    name: string,
    options?: { maxFiles?: number; maxFilesMessage?: string },
  ) => Promise<string[]>;
};

export type InteractiveTransportDependencies = {
  currentUser: () => Promise<{ id: string }>;
  fileStore: () => ReturnType<typeof cookingFileStore>;
  refresh: (path: string) => void;
  logValidation: (
    event: string,
    error: ZodError,
    details: { issues: Array<{ code: string; location: string }> },
  ) => void;
};

const DEFAULT_INTERACTIVE_DEPENDENCIES: InteractiveTransportDependencies = {
  currentUser: requireCurrentUser,
  fileStore: cookingFileStore,
  refresh: revalidatePath,
  logValidation: (event, error, details) => logger.error(event, error, details),
};

export async function runInteractiveMutation<T>(
  input: {
    command: (context: InteractiveActionContext) =>
      | Promise<{
          result: T;
          refreshPaths?: string[];
          boundFileIds?: string[];
          cleanupFileIds?: string[];
        }>
      | {
          result: T;
          refreshPaths?: string[];
          boundFileIds?: string[];
          cleanupFileIds?: string[];
        };
    validationEvent: string;
  },
  dependencies: InteractiveTransportDependencies = DEFAULT_INTERACTIVE_DEPENDENCIES,
): Promise<InteractiveActionResult<T>> {
  const user = await dependencies.currentUser();
  const uploadedIds: string[] = [];
  const store = dependencies.fileStore();
  const uploadFiles = async (
    formData: FormData,
    name: string,
    options: { maxFiles?: number; maxFilesMessage?: string } = {},
  ): Promise<string[]> => {
    const files = formFiles(formData, name);
    if (options.maxFiles !== undefined && files.length > options.maxFiles)
      throw new PlatformError(
        'VALIDATION_FAILED',
        options.maxFilesMessage ?? `每组最多上传 ${options.maxFiles} 个附件`,
      );
    const ids: string[] = [];
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES)
        throw new PlatformError('FILE_TOO_LARGE', '单个附件不能超过 10 MB');
      const stored = await store.put({
        bytes: new Uint8Array(await file.arrayBuffer()),
        originalName: file.name,
        mediaType: resolveAllowedMediaType(file),
        uploadedByUserId: user.id,
      });
      uploadedIds.push(stored.id);
      ids.push(stored.id);
    }
    return ids;
  };

  try {
    const success = await input.command({ userId: user.id, uploadFiles });
    const bound = new Set(success.boundFileIds ?? []);
    await cleanupFiles(store, user.id, [
      ...uploadedIds.filter((fileId) => !bound.has(fileId)),
      ...(success.cleanupFileIds ?? []),
    ]);
    for (const path of success.refreshPaths ?? []) dependencies.refresh(path);
    return { ok: true, result: success.result };
  } catch (error) {
    await cleanupFiles(store, user.id, uploadedIds);
    return interactiveActionError(
      error,
      input.validationEvent,
      dependencies.logValidation,
    );
  }
}

export async function runRedirectMutation(
  input: {
    formData: FormData;
    command: (
      userId: string,
    ) =>
      | Promise<{ path: string; message: string; refreshPaths?: string[] }>
      | { path: string; message: string; refreshPaths?: string[] };
    errorPath: (formData: FormData) => string;
    mapError?: (error: unknown) => { message: string };
  },
  dependencies: {
    currentUser: () => Promise<{ id: string }>;
    refresh: (path: string) => void;
    redirect: (path: string, type: typeof RedirectType.replace) => never;
  } = {
    currentUser: requireCurrentUser,
    refresh: revalidatePath,
    redirect: (path, type) => redirect(path, type),
  },
): Promise<never> {
  const user = await dependencies.currentUser();
  let destination: string;
  try {
    const success = await input.command(user.id);
    for (const path of success.refreshPaths ?? []) dependencies.refresh(path);
    destination = messageRedirectPath(success.path, 'success', success.message);
  } catch (error) {
    const visible = input.mapError?.(error) ?? publicError(error);
    destination = messageRedirectPath(
      input.errorPath(input.formData),
      'error',
      visible.message,
    );
  }
  dependencies.redirect(destination, RedirectType.replace);
}

export function formField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

export function requiredFormField(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string')
    throw new PlatformError('VALIDATION_FAILED', '提交内容不完整');
  return value;
}

export function optionalFormField(
  formData: FormData,
  name: string,
): string | undefined {
  const value = formField(formData, name).trim();
  return value || undefined;
}

export function nullableFormField(
  formData: FormData,
  name: string,
): string | null {
  return optionalFormField(formData, name) ?? null;
}

export function integerFormField(formData: FormData, name: string): number {
  const value = Number(requiredFormField(formData, name));
  if (!Number.isInteger(value))
    throw new PlatformError('VALIDATION_FAILED', '提交版本无效');
  return value;
}

export function formStringList(formData: FormData, name: string): string[] {
  return formData
    .getAll(name)
    .filter((value): value is string => typeof value === 'string');
}

function formFiles(formData: FormData, name: string): File[] {
  return formData
    .getAll(name)
    .filter(
      (value): value is File =>
        value instanceof File && value.size > 0 && Boolean(value.name),
    );
}

async function cleanupFiles(
  store: ReturnType<typeof cookingFileStore>,
  userId: string,
  fileIds: string[],
): Promise<void> {
  await Promise.all(
    [...new Set(fileIds)].map((fileId) => store.deleteUnbound(fileId, userId)),
  );
}

function interactiveActionError(
  error: unknown,
  validationEvent: string,
  logValidation: InteractiveTransportDependencies['logValidation'],
): ActionFailure {
  if (error instanceof ZodError) {
    logValidation(validationEvent, error, {
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

function resolveAllowedMediaType(file: File): AllowedMediaType {
  const normalizedMediaType = file.type.split(';', 1)[0]?.trim().toLowerCase();
  const parsed = AllowedMediaTypeSchema.safeParse(normalizedMediaType);
  if (parsed.success) return parsed.data;
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
