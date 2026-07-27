import { database } from '@/platform/database';
import { ExecutionService } from './service';

export function executionService(): ExecutionService {
  return new ExecutionService(database());
}
