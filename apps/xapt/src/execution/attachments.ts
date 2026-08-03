import { createHash } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { ClaimedExecution } from '@agent-party-time/execution-contract';
import type { XaptPaths } from '../platform/paths';

export interface ExecutionFileHttp {
  downloadExecutionFile(
    serverOrigin: string,
    credential: string,
    executionId: string,
    fileId: string,
    leaseToken: string,
  ): Promise<Uint8Array>;
}

export type MaterializedAttachment = {
  fileId: string;
  originalName: string;
  path: string;
};

export class AttachmentMaterializer {
  constructor(
    private readonly client: ExecutionFileHttp,
    private readonly paths: XaptPaths,
  ) {}

  async materialize(
    serverOrigin: string,
    credential: string,
    execution: ClaimedExecution,
  ): Promise<MaterializedAttachment[]> {
    const directory = join(
      this.paths.attachmentCache,
      execution.id,
      'attachments',
    );
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const result: MaterializedAttachment[] = [];
    for (const attachment of execution.attachments) {
      const bytes = await this.client.downloadExecutionFile(
        serverOrigin,
        credential,
        execution.id,
        attachment.id,
        execution.lease.token,
      );
      if (
        bytes.byteLength !== attachment.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== attachment.sha256
      )
        throw new Error('附件内容校验失败');
      const path = join(
        directory,
        `${attachment.id}${safeExtension(attachment.originalName)}`,
      );
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      await chmod(path, 0o600);
      result.push({
        fileId: attachment.id,
        originalName: basename(attachment.originalName),
        path,
      });
    }
    return result;
  }

  artifactsDirectory(executionId: string): string {
    return join(this.paths.logs, 'executions', executionId);
  }
}

function safeExtension(originalName: string): string {
  const value = extname(basename(originalName)).toLowerCase();
  return /^[.][a-z0-9]{1,10}$/u.test(value) ? value : '';
}
