import { projectScenario, engineeringScenario } from './scenario';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/platform/database';
import { RunnerService } from '@/platform/runner/service';
import { EngineeringService } from '@/cooking/engineering/server/engineering-service';
import type { DeploymentMethod } from '@/cooking/engineering/contract';
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
  const { users, project } = await projectScenario(database, {
    name: options.name,
    owner: 'owner',
    members: ['tester', 'developer'],
    people: {
      owner: [`${options.prefix}-owner`, '项目所有者', randomUUID()],
      tester: [`${options.prefix}-tester`, '测试负责人', randomUUID()],
      developer: [`${options.prefix}-developer`, '工程负责人', randomUUID()],
    },
  });
  const engineering = new EngineeringService(database);
  const runners = new RunnerService(database);
  const pairedRunner = runners.pair(
    runners.issuePairingCode(users.developer.id).code,
    `${options.prefix} Runner`,
  );
  const sources = options.sources.map((spec) => {
    const { source, environment, bindings } = engineeringScenario(
      database,
      users.owner.id,
      project.id,
      {
        ...spec,
        developers: {
          developer: {
            userId: users.developer.id,
            runnerId: pairedRunner.runner.id,
          },
        },
      },
    );
    return {
      source,
      environment,
      binding: bindings.developer,
      targetBranch: spec.branch,
    };
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
  const items = database.all<{ id: string; environment_id: string }>(
    `
    SELECT id, environment_id FROM cooking_submission_item
    WHERE submission_id = ? ORDER BY position
  `,
    submission.id,
  );
  return {
    users,
    project,
    engineering,
    runners,
    pairedRunner,
    runner: pairedRunner.runner,
    sources,
    submissions,
    submission,
    items,
  };
}
