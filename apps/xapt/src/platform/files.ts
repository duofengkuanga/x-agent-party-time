import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  lstat,
} from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LocalFileInfo {
  mode: number;
  size: number;
  type: 'file' | 'directory' | 'socket' | 'symbolic-link' | 'other';
}

export interface LocalFileSystem {
  ensureDirectory(path: string, mode: number): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  writeAtomic(
    path: string,
    value: string | Uint8Array,
    mode: number,
    parentMode?: number,
  ): Promise<void>;
  list(path: string): Promise<string[]>;
  info(path: string): Promise<LocalFileInfo | null>;
  setMode(path: string, mode: number): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface AtomicWriteHooks {
  beforeRename?(temporaryPath: string, destinationPath: string): Promise<void>;
}

export class NodeLocalFileSystem implements LocalFileSystem {
  constructor(private readonly hooks: AtomicWriteHooks = {}) {}

  async ensureDirectory(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode });
    await chmod(path, mode);
    const info = await this.info(path);
    if (!info || info.type !== 'directory' || info.mode !== mode)
      throw new Error('无法建立权限受控目录');
  }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeAtomic(
    path: string,
    value: string | Uint8Array,
    mode: number,
    parentMode = 0o700,
  ): Promise<void> {
    const directory = dirname(path);
    await this.ensureDirectory(directory, parentMode);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, 'wx', mode);
      await handle.writeFile(value);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.hooks.beforeRename?.(temporaryPath, path);
      await rename(temporaryPath, path);
      await chmod(path, mode);
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (handle)
        try {
          await handle.close();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      try {
        await rm(temporaryPath, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0)
        throw new AggregateError(
          [error, ...cleanupErrors],
          '原子写入失败，且临时文件清理不完整',
        );
      throw error;
    }
  }

  async list(path: string): Promise<string[]> {
    try {
      return (await readdir(path)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async info(path: string): Promise<LocalFileInfo | null> {
    try {
      const value = await lstat(path);
      return {
        mode: value.mode & 0o777,
        size: value.size,
        type: value.isFile()
          ? 'file'
          : value.isDirectory()
            ? 'directory'
            : value.isSocket()
              ? 'socket'
              : value.isSymbolicLink()
                ? 'symbolic-link'
                : 'other',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async setMode(path: string, mode: number): Promise<void> {
    await chmod(path, mode);
  }

  async remove(
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<void> {
    await rm(path, { recursive: options.recursive, force: true });
  }
}
