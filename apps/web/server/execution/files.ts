import { serverPaths } from '@/server/config';
import { database } from '@/server/database';
import { LocalFileStore } from '@/server/files/local-file-store';

export function executionFileStore(): LocalFileStore {
  return new LocalFileStore(database(), serverPaths().files);
}
