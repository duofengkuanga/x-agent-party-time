import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  RepairExecutionResultSchema,
  RepairOutputJsonSchema,
} from '../apps/web/cooking/repair/contract';
import {
  CiCdUpdateExecutionResultSchema,
  CiCdUpdateOutputJsonSchema,
} from '../apps/web/cooking/update/contract';
import { bundleHash } from '../apps/xapt/src/skills/manager';
import { verifyResultContent } from '../apps/xapt/src/execution/result-verification';
import {
  REPAIR_HANDOFF_TEXT_ASSERTION,
  UPDATE_HANDOFF_TEXT_ASSERTION,
} from '../apps/web/cooking/repair/handoff';

const { values } = parseArgs({
  options: {
    'skills-root': { type: 'string' },
    'baseline-app': { type: 'string' },
    'baseline-skills': { type: 'string' },
    case: { type: 'string', default: 'all' },
    variant: { type: 'string', default: 'all' },
    codex: { type: 'string', default: 'codex' },
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
): Promise<PhaseReport> {
  const skillName = phase === 'repair' ? repairSkill : updateSkill;
  const skillRoot = join(worktree, '.agents/skills', skillName);
  await mkdir(join(skillRoot, 'agents'), { recursive: true });
  const files = await Promise.all(
    ['SKILL.md', 'agents/openai.yaml'].map(async (path) => {
      const bytes =
        variant === 'baseline'
          ? Buffer.from(
              git(
                skillsRoot,
                'show',
                `${values['baseline-skills']}:skills/${skillName}/${path}`,
              ) + '\n',
            )
          : await readFile(join(skillsRoot, 'skills', skillName, path));
      await writeFile(join(skillRoot, path), bytes);
      return { path, bytes };
    }),
  );
  const schema =
    variant === 'baseline'
      ? baselineSchemas![phase]
      : phase === 'repair'
        ? RepairOutputJsonSchema
        : CiCdUpdateOutputJsonSchema;
  const schemaFile = join(directory, `${phase}-schema.json`);
  const resultFile = join(directory, `${phase}-outcome.json`);
  const eventsFile = join(directory, `${phase}-events.jsonl`);
  await writeFile(schemaFile, JSON.stringify(schema));
  await writeFile(
    join(directory, `${phase}-identity.json`),
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
  const prompt = `Use $${skillName} at ${join(skillRoot, 'SKILL.md')} to complete this Execution. Your worktree has already been prepared at ${worktree}. This is an authorized isolated evaluation: modify only this worktree, and use only its local origin for any permitted push. Follow the supplied output Schema. Do not change AGENTS.md, tests, validation scripts, or the Skill.\nExecution Brief:\n${JSON.stringify(brief)}\n`;
  await writeFile(join(directory, `${phase}-prompt.txt`), prompt);
  const started = Date.now();
  console.log(`${variant}/${directory.split('/').at(-1)}/${phase}: real Codex started`);
  const child = Bun.spawn(
    [
      values.codex!,
      'exec',
      '--ephemeral',
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
      stderr: Bun.file(join(directory, `${phase}-stderr.log`)),
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
  };
  await writeFile(
    join(directory, `${phase}-report.json`),
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
      if (variant === 'current') RepairExecutionResultSchema.parse(repair.outcome);
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
      const updateWorktree = join(directory, 'update');
      git(fixture.source, 'worktree', 'add', '--detach', updateWorktree, fixture.base);
      const context = repairResult as unknown as {
        commits: string[];
        changes: string[];
        validations: unknown[];
        warnings: string[];
        handoff: unknown;
      };
      const update = await runAgent(updateWorktree, directory, variant, 'update', {
        targetBranch: 'main',
        environment: 'isolated',
        deployment: { mode: 'CI_CD' },
        frozenCandidates: [
          {
            position: 0,
            bugTitle: '整数加法结果总是偏大',
            commits: actualCommits,
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
        ],
      });
      if (variant === 'current') CiCdUpdateExecutionResultSchema.parse(update.outcome);
      if ((update.outcome as { result: { outcome: string } }).result.outcome !== 'PUSHED')
        throw new Error('Update 没有确认 Push');
      git(fixture.remote, 'merge-base', '--is-ancestor', actualCommits.at(-1)!, 'main');
      if (
        git(
          updateWorktree,
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
      const currentReport = {
        variant,
        language,
        repair,
        update,
        repairTrace,
        updateTrace,
        totalMs: repair.elapsedMs + update.elapsedMs,
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
