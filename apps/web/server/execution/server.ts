import { database } from '@/server/database';
import { ExecutionService } from './service';

export function executionService(): ExecutionService {
  return new ExecutionService(database());
}
