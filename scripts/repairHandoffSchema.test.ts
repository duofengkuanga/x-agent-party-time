import { createRequire } from 'node:module';
import { expect, test } from 'bun:test';
import { RepairOutputJsonSchema } from '../apps/web/contracts/submissions/repair';
import { REPAIR_HANDOFF_TEXT_ASSERTION } from '../apps/web/contracts/submissions/handoff';
import { GitExecutionResultVerifier } from '../apps/xapt/src/execution/resultVerification';
import { NodeCommandRunner } from '../apps/xapt/src/platform/system';

const loadXaptDependency = createRequire(
  new URL('../apps/xapt/package.json', import.meta.url),
);
const Ajv = loadXaptDependency('ajv');

test('Codex 使用支持的格式 Schema，本机结果断言在上传前拒绝不可移植信息', async () => {
  const validate = new Ajv({ strict: false }).compile(RepairOutputJsonSchema);
  expect(JSON.stringify(RepairOutputJsonSchema)).not.toMatch(/\(\?[=!<]/u);
  const verifier = new GitExecutionResultVerifier(new NodeCommandRunner());
  const result = {
    outcome: 'COMPLETED',
    completionKind: 'CHANGES_COMMITTED',
    changes: [],
    validations: [],
    warnings: [],
    commits: ['a'.repeat(40)],
    manualOperations: [],
    handoff: {
      validationCommands: [],
      environmentNotes: [],
      impact: [],
      remainingWork: ['仍需最终组合验证'],
      limitations: [] as string[],
    },
  };
  expect(validate({ result })).toBe(true);
  for (const text of [
    '本机目录 /Users/example/private',
    '目录：/Users/example/private',
    '目录(/Users/example/private)',
    '参考 `/Users/example/private`',
    '目录C:/Users/example/private',
    '目录/Users/example/private',
    'TOKEN=fixture-only',
    'pAsSwOrD=fixture-only',
    '目录 C:\\private',
  ]) {
    result.handoff.limitations = [text];
    await expect(
      verifier.verify('', [REPAIR_HANDOFF_TEXT_ASSERTION], null, { result }),
    ).rejects.toThrow('字符串约束');
  }
});
