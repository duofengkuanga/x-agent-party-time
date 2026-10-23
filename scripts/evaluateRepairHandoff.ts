import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  RepairExecutionResultSchema,
  RepairOutputJsonSchema,
} from '../apps/web/contracts/submissions/repair';
import {
  CiCdUpdateExecutionResultSchema,
  CiCdUpdateOutputJsonSchema,
} from '../apps/web/contracts/submissions/update';
import { bundleHash } from '../apps/xapt/src/skills/manager';
import { verifyResultContent } from '../apps/xapt/src/execution/resultVerification';
import {
  REPAIR_HANDOFF_TEXT_ASSERTION,
  UPDATE_HANDOFF_TEXT_ASSERTION,
} from '../apps/web/contracts/submissions/handoff';

const { values } = parseArgs({
  options: {
    'skills-root': { type: 'string' },
    'baseline-app': { type: 'string' },
    'baseline-skills': { type: 'string' },
    case: { type: 'string', default: 'all' },
    variant: { type: 'string', default: 'all' },
    codex: { type: 'string', default: 'codex' },
    scenario: { type: 'string', default: 'single' },
  },
});
if (!values['skills-root'] || !values['baseline-app'] || !values['baseline-skills'])
  throw new Error(
    '需要 --skills-root、--baseline-app 和 --baseline-skills；仅使用本地临时仓库和假远端。',
  );
const appRoot = resolve(import.meta.dir, '..');
const skillsRoot = resolve(values['skills-root']);
const evaluationRoot = await mkdtemp(join(tmpdir(), 'repair-handoff-eval-'));
const repairSkill = 'agent-party-time-repair-bug';
const updateSkill = 'agent-party-time-integrate-update-batch';
const variants = values.variant === 'all' ? ['baseline', 'current'] : [values.variant!];
const cases = values.case === 'all' ? ['node', 'python'] : [values.case!];
if (
  variants.some((value) => !['baseline', 'current'].includes(value)) ||
  cases.some((value) => !['node', 'python'].includes(value))
)
  throw new Error('case 只允许 all/node/python；variant 只允许 all/baseline/current');
if (
  !['single', 'independent', 'stale', 'multi', 'resume'].includes(values.scenario!) ||
  (values.scenario !== 'single' &&
    (values.case !== 'node' || values.variant !== 'current'))
)
  throw new Error(
    '扩展 scenario 需要 --case node --variant current，可选 independent/stale/multi/resume',
  );

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

type PhaseReport = {
  phase: string;
  elapsedMs: number;
  exitCode: number;
  outcome: unknown;
  eventsFile: string;
  threadId: string | null;
};
const reports: Array<Record<string, unknown>> = [];
console.log(`验收证据目录：${evaluationRoot}`);
const baselineApp = join(evaluationRoot, 'baseline-app');
let baselineSchemas: { repair: unknown; update: unknown } | undefined;
if (variants.includes('baseline')) {
  git(appRoot, 'worktree', 'add', '--detach', baselineApp, values['baseline-app']);
  try {
    await symlink(
      join(appRoot, 'node_modules'),
      join(baselineApp, 'node_modules'),
      'dir',
    );
    await symlink(
      join(appRoot, 'apps/web/node_modules'),
      join(baselineApp, 'apps/web/node_modules'),
      'dir',
    );
    baselineSchemas = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          "import {RepairOutputJsonSchema} from './cooking/repair/contract'; import {CiCdUpdateOutputJsonSchema} from './cooking/update/contract'; console.log(JSON.stringify({repair:RepairOutputJsonSchema,update:CiCdUpdateOutputJsonSchema}));",
        ],
        { cwd: join(baselineApp, 'apps/web'), encoding: 'utf8' },
      ),
    );
  } finally {
    git(appRoot, 'worktree', 'remove', '--force', baselineApp);
  }
}

const policy = `# Isolated delivery evaluation\n\nThis repository and its origin are disposable local fixtures. Follow the explicitly invoked Repair or Update Skill. Ordinary local commits and pushes to this fixture's local origin are authorized. Do not use a network remote or a real deployment. Keep AGENTS.md, validation scripts, and tests unchanged. Do not weaken checks. No database work is needed.\n`;

