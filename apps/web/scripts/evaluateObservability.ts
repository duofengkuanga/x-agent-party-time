import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from '@/platform/database';
import { deliveryProject } from '@/cooking/testing/project';
import { createCooking } from '@/cooking/runtime/createCooking';
import { cookingRunnerFetch } from '@/cooking/runtime/runnerHttp';
import { cookingObservationAccess } from '@/cooking/runtime/observationAccess';
import { handleObservationRead } from '@/platform/execution/observationHttp';
import { ExecutionObservations } from '@/platform/execution/observations';
import { LocalFileStore } from '@/platform/files/localFileStore';
import { RepairExecutionResultSchema } from '@/cooking/repair/contract';
import { LocalScriptUpdateExecutionResultSchema } from '@/cooking/update/contract';
import type { ClaimedExecution, JsonValue } from '@agent-party-time/execution-contract';
import { type ObservationReport } from '@agent-party-time/execution-contract/observability';
import { CodexAppServerExecutor } from '../../xapt/src/codex/appServer';
import { NodeLocalFileSystem } from '../../xapt/src/platform/files';
import { xaptPaths } from '../../xapt/src/platform/paths';
import { LocalStateStore } from '../../xapt/src/state/store';
import { bundleHash } from '../../xapt/src/skills/manager';
import { ObservationService } from '../../xapt/src/observability/service';
import { ObservationHttpClient } from '../../xapt/src/observability/transport';
import { protocolObserver } from '../../xapt/src/observability/protocol';
import { createCommandClassifier } from '../../xapt/src/observability/commandContext';
import { verifyResultContent } from '../../xapt/src/execution/resultVerification';
import {
  prepareBuildCase,
  fixtureGit,
  caseTrace,
} from '../../../scripts/observability/fixture';

const { values } = parseArgs({
  options: {
    'skills-root': { type: 'string' },
    codex: { type: 'string', default: 'codex' },
    runs: { type: 'string', default: '2' },
  },
});
if (!values['skills-root'] || !['1', '2'].includes(values.runs!))
  throw new Error(
    '需要 --skills-root；--runs 只允许 1（pilot）或 2（每变体两次功能回归）',
  );
const skillsRoot = resolve(values['skills-root']);
const scratch = resolve(import.meta.dir, '../../../.scratch');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'observability-live-'));
const codexVersion = execFileSync(values.codex!, ['--version'], { encoding: 'utf8' })
  .trim()
  .split(/\s/u)
  .at(-1)!;
