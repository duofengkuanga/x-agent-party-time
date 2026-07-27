import { database } from '@/platform/database';
import { RunnerService } from './service';

export function runnerService(): RunnerService {
  return new RunnerService(database());
}
