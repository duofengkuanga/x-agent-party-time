import { z } from 'zod';
import {
  DeploymentReceiptSchema,
  EnvironmentKeySchema,
  type ExecutionWorkspaceMember,
  type JsonObject,
} from '@agent-party-time/execution-contract';
import { CommitShaSchema } from '@/contracts/submissions/repair';
import {
  UpdateExecutionResultSchema,
  type FrozenRepairHandoff,
} from '@/contracts/submissions/update';
import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';
import { personAgentRepairResultSchema } from '../repair/personAgentScope';
import type { CandidateRow } from './updateQueries';

const scopeSchema = z
  .array(
    z.strictObject({
      alias: z.string(),
      itemId: z.uuid(),
      bindingId: z.uuid(),
      engineeringId: z.uuid(),
      repositoryUrl: z.string(),
      environmentKey: EnvironmentKeySchema,
      candidateCommits: z.array(CommitShaSchema),
      candidatePositions: z.array(z.number().int().nonnegative()),
      targetBranch: z.string(),
      environmentId: z.uuid(),
      changed: z.boolean(),
    }),
  )
  .min(1)
  .max(20);

export type PersonAgentUpdateScope = z.infer<typeof scopeSchema>;

export function readPersonAgentUpdateScope(value: string): PersonAgentUpdateScope {
  return scopeSchema.parse(JSON.parse(value));
}

export function personAgentUpdateResultSchema(
  scope: PersonAgentUpdateScope,
  requireReceipt = false,
) {
  const [completed, failed] = UpdateExecutionResultSchema.shape.result.options;
  const receiptFields = requireReceipt
    ? { receipt: DeploymentReceiptSchema.optional() }
    : {};
  const completedMembers = Object.fromEntries(
    scope.map(({ alias, changed }) => [
      alias,
      changed
        ? z.strictObject({
            state: z.literal('DEPLOYED'),
            commit: CommitShaSchema,
            pushVerified: z.literal(true),
            deploymentVerified: z.literal(true),
            ...receiptFields,
          })
        : z.strictObject({ state: z.literal('UNCHANGED') }),
    ]),
  );
  const progressMembers = Object.fromEntries(
    scope.map(({ alias }) => [
      alias,
      z.strictObject({
        state: z.enum([
          'NOT_STARTED',
          'VALIDATED',
          'PUSHED',
          'DEPLOYED',
          'UNKNOWN',
          'FAILED',
          'UNCHANGED',
        ]),
        commit: CommitShaSchema.nullable(),
        evidence: z.string().trim().max(300),
        ...receiptFields,
      }),
    ]),
  );
  return z
    .strictObject({
      result: z.union([
        completed.safeExtend({ deliveries: z.strictObject(completedMembers) }),
        failed.safeExtend({ deliveries: z.strictObject(progressMembers) }),
      ]),
    })
    .superRefine(({ result }, context) => {
      if (result.outcome === 'COMPLETED') {
        const expected = scope.flatMap(({ alias, candidatePositions }) =>
          candidatePositions.map((position) => `${alias}:${position}`),
        );
        const actual = result.testingScopes.map(
          ({ engineeringAlias, candidatePosition }) =>
            `${engineeringAlias}:${candidatePosition}`,
        );
        if (
          actual.length !== expected.length ||
          new Set(actual).size !== actual.length ||
          expected.some((key) => !actual.includes(key))
        )
          context.addIssue({
            code: 'custom',
            path: ['result', 'testingScopes'],
            message: '测试范围必须完整对应冻结的工程与缺陷，且不得重复',
          });
        result.testingScopes.forEach((entry, index) => {
          const delivery = result.deliveries[entry.engineeringAlias];
          if (
            !delivery ||
            delivery.state !== 'DEPLOYED' ||
            delivery.commit !== entry.testingScope.review.headCommit
          )
            context.addIssue({
              code: 'custom',
              path: ['result', 'testingScopes', index],
              message: '测试范围必须对应本工程实际交付版本',
            });
        });
      }
      if (
        result.outcome === 'COMPLETED' &&
        (!result.validations.some(({ status }) => status === 'PASSED') ||
          result.validations.some(({ status }) => status === 'FAILED'))
      )
        context.addIssue({
          code: 'custom',
          path: ['result', 'validations'],
          message: '整批交付必须完成必需验证',
        });
      if (!requireReceipt) return;
      for (const { alias, environmentKey } of scope) {
        const delivery = result.deliveries[alias];
        if (!delivery || delivery.state !== 'DEPLOYED') continue;
        const receipt =
          'receipt' in delivery
            ? DeploymentReceiptSchema.safeParse(delivery.receipt)
            : null;
        if (
          !receipt?.success ||
          receipt.data.commit !== delivery.commit ||
          receipt.data.environmentKey !== environmentKey
        )
          context.addIssue({
            code: 'custom',
            path: ['result', 'deliveries', alias],
            message: '工程缺少匹配的本机部署验收回执',
          });
      }
    });
}

type ScopeRow = {
  id: string;
  binding_id: string;
  engineering_id: string;
  engineering_name: string;
  engineering_type: 'FRONTEND' | 'BACKEND';
  repository_url: string;
  target_branch: string;
  environment_id: string;
  environment_name: string;
  environment_key: string;
};

