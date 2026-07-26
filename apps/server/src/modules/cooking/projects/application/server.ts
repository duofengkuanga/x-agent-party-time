import { database } from '@/platform/database';
import { ProjectService } from './project-service';

export function projectService(): ProjectService {
  return new ProjectService(database());
}
