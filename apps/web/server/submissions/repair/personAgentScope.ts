import { createHash } from 'node:crypto';
import type { ExecutionWorkspaceMember } from '@agent-party-time/execution-contract';
import { z } from 'zod';
import type {
  Execution,
  ExecutionResultAssertion,
  JsonObject,
} from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/server/database/index';
import type { ExecutionClaimPlan } from '@/server/platform/execution/queue';
import {
  createContinuationCodexTurn,
  createInitialCodexTurn,
} from '@/server/platform/execution/codexTurn';
import { outputJsonSchema } from '@/contracts/outputSchema';
import { RepairExecutionResultSchema } from '@/contracts/submissions/repair';
import { REPAIR_HANDOFF_TEXT_ASSERTION } from '@/contracts/submissions/handoff';

const [committed, noChange, failed] = RepairExecutionResultSchema.shape.result.options;
const completedRepository = z.union([committed, noChange]);

export function personAgentRepairResultSchema(size: number) {
  const members: Record<string, typeof completedRepository> = Object.fromEntries(
    Array.from({ length: size }, (_, index) => [
      `repo-${index + 1}`,
      completedRepository,
    ]),
  );
  return z.strictObject({
    result: z.union([
      z.strictObject({
        outcome: z.literal('COMPLETED'),
        repositories: z.strictObject(members),
      }),
      failed,
    ]),
  });
}

type ScopeItem = {
  id: string;
  binding_id: string;
  engineering_id: string;
  engineering_name: string;
  engineering_type: 'FRONTEND' | 'BACKEND';
  target_branch: string;
  runner_id: string | null;
  user_id: string | null;
};

