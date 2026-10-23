import { database } from '@/server/database/index';
import { ExecutionService } from '../platform/execution/service';

export function executionService(): ExecutionService {
  return new ExecutionService(database());
}
