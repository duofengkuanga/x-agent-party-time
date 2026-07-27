import { serverPaths } from '@/platform/config';
import { database } from '@/platform/database';
import { LocalFileStore } from '@/platform/files/local-file-store';

export function executionFileStore(): LocalFileStore {
  return new LocalFileStore(database(), serverPaths().files);
}