export function freezePersonAgentUpdate(
  db: AppDatabase,
  submissionId: string,
  batchId: string,
  candidates: CandidateRow[],
) {
  const rows = db.all<ScopeRow>(
    `SELECT item.id, item.binding_id, item.engineering_id, engineering.name engineering_name,
      item.engineering_type, item.repository_url, item.target_branch, item.environment_id,
      item.environment_name, item.environment_key
     FROM submission_item item
     JOIN platform_engineering engineering ON engineering.id = item.engineering_id
     WHERE item.submission_id = ? ORDER BY item.position`,
    submissionId,
  );
  const handoffs = new Map<
    string,
    Array<{ bindingId: string; handoff: FrozenRepairHandoff }>
  >();
  for (const candidate of candidates) {
    const attempt = db.get<{
      id: string;
      execution_id: string;
      outcome_json: string;
      workspace_json: string;
    }>(
      `SELECT attempt.id, attempt.execution_id, attempt.outcome_json, execution.workspace_json
       FROM submission_repair_attempt attempt
       JOIN platform_execution execution ON execution.id = attempt.execution_id
       WHERE attempt.bug_id = ? AND json_extract(attempt.outcome_json, '$.outcome') = 'COMPLETED'
       ORDER BY attempt.attempt DESC LIMIT 1`,
      candidate.bug_id,
    );
    if (!attempt)
      throw new PlatformError('INVALID_TRANSITION', '缺少已完成的多工程修复记录');
    const workspaces = JSON.parse(attempt.workspace_json) as ExecutionWorkspaceMember[];
    const result = personAgentRepairResultSchema(workspaces.length).parse({
      result: JSON.parse(attempt.outcome_json),
    }).result;
    if (result.outcome !== 'COMPLETED')
      throw new PlatformError('INVALID_TRANSITION', '多工程修复结果无法用于更新');
    const scoped: Array<{ bindingId: string; handoff: FrozenRepairHandoff }> =
      workspaces.flatMap(({ bindingId }, index) => {
        const repository = result.repositories[`repo-${index + 1}`]!;
        if (repository.completionKind !== 'CHANGES_COMMITTED') return [];
        if (!rows.some(({ binding_id }) => binding_id === bindingId))
          throw new PlatformError('INVALID_TRANSITION', '修复候选引用了提测范围外的工程');
        return [
          {
            bindingId,
            handoff: {
              attemptId: attempt.id,
              executionId: attempt.execution_id,
              commits: repository.commits,
              changes: repository.changes,
              validations: repository.validations,
              warnings: repository.warnings,
              handoff: repository.handoff,
              testingScope: repository.testingScope,
              unchangedTestingScopes: [],
            },
          },
        ];
      });
    if (!scoped.length)
      throw new PlatformError('INVALID_TRANSITION', '没有可冻结的多工程候选');
    scoped[0]!.handoff.unchangedTestingScopes = workspaces.flatMap(
      ({ bindingId }, index) => {
        const repository = result.repositories[`repo-${index + 1}`]!;
        if (repository.completionKind !== 'TARGET_ALREADY_FIXED') return [];
        const engineeringIndex = rows.findIndex(
          ({ binding_id }) => binding_id === bindingId,
        );
        if (engineeringIndex < 0)
          throw new PlatformError('INVALID_TRANSITION', '验收范围引用了提测范围外的工程');
        return [
          {
            engineeringAlias: `repo-${engineeringIndex + 1}`,
            testingScope: repository.testingScope,
          },
        ];
      },
    );
    handoffs.set(candidate.bug_id, scoped);
  }
  const workspaces: ExecutionWorkspaceMember[] = rows.map((item, index) => ({
    bindingId: item.binding_id,
    workspace: {
      key: index === 0 ? `update-batch:${batchId}` : `update-batch:${batchId}:${item.id}`,
      isolation: 'DETACHED_WORKTREE',
      baseRef: `origin/${item.target_branch}`,
    },
  }));
  const scope: PersonAgentUpdateScope = [];
  const engineeringDeliveries: JsonObject[] = rows.map((item, index) => {
    const alias = `repo-${index + 1}`;
    const frozenCandidates = candidates.flatMap((candidate, position) =>
      handoffs
        .get(candidate.bug_id)!
        .filter(({ bindingId }) => bindingId === item.binding_id)
        .map(
          ({
            handoff: { attemptId: _attempt, executionId: _execution, ...handoff },
          }) => ({
            position,
            bugTitle: candidate.title,
            commits: handoff.commits,
            repairHandoffs: [handoff],
          }),
        ),
    );
    scope.push({
      alias,
      itemId: item.id,
      bindingId: item.binding_id,
      engineeringId: item.engineering_id,
      repositoryUrl: item.repository_url,
      environmentKey: item.environment_key,
      candidateCommits: frozenCandidates.flatMap(({ commits }) => commits),
      candidatePositions: frozenCandidates.map(({ position }) => position),
      targetBranch: item.target_branch,
      environmentId: item.environment_id,
      changed: frozenCandidates.length > 0,
    });
    return {
      alias,
      name: item.engineering_name,
      type: item.engineering_type,
      targetBranch: item.target_branch,
      environment: item.environment_name,
      environmentKey: item.environment_key,
      frozenCandidates,
    };
  });
  const deploymentOrder = scope
    .filter(({ changed }) => changed)
    .sort((a, b) => {
      const first = rows.find(({ id }) => id === a.itemId)!;
      const second = rows.find(({ id }) => id === b.itemId)!;
      return first.engineering_type.localeCompare(second.engineering_type);
    })
    .map(({ alias }) => alias);
  return {
    scope,
    workspaces,
    brief: { engineeringDeliveries, deploymentOrder },
    entries: candidates.map((candidate) => {
      const repairHandoffs = handoffs
        .get(candidate.bug_id)!
        .map(({ handoff }) => handoff);
      return {
        bugTitle: candidate.title,
        commits: repairHandoffs.flatMap(({ commits }) => commits),
        repairHandoffs,
      };
    }),
  };
}
