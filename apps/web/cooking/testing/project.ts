import { randomUUID } from 'node:crypto';
import { AuthService } from '@/platform/auth/service';
import type { AppDatabase } from '@/platform/database';
import { RunnerService } from '@/platform/runner/service';
import { BindingService } from '@/cooking/bindings/server/binding-service';
import { EngineeringService } from '@/cooking/engineering/server/engineering-service';
import type { DeploymentMethod } from '@/cooking/engineering/contract';
import { ProjectService } from '@/cooking/projects/server/project-service';
import { SubmissionService } from '@/cooking/submissions/server/submission-service';

export function mutation(expectedVersion: number) {
  return { mutationId: randomUUID(), expectedVersion };
}

export function mutableClock(initial: string) {
  let value = new Date(initial);
  return {
    now: () => new Date(value),
    set: (next: string) => {
      value = new Date(next);
    },
  };
}

/** Shared setup uses public services so every scenario exercises real guards. */
export async function deliveryProject(
  database: AppDatabase,
  options: {
    name: string;
    prefix: string;
    sources: Array<{
      name: string;
      type: 'FRONTEND' | 'BACKEND';
      identifier: string;
      environment: string;
      deployment: DeploymentMethod;
      repository: string;
      branch: string;
    }>;
    title: string;
    description: string;
    now?: () => Date;
  },
) {
  const auth = new AuthService(database);
  const seed = (role: string, displayName: string) =>
    auth.seedUser({
      id: randomUUID(),
      username: `${options.prefix}-${role}`,
      displayName,
      password: 'password',
    });
  const users = {
    owner: await seed('owner', '项目所有者'),
    tester: await seed('tester', '测试负责人'),
    developer: await seed('developer', '工程负责人'),
  };
  const projects = new ProjectService(database);
  const project = projects.createProject(users.owner.id, {
    mutationId: randomUUID(),
    name: options.name,
  }).project;
  for (const member of [users.tester, users.developer]) {
    const invitation = projects.inviteUser(users.owner.id, project.id, {
      mutationId: randomUUID(),
      username: member.username,
    });
    projects.respondToInvitation(member.id, invitation.id, {
      ...mutation(invitation.version),
      decision: 'ACCEPT',
    });
  }
  const engineering = new EngineeringService(database);
  const runners = new RunnerService(database);
  const pairedRunner = runners.pair(
    runners.issuePairingCode(users.developer.id).code,
    `${options.prefix} Runner`,
  );
  const bindings = new BindingService(database);
  const sources = options.sources.map((spec) => {
    const source = engineering.createEngineering(users.owner.id, project.id, {
      mutationId: randomUUID(),
      name: spec.name,
      type: spec.type,
      identifier: spec.identifier,
    });
    engineering.addMember(users.owner.id, source.id, users.developer.id, {
      mutationId: randomUUID(),
    });
    const environment = engineering.createEnvironment(
      users.owner.id,
      source.id,
      {
        mutationId: randomUUID(),
        name: spec.environment,
        deployment: spec.deployment,
      },
    );
    const binding = bindings.createBinding(
      users.developer.id,
      source.id,
      pairedRunner.runner.id,
      randomUUID(),
    );
    bindings.confirmRepository(
      pairedRunner.runner.id,
      binding.id,
      spec.repository,
    );
    return { source, environment, binding, targetBranch: spec.branch };
  });
  const submissions = new SubmissionService(database, options.now);
  const submission = submissions.createSubmission(users.owner.id, project.id, {
    mutationId: randomUUID(),
    title: options.title,
    requirementDescription: options.description,
    testerUserId: users.tester.id,
    items: sources.map(({ source, environment, binding, targetBranch }) => ({
      engineeringId: source.id,
      environmentId: environment.id,
      bindingId: binding.id,
      targetBranch,
      responsibleUserId: users.developer.id,
    })),
  });
  const items = database
    .prepare(
      `
    SELECT id, environment_id FROM cooking_submission_item
    WHERE submission_id = ? ORDER BY position
  `,
    )
    .all(submission.id) as Array<{ id: string; environment_id: string }>;
  return {
    users,
    projects,
    project,
    engineering,
    runners,
    pairedRunner,
    runner: pairedRunner.runner,
    bindings,
    sources,
    submissions,
    submission,
    items,
  };
}
