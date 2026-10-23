import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  calculateObservationReport,
  type ObservationEvent,
} from '../../packages/execution-contract/src/observability/index';
import { ExecutionObservation } from '../../apps/xapt/src/observability/recorder';
import { protocolObserver } from '../../apps/xapt/src/observability/protocol';
import { prepareBuildCase, fixtureGit, runCaseTool, caseTrace } from './fixture';

async function fixedCase(variant: 'baseline' | 'optimized') {
  const root = await mkdtemp(join(tmpdir(), 'observability-build-'));
  const f = await prepareBuildCase(root, variant);
  await writeFile(
    join(f.source, 'src/add.ts'),
    'export function add(a: number, b: number) { return a + b; }\n',
  );
  fixtureGit(f.source, 'add', 'src/add.ts');
  fixtureGit(f.source, 'commit', '-m', 'fix: addition');
  return { ...f, root };
}

test('真实编译及假部署构建次数2→1，自动回执归因和独立轨迹一致', async () => {
  for (const variant of ['baseline', 'optimized'] as const) {
    const f = await fixedCase(variant);
    try {
      const events: ObservationEvent[] = [];
      const observation = new ExecutionObservation(randomUUID(), (event) =>
        events.push(event),
      );
      observation.record({ name: 'execution.received', source: 'xapt' });
      const observer = protocolObserver(observation);
      for (const stage of ['build', 'audit', 'deploy']) {
        if (stage === 'deploy') fixtureGit(f.source, 'push', 'origin', 'HEAD:main');
        const params = { threadId: 's', turnId: 't' };
        const item = {
          id: stage,
          type: 'commandExecution',
          command: `bun tools/delivery.ts ${stage}`,
          cwd: f.source,
        };
        observer({
          type: 'receive',
          message: { method: 'item/started', params: { ...params, item } },
        });
        const output = runCaseTool(f.source, stage);
        const notice = {
          type: 'receive' as const,
          message: {
            method: 'item/completed',
            params: {
              ...params,
              item: {
                ...item,
                status: 'completed',
                exitCode: 0,
                aggregatedOutput: output,
              },
            },
          },
        };
        observer(notice);
        observer(notice); // Protocol replay cannot add a second occurrence.
      }
      observation.record({ name: 'delivery.accepted', source: 'server_response' });
      observation.close();
      const report = calculateObservationReport(events, {
        executionId: observation.executionId,
        reportId: randomUUID(),
        revision: 1,
        parentReportId: null,
        inputDigest: 'a'.repeat(64),
        calculatedAt: new Date().toISOString(),
      });
      const trace = await caseTrace(f.source);
      expect(trace.filter((entry) => entry.step === 'build')).toHaveLength(
        variant === 'baseline' ? 2 : 1,
      );
      expect(report.unplaced.filter((entry) => entry.activity === 'build')).toHaveLength(
        variant === 'baseline' ? 2 : 1,
      );
      expect(
        report.findings.some(
          (finding) =>
            finding.kind === 'potential_duplicate_work' && finding.activity === 'build',
        ),
      ).toBe(variant === 'baseline');
      const manifest = JSON.parse(
        await readFile(join(f.source, '.case/manifest.json'), 'utf8'),
      );
      const deployed = JSON.parse(
        await readFile(join(f.source, '.case/target/receipt.json'), 'utf8'),
      );
      expect(deployed).toMatchObject({
        artifactId: manifest.artifactId,
        digest: manifest.digest,
        sourceCommit: manifest.sourceCommit,
      });
      expect(trace.some((entry) => entry.step === 'audit')).toBe(true);
      expect(JSON.stringify(events)).not.toContain(f.source);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('产物篡改、输入变化、Push未确认及目标竞争均在副作用前拒绝，不重新构建', async () => {
  for (const fault of ['artifact', 'inputs', 'push', 'target']) {
    const f = await fixedCase('optimized');
    try {
      runCaseTool(f.source, 'build');
      runCaseTool(f.source, 'audit');
      if (fault !== 'push') fixtureGit(f.source, 'push', 'origin', 'HEAD:main');
      const manifest = JSON.parse(
        await readFile(join(f.source, '.case/manifest.json'), 'utf8'),
      );
      if (fault === 'artifact') {
        const path = join(f.source, '.case', manifest.artifactId + '.js');
        await chmod(path, 0o600);
        await writeFile(path, 'tampered');
      }
      if (fault === 'inputs')
        await writeFile(
          join(f.source, 'build-config.json'),
          '{"environment":"changed","variant":"optimized"}',
        );
      if (fault === 'target') {
        runCaseTool(f.source, 'deploy');
        await writeFile(
          join(f.source, '.case/target/receipt.json'),
          JSON.stringify({ artifactId: randomUUID() }),
        );
      }
      expect(() => runCaseTool(f.source, 'deploy')).toThrow();
      const trace = await caseTrace(f.source);
      expect(trace.filter((entry) => entry.step === 'build')).toHaveLength(1);
      expect(trace.filter((entry) => entry.step === 'deploy')).toHaveLength(
        fault === 'target' ? 1 : 0,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('假部署响应丢失后核对目标回执，恢复不重复构建或发布', async () => {
  const f = await fixedCase('optimized');
  try {
    runCaseTool(f.source, 'build');
    runCaseTool(f.source, 'audit');
    fixtureGit(f.source, 'push', 'origin', 'HEAD:main');
    await writeFile(join(f.source, '.case/lose-response'), 'synthetic');
    expect(() => runCaseTool(f.source, 'deploy')).toThrow();
    await rm(join(f.source, '.case/lose-response'));
    runCaseTool(f.source, 'deploy');
    const trace = await caseTrace(f.source);
    expect(trace.filter((entry) => entry.step === 'build')).toHaveLength(1);
    expect(trace.filter((entry) => entry.step === 'deploy')).toHaveLength(1);
    expect(trace.filter((entry) => entry.step === 'deploy.already_applied')).toHaveLength(
      1,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
