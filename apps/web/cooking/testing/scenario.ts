import { randomUUID } from 'node:crypto';
import type { User } from '@/platform/auth/contract';
import { AuthService } from '@/platform/auth/service';
import type { AppDatabase } from '@/platform/database';
import { BindingService } from '@/cooking/bindings/server/binding-service';
import { EngineeringService } from '@/cooking/engineering/server/engineering-service';
import type { DeploymentMethod } from '@/cooking/engineering/contract';
import { ProjectService } from '@/cooking/projects/server/project-service';

/** Creates a real private project; unlisted users remain outside its membership. */
export async function projectScenario<K extends string>(
  database: AppDatabase,
  spec: {
    name: string;
    people: Record<K, [username: string, displayName: string, id?: string]>;
    owner: K;
    members: K[];
    authNow?: () => Date;
  },
) {
  const auth = new AuthService(database, spec.authNow);
  const users = {} as Record<K, User>;
  for (const key of Object.keys(spec.people) as K[]) {
    const [username, displayName, id = username] = spec.people[key];
    users[key] = await auth.seedUser({
      id,
      username,
      displayName,
      password: 'password',
    });
  }
  const ownerId = users[spec.owner].id;
  const projects = new ProjectService(database);
  const project = projects.createProject(ownerId, {
    mutationId: randomUUID(),
    name: spec.name,
  }).project;
  for (const key of spec.members) {
    const invitation = projects.inviteUser(ownerId, project.id, {
      mutationId: randomUUID(),
      username: users[key].username,
    });
    projects.respondToInvitation(users[key].id, invitation.id, {
      mutationId: randomUUID(),
      expectedVersion: invitation.version,
      decision: 'ACCEPT',
    });
  }
  return { users, projects, project };
}

/** Engineering, environment and developer bindings created through their real guards. */
export function engineeringScenario<K extends string>(
  database: AppDatabase,
  ownerId: string,
  projectId: string,
  spec: {
    name: string;
    type: 'FRONTEND' | 'BACKEND';
    identifier: string;
    environment: string;
    deployment: DeploymentMethod;
    repository: string | null;
    developers: Record<K, { userId: string; runnerId: string }>;
  },
) {
  const engineering = new EngineeringService(database);
  const bindings = new BindingService(database);
  const source = engineering.createEngineering(ownerId, projectId, {
    mutationId: randomUUID(),
    name: spec.name,
    type: spec.type,
    identifier: spec.identifier,
  });
  const members = Object.keys(spec.developers) as K[];
  for (const key of members) {
    engineering.addMember(ownerId, source.id, spec.developers[key].userId, {
      mutationId: randomUUID(),
    });
  }
  const environment = engineering.createEnvironment(ownerId, source.id, {
    mutationId: randomUUID(),
    name: spec.environment,
    deployment: spec.deployment,
  });
  const values = {} as Record<K, ReturnType<BindingService['createBinding']>>;
  for (const key of members) {
    const developer = spec.developers[key];
    const binding = bindings.createBinding(
      developer.userId,
      source.id,
      developer.runnerId,
      randomUUID(),
    );
    if (spec.repository !== null)
      bindings.confirmRepository(
        developer.runnerId,
        binding.id,
        spec.repository,
      );
    values[key] = binding;
  }
  return { source, environment, bindings: values };
}
