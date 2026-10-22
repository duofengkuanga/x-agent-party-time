import { ProjectService } from '@/cooking/projects/server/projectService';
import { EngineeringService } from '@/cooking/engineering/server/engineeringService';
import { BindingService } from '@/cooking/engineering/server/bindingService';
import type { AppDatabase } from '@/platform/database';
import { SubmissionCreationCatalogSchema } from '../contract';
import { environmentConflict } from './environmentAccess';

export function readSubmissionCreationCatalog(db: AppDatabase, userId: string) {
  const projects = new ProjectService(db);
  const engineering = new EngineeringService(db);
  const bindings = new BindingService(db);
  return SubmissionCreationCatalogSchema.parse(
    projects.listProjects(userId).map(({ project }) => ({
      projectId: project.id,
      projectName: project.name,
      members: projects.listMembers(userId, project.id).map(({ user }) => user),
      engineerings: engineering
        .listEngineering(userId, project.id)
        .filter((item) => !item.archivedAt && item.repositoryState === 'CONFIRMED')
        .map((item) => {
          const workspace = engineering.getWorkspace(userId, item.id);
          const recent = db.get<{ target_branch: string; title: string }>(
            `SELECT item.target_branch, submission.title
               FROM cooking_submission_item item
               JOIN cooking_test_submission submission ON submission.id = item.submission_id
               WHERE item.engineering_id = ?
               ORDER BY submission.updated_at DESC, item.created_at DESC, item.rowid DESC
               LIMIT 1`,
            item.id,
          );
          return {
            id: item.id,
            name: item.name,
            type: item.type,
            identifier: item.identifier,
            targetBranchSuggestion: recent
              ? { value: recent.target_branch, submissionTitle: recent.title }
              : null,
            members: workspace.members.map(({ user }) => user),
            environments: workspace.environments.map(({ id, name }) => ({
              id,
              name,
              conflict: environmentConflict(db, userId, id),
            })),
            bindings: bindings
              .listBindings(userId, item.id)
              .filter(({ runner }) => !runner.revokedAt)
              .map(({ binding, runner }) => ({
                id: binding.id,
                userId: binding.userId,
                runnerName: runner.name,
              })),
          };
        }),
    })),
  );
}