async function prepareCase(directory: string, language: string) {
  const source = join(directory, 'source');
  await mkdir(join(source, 'tools'), { recursive: true });
  await mkdir(join(source, 'src'));
  await mkdir(join(source, 'tests'));
  await writeFile(join(source, 'AGENTS.md'), policy);
  await writeFile(join(source, '.gitignore'), '.agents/\n.eval/\ndist/\n__pycache__/\n');
  const driver = language === 'node' ? 'node tools/check.mjs' : 'python3 tools/check.py';
  await writeFile(
    join(source, 'README.md'),
    `# Billing fixture\n\nThe add function must return the sum of two integers.\n\nRepair acceptance: relevant tests must pass. Delivery acceptance: syntax/compilation, tests, and a package artifact must all be evidenced.\n\nAvailable validation entry points:\n- ${driver} compile\n- ${driver} test\n- ${driver} package\n\nInspect the scripts to select applicable commands and runtime conditions. No external services or package installation are needed.\n`,
  );
  if (language === 'node') {
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({
        type: 'module',
        scripts: {
          compile: 'node tools/check.mjs compile',
          test: 'node tools/check.mjs test',
          build: 'node tools/check.mjs package',
        },
      }),
    );
    await writeFile(
      join(source, 'src/add.js'),
      'export function add(a, b) { return a + b + 1; }\n',
    );
    await writeFile(
      join(source, 'tests/add.test.mjs'),
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/add.js'; test('integer addition', () => { assert.equal(add(2,3),5); assert.equal(add(-1,1),0); });\n",
    );
    await writeFile(
      join(source, 'tools/check.mjs'),
      `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
mkdirSync('.eval', { recursive: true });
const stage = process.argv[2];
const log = (step) => appendFileSync('.eval/trace.jsonl', JSON.stringify({ step, at: Date.now(), invocation: process.argv.slice(2) })+'\\n');
log('invocation');
// Git metadata readers must opt into native Git when used in a linked worktree.
if (process.argv.includes('--native-git')) execFileSync('git', ['rev-parse','HEAD']); else readFileSync('.git/HEAD');
if (!['compile','test','package'].includes(stage)) throw new Error('Expected compile, test or package');
log('compile'); execFileSync(process.execPath, ['--check','src/add.js'], { stdio: 'inherit' });
if (stage !== 'compile') { log('test'); execFileSync(process.execPath, ['--test','tests/add.test.mjs'], { stdio: 'inherit' }); }
if (stage === 'package') { log('package'); mkdirSync('dist',{recursive:true}); writeFileSync('dist/add.js',readFileSync('src/add.js')); }
`,
    );
  } else {
    await writeFile(join(source, 'src/add.py'), 'def add(a, b):\n    return a + b + 1\n');
    await writeFile(
      join(source, 'tests/test_add.py'),
      'import unittest\nfrom src.add import add\nclass Addition(unittest.TestCase):\n    def test_integers(self):\n        self.assertEqual(add(2, 3), 5)\n        self.assertEqual(add(-1, 1), 0)\n',
    );
    await writeFile(
      join(source, 'tools/check.py'),
      `import json, pathlib, subprocess, sys, time, zipfile
pathlib.Path('.eval').mkdir(exist_ok=True)
stage=sys.argv[1]
def log(step):
    with open('.eval/trace.jsonl','a') as f: f.write(json.dumps({'step':step,'at':time.time()*1000,'invocation':sys.argv[1:]})+'\\n')
log('invocation')
if '--native-git' in sys.argv: subprocess.run(['git','rev-parse','HEAD'], check=True, stdout=subprocess.DEVNULL)
else: pathlib.Path('.git/HEAD').read_text()
if stage not in ('compile','test','package'): raise ValueError('Expected compile, test or package')
log('compile'); subprocess.run([sys.executable,'-m','compileall','-q','src'], check=True)
if stage!='compile':
    log('test'); subprocess.run([sys.executable,'-m','unittest','discover','-s','tests'], check=True)
if stage=='package':
    log('package'); pathlib.Path('dist').mkdir(exist_ok=True)
    with zipfile.ZipFile('dist/add.zip','w') as f: f.write('src/add.py')
`,
    );
  }
  if (values.scenario === 'multi') {
    await writeFile(
      join(source, 'src/subtract.js'),
      'export function subtract(a,b) { return a - b + 1; }\n',
    );
    await writeFile(
      join(source, 'tests/subtract.test.mjs'),
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { subtract } from '../src/subtract.js'; test('integer subtraction', () => { assert.equal(subtract(7,3),4); assert.equal(subtract(-1,1),-2); });\n",
    );
    const tool = join(source, 'tools/check.mjs');
    let script = await readFile(tool, 'utf8');
    script = script.replace(
      'const stage = process.argv[2];',
      "const stage = process.argv[2]; const focusAt = process.argv.indexOf('--focus'); const names = focusAt < 0 ? ['add','subtract'] : [process.argv[focusAt+1]]; if (stage === 'package' && focusAt >= 0) throw new Error('Package must validate all features');",
    );
    script = script.replace(
      "['--test','tests/add.test.mjs']",
      "['--test',...names.map(name => 'tests/'+name+'.test.mjs')]",
    );
    script = script.replace(
      "log('compile');",
      "execFileSync(process.execPath, ['--check','src/subtract.js'], { stdio: 'inherit' }); log('compile');",
    );
    script = script.replace(
      "writeFileSync('dist/add.js',readFileSync('src/add.js'));",
      "writeFileSync('dist/add.js',readFileSync('src/add.js')); writeFileSync('dist/subtract.js',readFileSync('src/subtract.js'));",
    );
    await writeFile(tool, script);
    await writeFile(
      join(source, 'README.md'),
      (await readFile(join(source, 'README.md'), 'utf8')) +
        '\nThis repository currently has independent addition and subtraction defects. A Repair validates its own feature using the test entry with --focus add or --focus subtract. Delivery must validate both features without a focus selector.\n',
    );
  }
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Handoff evaluation');
  git(source, 'config', 'user.email', 'handoff-eval@example.invalid');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'test: isolated handoff fixture');
  const remote = join(directory, 'remote.git');
  git(source, 'clone', '--bare', source, remote);
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'fetch', 'origin');
  return { source, remote, base: git(source, 'rev-parse', 'HEAD'), driver };
}

