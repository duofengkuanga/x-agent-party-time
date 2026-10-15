import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { NodeLocalFileSystem } from '../../apps/xapt/src/platform/files';
import { xaptPaths } from '../../apps/xapt/src/platform/paths';
import { LocalStateStore } from '../../apps/xapt/src/state/store';
import { ObservationService } from '../../apps/xapt/src/observability/service';
import { protocolObserver } from '../../apps/xapt/src/observability/protocol';
import { createCommandClassifier } from '../../apps/xapt/src/observability/command-context';
import { prepareBuildCase, fixtureGit, runCaseTool, caseTrace } from './fixture';

const scratch = resolve(import.meta.dir, '../../.scratch');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'observability-overhead-'));
const plan = {
  pairs: 5,
  maximumRuns: 10,
  network: 'in-process acceptance receipt; no remote latency',
  models: 'none',
  scope:
    'same optimized fixture; command collection, classification, persistence and simulated delivery',
  excludes: ['Codex/App Server', 'real network', 'formal Update performance acceptance'],
  backgroundLoad: 'not controlled',
};
await writeFile(join(root, 'preregistration.json'), JSON.stringify(plan, null, 2));
const rows: Array<{
  pair: number;
  observation: boolean;
  workflowMs: number;
  drainMs: number;
  parentCpuMicros: number;
}> = [];
for (let pair = 0; pair < plan.pairs; pair++) {
  for (const enabled of pair % 2 === 0 ? [false, true] : [true, false]) {
    const directory = join(root, `${pair + 1}-${enabled ? 'on' : 'off'}`);
    const f = await prepareBuildCase(directory, 'optimized');
    await writeFile(
      join(f.source, 'src/add.ts'),
      'export function add(a: number, b: number) { return a + b; }\n',
    );
    fixtureGit(f.source, 'add', 'src/add.ts');
    fixtureGit(f.source, 'commit', '-m', 'fix: addition');
    const files = new NodeLocalFileSystem();
    const paths = xaptPaths(join(directory, 'home'));
    const state = new LocalStateStore(paths, files);
    await state.initialize();
    const runnerId = randomUUID();
    const executionId = randomUUID();
    const session = { serverOrigin: 'https://offline.example', credential: '' };
    await state.saveConnection({
      schemaVersion: 1,
      serverUrl: session.serverOrigin,
      runnerId,
    });
    const service = new ObservationService(
      join(paths.state, 'observations'),
      files,
      state,
      {
        send: async (_session, batch) => ({
          batchId: batch.batchId,
          digest: batch.digest,
          accepted: true,
          duplicate: false,
        }),
      },
    );
    const cpu = process.cpuUsage();
    const started = performance.now();
    const observation = enabled
      ? service.receive(session, { id: executionId, runnerId })
      : null;
    const classifier = enabled ? createCommandClassifier(f.source) : null;
    if (classifier) await classifier.ready;
    const observer = observation ? protocolObserver(observation, classifier!) : null;
    for (const stage of ['build', 'audit', 'deploy']) {
      if (stage === 'deploy') fixtureGit(f.source, 'push', 'origin', 'HEAD:main');
      const params = { threadId: 'controlled', turnId: 'controlled' };
      const item = {
        id: stage,
        type: 'commandExecution',
        command: `bun tools/delivery.ts ${stage}`,
        cwd: f.source,
      };
      observer?.({
        type: 'receive',
        message: { method: 'item/started', params: { ...params, item } },
      });
      const output = runCaseTool(f.source, stage);
      observer?.({
        type: 'receive',
        message: {
          method: 'item/completed',
          params: {
            ...params,
            item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: output },
          },
        },
      });
    }
    observation?.record({ name: 'delivery.accepted', source: 'server_response' });
    service.close(executionId);
    const workflowMs = performance.now() - started;
    const draining = performance.now();
    if (enabled) await service.flush(session);
    const drainMs = enabled ? performance.now() - draining : 0;
    const used = process.cpuUsage(cpu);
    await service.shutdown();
    const trace = await caseTrace(f.source);
    if (
      trace.filter((entry) => entry.step === 'build').length !== 1 ||
      trace.filter((entry) => entry.step === 'deploy').length !== 1 ||
      service.degraded
    )
      throw new Error('受控开销对照功能校验失败');
    rows.push({
      pair: pair + 1,
      observation: enabled,
      workflowMs,
      drainMs,
      parentCpuMicros: used.user + used.system,
    });
  }
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const differences = Array.from(
  { length: plan.pairs },
  (_, pair) =>
    rows.find((row) => row.pair === pair + 1 && row.observation)!.workflowMs -
    rows.find((row) => row.pair === pair + 1 && !row.observation)!.workflowMs,
);
const result = {
  plan,
  rows,
  differencesMs: differences,
  medianDifferenceMs: median(differences),
  medianOnWorkflowMs: median(
    rows.filter((row) => row.observation).map((row) => row.workflowMs),
  ),
  medianOffWorkflowMs: median(
    rows.filter((row) => !row.observation).map((row) => row.workflowMs),
  ),
  medianDrainMs: median(rows.filter((row) => row.observation).map((row) => row.drainMs)),
  conclusion: '受控小样本；只展示测量，不证明生产上界、真实模型开销或优化收益',
};
await writeFile(join(root, 'results.json'), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    root,
    medianDifferenceMs: result.medianDifferenceMs,
    medianDrainMs: result.medianDrainMs,
  }),
);