export function resolvePersonAgentRepair(
  db: AppDatabase,
  execution: Execution,
  now: () => Date,
): ExecutionClaimPlan | false | undefined {
  if (execution.claimedAt !== null) return undefined;
  if (
    execution.owner.namespace !== 'submissions' ||
    execution.owner.kind !== 'BUG_REPAIR'
  )
    return undefined;
  const scope = db.get<{
    bug_id: string;
    submission_id: string;
    status: string;
    mode: string;
    person_agent_developer_id: string;
    person_agent_runner_id: string;
    workspace_key: string;
  }>(
    `SELECT bug.id bug_id, submission.id submission_id, submission.status, submission.mode,
      submission.person_agent_developer_id, submission.person_agent_runner_id,
      context.workspace_key
      FROM submission_repair_attempt attempt
      JOIN submission_bug bug ON bug.id = attempt.bug_id
      JOIN submission_bug_repair_context context ON context.bug_id = bug.id
      JOIN test_submission submission ON submission.id = bug.submission_id
      WHERE attempt.id = ?`,
    execution.owner.id,
  );
  if (!scope || scope.mode !== 'PERSON_AGENT') return undefined;
  if (scope.status !== 'ACTIVE' || scope.person_agent_runner_id !== execution.runnerId)
    return false;
  const items = db.all<ScopeItem>(
    `SELECT item.id, item.binding_id, item.engineering_id, item.engineering_name,
      item.engineering_type, item.target_branch, binding.user_id, runner.id runner_id
      FROM submission_item item
      LEFT JOIN platform_engineering_binding binding ON binding.id = item.binding_id
      LEFT JOIN platform_runner runner ON runner.id = binding.runner_id AND runner.revoked_at IS NULL
      WHERE item.submission_id = ? ORDER BY item.position`,
    scope.submission_id,
  );
  if (
    !items.length ||
    items[0]!.binding_id !== execution.bindingId ||
    items.some(
      (item) =>
        item.runner_id !== execution.runnerId ||
        item.user_id !== scope.person_agent_developer_id,
    )
  )
    return false;
  const turn = execution.codexTurn;
  if (!turn || turn.kind === 'READ_SESSION') return false;
  const previous = execution.previousExecutionId
    ? db.get<{
        workspace_json: string;
        outcome_json: string | null;
      }>(
        `SELECT execution.workspace_json, attempt.outcome_json
      FROM platform_execution execution
      JOIN submission_repair_attempt attempt ON attempt.execution_id = execution.id
      WHERE execution.id = ?`,
        execution.previousExecutionId,
      )
    : null;
  if (
    turn.kind === 'INITIAL' &&
    previous &&
    turn.requiredSkillProtocol === 'person-agent-repair-v1'
  )
    return undefined;
  const previousWorkspaces = previous
    ? (JSON.parse(previous.workspace_json) as ExecutionWorkspaceMember[])
    : [];
  const rotates =
    previousWorkspaces[0]?.workspace?.key !== scope.workspace_key &&
    previousWorkspaces.length > 0;
  const previousResult =
    rotates && previous?.outcome_json
      ? personAgentRepairResultSchema(previousWorkspaces.length).safeParse({
          result: JSON.parse(previous.outcome_json),
        })
      : null;
  if (
    rotates &&
    (!previousResult?.success || previousResult.data.result.outcome !== 'COMPLETED')
  )
    return false;
  const workspaces = items.map((item, index): ExecutionWorkspaceMember => {
    const key = index === 0 ? scope.workspace_key : `${scope.workspace_key}:${item.id}`;
    const priorIndex = previousWorkspaces.findIndex(
      ({ bindingId }) => bindingId === item.binding_id,
    );
    const priorWorkspace = previousWorkspaces[priorIndex]?.workspace;
    const prior =
      previousResult?.success && previousResult.data.result.outcome === 'COMPLETED'
        ? previousResult.data.result.repositories[`repo-${priorIndex + 1}`]
        : undefined;
    return {
      bindingId: item.binding_id,
      workspace: {
        key,
        isolation: 'BRANCH_WORKTREE',
        baseRef: `origin/${item.target_branch}`,
        branch: `apt/repair/${scope.bug_id}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
        ...(rotates && priorWorkspace && prior
          ? {
              rotateFrom: { key: priorWorkspace.key, head: prior.commits.at(-1) ?? null },
            }
          : {}),
      },
    };
  });
  const engineeringWorkspaces: JsonObject[] = items.map((item, index) => ({
    alias: `repo-${index + 1}`,
    name: item.engineering_name,
    type: item.engineering_type,
    targetBranch: item.target_branch,
  }));
  const resultAssertions: ExecutionResultAssertion[] = items.flatMap((item, index) => {
    const resultPath = ['result', 'repositories', `repo-${index + 1}`];
    return [
      { ...REPAIR_HANDOFF_TEXT_ASSERTION, resultPath: [...resultPath, 'handoff'] },
      {
        kind: 'GIT_COMMITS_CREATED',
        workspaceBindingId: item.binding_id,
        resultPath: [...resultPath, 'commits'],
      },
    ];
  });
  const output = outputJsonSchema(personAgentRepairResultSchema(items.length));
  const codexTurn =
    turn.kind === 'INITIAL'
      ? createInitialCodexTurn({
          requiredSkillName: turn.requiredSkillName,
          requiredSkillProtocol: 'person-agent-repair-v1',
          manualHandoff: turn.manualHandoff,
          executionBrief: {
            ...turn.executionBrief,
            targetBranch: items[0]!.target_branch,
            engineeringWorkspaces,
          },
          outputJsonSchema: output,
          resultAssertions,
        })
      : createContinuationCodexTurn({
          taskId: turn.taskId,
          taskSkillBinding: turn.taskSkillBinding,
          manualHandoff: turn.manualHandoff,
          text: `${turn.input}\n本轮工程范围：${JSON.stringify(engineeringWorkspaces)}`,
          outputJsonSchema: output,
          resultAssertions,
        });
  return {
    workspaces,
    codexTurn,
    claimed: () => {
      db.run(
        `UPDATE submission_item SET target_branch_locked_at = COALESCE(target_branch_locked_at, ?)
          WHERE submission_id = ? AND id IN (SELECT value FROM json_each(?))`,
        [
          now().toISOString(),
          scope.submission_id,
          JSON.stringify(items.map(({ id }) => id)),
        ],
      );
    },
  };
}

export function isPersonAgentBug(db: AppDatabase, bugId: string): boolean {
  return Boolean(
    db.get(
      `SELECT 1 FROM submission_bug bug JOIN test_submission submission ON submission.id = bug.submission_id
     WHERE bug.id = ? AND submission.mode = 'PERSON_AGENT'`,
      bugId,
    ),
  );
}