const runs = Number(values.runs);
const preregistration = {
  purpose: '功能及诊断验证，不能用于性能收益验收',
  runsPerVariant: runs,
  maximumLiveTurns: runs * 4,
  turnTimeoutMs: 300_000,
  ordering:
    runs === 2
      ? ['baseline', 'optimized', 'optimized', 'baseline']
      : ['baseline', 'optimized'],
  performanceSample: false,
  realTargets: false,
  installationConfiguration: '继承当前 Codex；只记录协议实际返回的模型和档位',
  codexVersion,
};
await writeFile(
  join(root, 'preregistration.json'),
  JSON.stringify(preregistration, null, 2),
);
console.log(`隔离验证目录：${root}`);
const results: Array<Record<string, unknown>> = [];
for (const [index, variant] of preregistration.ordering.entries()) {
  const directory = join(root, `${index + 1}-${variant}`);
  const fixture = await prepareBuildCase(directory, variant as 'baseline' | 'optimized');
  const db = openDatabase(join(directory, 'server.sqlite'));
  try {
    const project = await deliveryProject(db, {
      name: '归因隔离验证',
      prefix: `obs${index}`,
      title: '重复构建功能回归',
      description: '本地假远端和假部署目标',
      sources: [
        {
          name: '加法工程',
          type: 'BACKEND',
          identifier: 'addition',
          environment: 'isolated',
          deployment: { kind: 'LOCAL_SCRIPT', command: 'bun tools/delivery.ts deploy' },
          repository: 'https://example.invalid/isolated.git',
          branch: 'main',
        },
      ],
    });
    const cooking = createCooking(db);
    const paths = xaptPaths(join(directory, 'local-home'));
    const files = new NodeLocalFileSystem();
    const state = new LocalStateStore(paths, files);
    await state.initialize();
    const session = {
      serverOrigin: 'https://observation.example',
      credential: project.pairedRunner.credential,
    };
    await state.saveConnection({
      schemaVersion: 1,
      serverUrl: session.serverOrigin,
      runnerId: project.runner.id,
    });
    const route = cookingRunnerFetch(db, {
      runners: project.runners,
      executions: cooking.executions,
      files: new LocalFileStore(db, join(directory, 'files')),
      prepare: () => {},
    });
    const service = new ObservationService(
      join(paths.state, 'observations'),
      files,
      state,
      new ObservationHttpClient(route as typeof fetch),
      () => new Date(),
      codexVersion,
    );
    const reports = new ExecutionObservations(db, cookingObservationAccess(db));
    const executor = new CodexAppServerExecutor(values.codex);
    const bug = cooking.bugs.createBug(project.users.tester.id, project.submission.id, {
      mutationId: randomUUID(),
      submissionItemId: project.items[0]!.id,
      title: '整数加法结果偏大',
      actualResult: 'add(2,3) 返回6',
      expectedResult: '返回5，负数相加也正确',
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
    }).bug;
    cooking.bugs.requestRepair(project.users.tester.id, bug.id, {
      mutationId: randomUUID(),
      expectedVersion: bug.version,
    });
    const repair = (await cooking.executions.claim(project.runner.id, 1, 0))[0]!;
    const repairWorktree = join(directory, 'repair');
    fixtureGit(
      fixture.source,
      'worktree',
      'add',
      '-b',
      'repair',
      repairWorktree,
      fixture.base,
    );
    const run = async (
      claimed: ClaimedExecution,
      worktree: string,
      label: string,
    ): Promise<{ outcome: JsonValue; report: ObservationReport }> => {
      const observation = service.receive(session, claimed);
      const turn = claimed.codexTurn!;
      if (turn.kind !== 'INITIAL') throw new Error('隔离新任务必须为初始调用');
      const name = turn.requiredSkillName;
      const target = join(worktree, '.agents/skills', name);
      const skillFiles = await observation.phase('skill', async () => {
        await mkdir(join(target, 'agents'), { recursive: true });
        return Promise.all(
          ['SKILL.md', 'agents/openai.yaml'].map(async (path) => {
            const bytes = await readFile(join(skillsRoot, 'skills', name, path));
            await writeFile(join(target, path), bytes);
            return { path, bytes };
          }),
        );
      });
      const hash = bundleHash(skillFiles);
      observation.record({
        name: 'configuration.observed',
        source: 'xapt',
        configuration: { bundleHash: hash },
      });
      const classifier = createCommandClassifier(worktree);
      await classifier.ready;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), preregistration.turnTimeoutMs);
      const renewing = setInterval(() => {
        try {
          cooking.executions.renew(project.runner.id, claimed.id, claimed.lease.token);
        } catch {
          controller.abort();
        }
      }, 10_000);
      console.log(`${index + 1}/${variant}/${label}：真实 App Server 开始`);
      try {
        const started = await executor.begin(
          {
            executionId: claimed.id,
            repositoryPath: worktree,
            text: `Use $${name} to complete this isolated Execution. This prepared worktree and its local origin are disposable. Ordinary local commits and pushes required by the Skill are authorized. No network remote, real deployment, rule/script/test changes or package installation. Follow the supplied Schema.\nExecution Brief:\n${JSON.stringify(turn.executionBrief)}`,
            approvalPolicy: 'never',
            taskId: null,
            skill: { name, path: join(target, 'SKILL.md') },
            attachments: [],
            outputSchema: turn.outputJsonSchema,
            onInteraction: async () => {
              throw new Error('隔离功能验证不接受交互');
            },
            observe: protocolObserver(observation, classifier),
          },
          controller.signal,
        );
        cooking.executions.start(project.runner.id, claimed.id, {
          kind: 'STARTED',
          leaseToken: claimed.lease.token,
          sessionId: started.sessionId,
          taskSkillBinding: {
            skillName: name,
            bundleHash: hash,
            sourceRevision: fixtureGit(skillsRoot, 'rev-parse', 'HEAD'),
          },
        });
        const outcome = await started.completion;
        await observation.phase('validation', async () => {
          if (label === 'repair') RepairExecutionResultSchema.parse(outcome);
          else LocalScriptUpdateExecutionResultSchema.parse(outcome);
          verifyResultContent(turn.resultAssertions ?? [], outcome);
        });
        observation.record({
          name: 'delivery.started',
          source: 'xapt',
          correlation: { intervalId: 'result' },
        });
        cooking.executions.complete(project.runner.id, claimed.id, {
          leaseToken: claimed.lease.token,
          sessionId: started.sessionId,
          outcome: { kind: 'SUCCEEDED', result: outcome },
        });
        observation.record({
          name: 'delivery.accepted',
          source: 'server_response',
          correlation: { intervalId: 'result' },
        });
        service.close(claimed.id);
        await service.flush(session);
        const selected = reports.read(project.users.developer.id, claimed.id);
        if (!selected || selected.report.totalMs === null || service.degraded)
          throw new Error('真实归因采集或补报未完成');
        const exported = handleObservationRead(
          new Request(
            `${session.serverOrigin}/report?reportId=${selected.report.reportId}&format=json`,
          ),
          project.users.developer.id,
          claimed.id,
          reports,
        );
        if (!exported.ok) throw new Error('固定版本报告导出失败');
        await writeFile(join(directory, `${label}-report.json`), await exported.text());
        await writeFile(
          join(directory, `${label}-outcome.json`),
          JSON.stringify(outcome, null, 2),
        );
        for (const row of db.all<{ content_json: string }>(
          'SELECT content_json FROM platform_observation_event WHERE execution_id=?',
          claimed.id,
        )) {
          if (
            row.content_json.includes(directory) ||
            row.content_json.includes(session.credential)
          )
            throw new Error('安全事件泄漏');
        }
        console.log(
          `${index + 1}/${variant}/${label}：报告已接受，${selected.report.totalMs.toFixed(0)} 毫秒`,
        );
        return { outcome, report: selected.report };
      } finally {
        clearTimeout(timeout);
        clearInterval(renewing);
      }
    };
    const repaired = await run(repair, repairWorktree, 'repair');
    const parsedRepair = RepairExecutionResultSchema.parse(repaired.outcome).result;
    if (
      parsedRepair.outcome !== 'COMPLETED' ||
      parsedRepair.completionKind !== 'CHANGES_COMMITTED'
    )
      throw new Error('Repair 未产生候选');
    if (
      fixtureGit(fixture.remote, 'rev-parse', 'main') !== fixture.base ||
      (await caseTrace(repairWorktree)).some(
        (event) => event.step === 'build' || event.step === 'deploy',
      )
    )
      throw new Error('Repair 越过职责边界');
    if (
      fixtureGit(
        repairWorktree,
        'diff',
        fixture.base,
        'HEAD',
        '--',
        'AGENTS.md',
        'README.md',
        'tools',
        'tests',
        'build-config.json',
        'package.json',
      )
    )
      throw new Error('Repair 修改了验收输入');
    const batch = cooking.updates.freezeNow(
      project.users.developer.id,
      project.items[0]!.id,
      { mutationId: randomUUID() },
    );
    const update = (await cooking.executions.claim(project.runner.id, 1, 0))[0]!;
    if (update.id !== batch.executionId) throw new Error('领取批次关联错误');
    const updateWorktree = join(directory, 'update');
    fixtureGit(
      fixture.source,
      'worktree',
      'add',
      '--detach',
      updateWorktree,
      fixture.base,
    );
    const updated = await run(update, updateWorktree, 'update');
    if (
      LocalScriptUpdateExecutionResultSchema.parse(updated.outcome).result.outcome !==
      'COMPLETED'
    )
      throw new Error('Update 未完成假部署');
    if (
      fixtureGit(
        updateWorktree,
        'diff',
        fixture.base,
        'HEAD',
        '--',
        'AGENTS.md',
        'README.md',
        'tools',
        'tests',
        'build-config.json',
        'package.json',
      )
    )
      throw new Error('Update 修改了验收输入');
    const trace = await caseTrace(updateWorktree);
    const builds = trace.filter((event) => event.step === 'build');
    const deployed = trace.filter((event) => event.step === 'deploy');
    if (
      builds.length !== (variant === 'baseline' ? 2 : 1) ||
      deployed.length !== 1 ||
      !trace.some((event) => event.step === 'audit')
    )
      throw new Error('构建计数、独立检查或部署次数错误');
    const manifest = JSON.parse(
      await readFile(join(updateWorktree, '.case/manifest.json'), 'utf8'),
    );
    const targetReceipt = JSON.parse(
      await readFile(join(updateWorktree, '.case/target/receipt.json'), 'utf8'),
    );
    if (
      manifest.artifactId !== targetReceipt.artifactId ||
      manifest.digest !== targetReceipt.digest ||
      manifest.sourceCommit !== fixtureGit(fixture.remote, 'rev-parse', 'main')
    )
      throw new Error('产物或 Push 关联错误');
    const sourceBuilds = updated.report.unplaced.filter(
      (event) => event.activity === 'build',
    );
    const duplicate = updated.report.findings.some(
      (finding) =>
        finding.kind === 'potential_duplicate_work' && finding.activity === 'build',
    );
    if (sourceBuilds.length !== builds.length || duplicate !== (variant === 'baseline'))
      throw new Error('自动诊断与独立轨迹不一致');
    for (const commit of parsedRepair.commits)
      fixtureGit(fixture.remote, 'merge-base', '--is-ancestor', commit, 'main');
    if (fixtureGit(updateWorktree, 'status', '--porcelain'))
      throw new Error('Update 留下未提交修改');
    results.push({
      variant,
      repairMs: repaired.report.totalMs,
      updateMs: updated.report.totalMs,
      buildCount: builds.length,
      sourceBuildCount: sourceBuilds.length,
      duplicateCandidate: duplicate,
      artifactMatched: true,
      checksPreserved: true,
      reportId: updated.report.reportId,
    });
    await writeFile(
      join(root, 'results.json'),
      JSON.stringify(
        {
          preregistration,
          results,
          performanceConclusion: '未证实：功能样本，不用于正式性能收益判断',
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}
console.log(
  '真实 Repair/Update、回执提取、独立补报、固定版本导出和构建计数验证通过；性能收益未证实。',
);