async function runAgent(
  worktree: string,
  directory: string,
  variant: string,
  phase: 'repair' | 'update',
  brief: unknown,
  options: { label?: string; persist?: boolean; resumeTaskId?: string } = {},
): Promise<PhaseReport> {
  const label = options.label ?? phase;
  const skillName = phase === 'repair' ? repairSkill : updateSkill;
  const skillRoot = join(worktree, '.agents/skills', skillName);
  await mkdir(join(skillRoot, 'agents'), { recursive: true });
  const files = await Promise.all(
    ['SKILL.md', 'agents/openai.yaml'].map(async (path) => {
      const bytes = options.resumeTaskId
        ? await readFile(join(skillRoot, path))
        : variant === 'baseline'
          ? Buffer.from(
              git(
                skillsRoot,
                'show',
                `${values['baseline-skills']}:skills/${skillName}/${path}`,
              ) + '\n',
            )
          : await readFile(join(skillsRoot, 'skills', skillName, path));
      if (!options.resumeTaskId) await writeFile(join(skillRoot, path), bytes);
      return { path, bytes };
    }),
  );
  const schema =
    variant === 'baseline'
      ? baselineSchemas![phase]
      : phase === 'repair'
        ? RepairOutputJsonSchema
        : CiCdUpdateOutputJsonSchema;
  const schemaFile = join(directory, `${label}-schema.json`);
  const resultFile = join(directory, `${label}-outcome.json`);
  const eventsFile = join(directory, `${label}-events.jsonl`);
  await writeFile(schemaFile, JSON.stringify(schema));
  await writeFile(
    join(directory, `${label}-identity.json`),
    JSON.stringify(
      {
        skillName,
        bundleHash: bundleHash(files),
        sourceRevision:
          variant === 'baseline'
            ? git(skillsRoot, 'rev-parse', values['baseline-skills']!)
            : git(skillsRoot, 'rev-parse', 'HEAD'),
        workingTreeChanges:
          variant === 'current' ? git(skillsRoot, 'diff', '--stat') : '',
      },
      null,
      2,
    ),
  );
  const prompt = options.resumeTaskId
    ? '前次终态传输中断，平台尚未确认结果。继续完成同一个冻结更新批次；候选、目标分支、环境和验收要求均未改变。按原 Skill 核对当前事实后返回终态。'
    : `Use $${skillName} at ${join(skillRoot, 'SKILL.md')} to complete this Execution. Your worktree has already been prepared at ${worktree}. This is an authorized isolated evaluation: modify only this worktree, and use only its local origin for any permitted push. Follow the supplied output Schema. Do not change AGENTS.md, tests, validation scripts, or the Skill.\nExecution Brief:\n${JSON.stringify(brief)}\n`;
  await writeFile(join(directory, `${label}-prompt.txt`), prompt);
  const started = Date.now();
  console.log(`${variant}/${directory.split('/').at(-1)}/${phase}: real Codex started`);
  const child = Bun.spawn(
    [
      values.codex!,
      'exec',
      ...(!options.persist && !options.resumeTaskId ? ['--ephemeral'] : []),
      '--json',
      '-c',
      'approval_policy="never"',
      '--sandbox',
      'workspace-write',
      '--add-dir',
      evaluationRoot,
      '-C',
      worktree,
      '--output-schema',
      schemaFile,
      '--output-last-message',
      resultFile,
      ...(options.resumeTaskId ? ['resume', options.resumeTaskId] : []),
      '-',
    ],
    {
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONPYCACHEPREFIX: join(worktree, '.eval', 'pycache'),
      },
      stdin: new TextEncoder().encode(prompt),
      stdout: Bun.file(eventsFile),
      stderr: Bun.file(join(directory, `${label}-stderr.log`)),
    },
  );
  const timeout = setTimeout(() => child.kill(), 8 * 60_000);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  const outcome = await readFile(resultFile, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const report = {
    phase,
    elapsedMs: Date.now() - started,
    exitCode,
    outcome,
    eventsFile,
    threadId:
      (await readFile(eventsFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((event) => event.type === 'thread.started')?.thread_id ?? null,
  };
  await writeFile(
    join(directory, `${label}-report.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `${variant}/${directory.split('/').at(-1)}/${phase}: exit=${exitCode}, ${report.elapsedMs}ms`,
  );
  if (exitCode !== 0 || !outcome)
    throw new Error(`真实 Agent 未完成 ${phase}；见 ${eventsFile} 与同目录错误日志`);
  if (variant === 'current')
    verifyResultContent(
      [
        phase === 'repair'
          ? REPAIR_HANDOFF_TEXT_ASSERTION
          : UPDATE_HANDOFF_TEXT_ASSERTION,
      ],
      outcome,
    );
  return report;
}

function assertPublicSummary(
  result: ReturnType<typeof RepairExecutionResultSchema.parse>['result'],
) {
  if (result.outcome !== 'COMPLETED') return;
  const text = [
    ...result.changes,
    ...result.warnings,
    ...result.validations.flatMap((entry) => [entry.name, entry.detail]),
  ].join('\n');
  if (
    /\b(?:git\s+(?:diff|status|log|show|rev-parse)|(?:node|python3?|bun|npm|pnpm|mvn)\s+(?:run|test|--|tools\/|-m)|src\/\S+)/u.test(
      text,
    )
  )
    throw new Error('真实 Repair 公共摘要包含命令或文件位置，不能通过角色边界验收');
}

async function changeDeliveryInputs(source: string): Promise<string> {
  if (values.scenario === 'stale') {
    await rename(join(source, 'tools/check.mjs'), join(source, 'tools/verify.mjs'));
    for (const file of ['README.md', 'package.json'])
      await writeFile(
        join(source, file),
        (await readFile(join(source, file), 'utf8')).replaceAll(
          'tools/check.mjs',
          'tools/verify.mjs',
        ),
      );
  } else if (values.scenario === 'independent') {
    await writeFile(
      join(source, 'delivery-policy.json'),
      JSON.stringify({ phase: 'update' }),
    );
    await writeFile(
      join(source, 'tools/audit.mjs'),
      `import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
if (JSON.parse(readFileSync('delivery-policy.json','utf8')).phase !== 'update') throw new Error('Delivery policy invalid');
mkdirSync('.eval',{recursive:true}); appendFileSync('.eval/trace.jsonl',JSON.stringify({step:'independent',at:Date.now()})+'\\n');
`,
    );
    await writeFile(
      join(source, 'README.md'),
      (await readFile(join(source, 'README.md'), 'utf8')) +
        '\nEvery Update must also run node tools/audit.mjs against current delivery policy, even if a Repair check passed. The package lifecycle does not include this check.\n',
    );
  } else return git(source, 'rev-parse', 'HEAD');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'test: change delivery inputs after repair');
  git(source, 'push', 'origin', 'main');
  return git(source, 'rev-parse', 'HEAD');
}

try {
  for (const variant of variants)
    for (const language of cases) {
      const directory = join(evaluationRoot, `${variant}-${language}`);
      const fixture = await prepareCase(directory, language);
      const repairWorktree = join(directory, 'repair');
      git(
        fixture.source,
        'worktree',
        'add',
        '-b',
        'repair',
        repairWorktree,
        fixture.base,
      );
      const repair = await runAgent(repairWorktree, directory, variant, 'repair', {
        bugTitle: '整数加法结果总是偏大',
        actualResult: 'add(2,3) 返回 6',
        expectedResult: '返回 5，且负数相加结果正确',
        targetBranch: 'main',
      });
      const repairResult = (
        repair.outcome as { result: { commits: string[]; outcome: string } }
      ).result;
      if (variant === 'current')
        assertPublicSummary(RepairExecutionResultSchema.parse(repair.outcome).result);
      if (repairResult.outcome !== 'COMPLETED')
        throw new Error('Repair 没有成功，不能进入 Update');
      const actualCommits = git(
        repairWorktree,
        'rev-list',
        '--reverse',
        `${fixture.base}..HEAD`,
      ).split('\n');
      if (
        JSON.stringify(actualCommits) !== JSON.stringify(repairResult.commits) ||
        git(fixture.remote, 'rev-parse', 'main') !== fixture.base
      )
        throw new Error('Repair 的候选证据或禁止 Push 边界不成立');
      if (
        git(
          repairWorktree,
          'diff',
          fixture.base,
          'HEAD',
          '--',
          'AGENTS.md',
          'tests',
          'tools',
        )
      )
        throw new Error('Agent 修改了验收输入');
      if (git(repairWorktree, 'status', '--porcelain'))
        throw new Error('Repair 留下未提交改动');
      const updateWorktree = join(directory, 'update');
      const context = repairResult as unknown as {
        commits: string[];
        changes: string[];
        validations: unknown[];
        warnings: string[];
        handoff: unknown;
      };
      const candidates = [
        {
          position: 0,
          bugTitle: '整数加法结果总是偏大',
          commits: [...actualCommits],
          ...(variant === 'current'
            ? {
                repairHandoffs: [
                  {
                    commits: context.commits,
                    changes: context.changes,
                    validations: context.validations,
                    warnings: context.warnings,
                    handoff: context.handoff,
                  },
                ],
              }
            : {}),
        },
      ];
      const otherRepairs: PhaseReport[] = [];
      if (values.scenario === 'multi') {
        const secondDirectory = join(directory, 'second-repair');
        const secondWorktree = join(directory, 'repair-subtract');
        await mkdir(secondDirectory);
        git(
          fixture.source,
          'worktree',
          'add',
          '-b',
          'repair-subtract',
          secondWorktree,
          fixture.base,
        );
        const second = await runAgent(
          secondWorktree,
          secondDirectory,
          variant,
          'repair',
          {
            bugTitle: '整数减法结果偏大',
            actualResult: 'subtract(7,3) 返回 5',
            expectedResult: '返回 4，且负数减法正确',
            targetBranch: 'main',
          },
        );
        const secondResult = RepairExecutionResultSchema.parse(second.outcome).result;
        assertPublicSummary(secondResult);
        if (
          secondResult.outcome !== 'COMPLETED' ||
          secondResult.completionKind !== 'CHANGES_COMMITTED'
        )
          throw new Error('第二次修复未产出候选');
        const produced = git(
          secondWorktree,
          'rev-list',
          '--reverse',
          `${fixture.base}..HEAD`,
        ).split('\n');
        if (
          JSON.stringify(produced) !== JSON.stringify(secondResult.commits) ||
          git(secondWorktree, 'status', '--porcelain') ||
          git(
            secondWorktree,
            'diff',
            fixture.base,
            'HEAD',
            '--',
            'AGENTS.md',
            'tests',
            'tools',
          )
        )
          throw new Error('第二次 Repair 的提交或验收边界不成立');
        candidates.push({
          position: 1,
          bugTitle: '整数减法结果偏大',
          commits: produced,
          repairHandoffs: [
            {
              commits: secondResult.commits,
              changes: secondResult.changes,
              validations: secondResult.validations,
              warnings: secondResult.warnings,
              handoff: secondResult.handoff,
            },
          ],
        });
        actualCommits.push(...produced);
        otherRepairs.push(second);
      }
      const updateBase = await changeDeliveryInputs(fixture.source);
      git(fixture.source, 'worktree', 'add', '--detach', updateWorktree, updateBase);
      const update = await runAgent(
        updateWorktree,
        directory,
        variant,
        'update',
        {
          targetBranch: 'main',
          environment: 'isolated',
          deployment: { mode: 'CI_CD' },
          frozenCandidates: candidates,
        },
        { persist: values.scenario === 'resume' },
      );
      if (variant === 'current') CiCdUpdateExecutionResultSchema.parse(update.outcome);
      if ((update.outcome as { result: { outcome: string } }).result.outcome !== 'PUSHED')
        throw new Error('Update 没有确认 Push');
      for (const commit of actualCommits)
        git(fixture.remote, 'merge-base', '--is-ancestor', commit, 'main');
      if (git(updateWorktree, 'status', '--porcelain'))
        throw new Error('Update 留下未提交改动');
      if (
        git(
          updateWorktree,
          'diff',
          updateBase,
          'HEAD',
          '--',
          'AGENTS.md',
          'tests',
          'tools',
        )
      )
        throw new Error('Agent 修改了验收输入');
      const trace = async (path: string) =>
        readFile(join(path, '.eval/trace.jsonl'), 'utf8')
          .then((text) =>
            text
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line)),
          )
          .catch(() => []);
      const repairTrace = await trace(repairWorktree),
        updateTrace = await trace(updateWorktree);
      if (
        !updateTrace.some((entry) => entry.step === 'package') ||
        !updateTrace.some((entry) => entry.step === 'test')
      )
        throw new Error('真实命令记录缺少交付验收');
      if (
        values.scenario === 'independent' &&
        !updateTrace.some((entry) => entry.step === 'independent')
      )
        throw new Error('不可合并的本阶段强制检查没有执行');
      if (values.scenario === 'stale') {
        const parsed = CiCdUpdateExecutionResultSchema.parse(update.outcome).result;
        if (!parsed.handoffUse.rechecked.length)
          throw new Error('失效入口没有重新查证说明');
      }
      if (
        values.scenario === 'multi' &&
        updateTrace.filter((entry) => entry.step === 'package').length !== 1
      )
        throw new Error('多候选更新重复完整打包');
      let resumed: PhaseReport | null = null;
      if (values.scenario === 'resume') {
        if (!update.threadId) throw new Error('缺少可恢复的真实 Task');
        const remoteBefore = git(fixture.remote, 'rev-parse', 'main');
        resumed = await runAgent(updateWorktree, directory, variant, 'update', null, {
          resumeTaskId: update.threadId,
          label: 'resumed-update',
        });
        const parsed = CiCdUpdateExecutionResultSchema.parse(resumed.outcome).result;
        if (
          parsed.outcome !== 'PUSHED' ||
          resumed.threadId !== update.threadId ||
          git(fixture.remote, 'rev-parse', 'main') !== remoteBefore
        )
          throw new Error('原 Task 的恢复结果或远端状态不一致');
        if (JSON.stringify(await trace(updateWorktree)) !== JSON.stringify(updateTrace))
          throw new Error('输入未变的恢复重复了已完成验收');
        const events = (await readFile(resumed.eventsFile, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        if (
          events.some(
            (event) =>
              event.type === 'item.completed' &&
              event.item?.type === 'command_execution' &&
              /\bgit\s+(?:-C\s+\S+\s+)?push\b/u.test(event.item.command) &&
              !event.item.command.includes('--dry-run'),
          )
        )
          throw new Error('结果未知恢复盲目重复 Push');
      }
      const currentReport = {
        variant,
        language,
        repair,
        update,
        scenario: values.scenario,
        otherRepairs,
        resumed,
        repairTrace,
        updateTrace,
        totalMs:
          repair.elapsedMs +
          update.elapsedMs +
          otherRepairs.reduce((sum, item) => sum + item.elapsedMs, 0) +
          (resumed?.elapsedMs ?? 0),
        manualWaitMs: 0,
      };
      reports.push(currentReport);
      await writeFile(
        join(evaluationRoot, 'report.json'),
        JSON.stringify(
          {
            appRevision: git(appRoot, 'rev-parse', 'HEAD'),
            codexVersion: execFileSync(values.codex!, ['--version'], {
              encoding: 'utf8',
            }).trim(),
            reports,
          },
          null,
          2,
        ),
      );
    }
} catch (error) {
  await writeFile(join(evaluationRoot, 'failure.txt'), String(error));
  console.error(String(error));
  process.exitCode = 1;
}
console.log(`保留原始证据：${evaluationRoot}`);
