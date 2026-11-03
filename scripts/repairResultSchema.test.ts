import { createRequire } from 'node:module';
import { expect, test } from 'bun:test';
import {
  RepairExecutionResultSchema,
  RepairOutputJsonSchema,
} from '../apps/web/contracts/submissions/repair';
import { createFixture, session } from '../apps/xapt/src/execution/serviceFixture';

const loadXaptDependency = createRequire(
  new URL('../apps/xapt/package.json', import.meta.url),
);
const Ajv = loadXaptDependency('ajv');
const alreadyFixed = {
  outcome: 'COMPLETED',
  completionKind: 'TARGET_ALREADY_FIXED',
  changes: [],
  validations: [{ name: '全量账号滚动与选择', status: 'PASSED', detail: '模拟数据验证' }],
  warnings: ['未核对真实接口是否遗漏账号'],
  commits: [],
  manualOperations: [],
};

test.each([
  ['changes', ['当前实现已支持全量账号展示，无需修改代码。']],
  ['commits', ['a'.repeat(40)]],
  ['manualOperations', [{ kind: 'DATABASE_SQL', paths: ['scripts/update.sql'] }]],
] as const)('无需改动时 %s 的空数组约束同时用于 Codex 和服务端', (field, value) => {
  const validate = new Ajv({ strict: false }).compile(RepairOutputJsonSchema);
  const valid = { result: alreadyFixed };
  expect(validate(valid)).toBe(true);
  expect(RepairExecutionResultSchema.safeParse(valid).success).toBe(true);

  const invalid = { result: { ...alreadyFixed, [field]: value } };
  expect(RepairExecutionResultSchema.safeParse(invalid).success).toBe(false);
  expect(validate(invalid)).toBe(false);
});

test('本机同步明确指出无需改动结果的错误字段，不上传错误结果或原始内容', async () => {
  const fixture = await createFixture({
    readSessionId: 'manual-session',
    readOutputJsonSchema: RepairOutputJsonSchema,
    readResult: {
      result: { ...alreadyFixed, changes: ['仅用于检查不得回显的原始内容'] },
    },
  });
  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.http.outcomes).toEqual([]);
  const reported = JSON.stringify(fixture.http.starts);
  expect(fixture.http.starts[0]?.kind).toBe('START_FAILED');
  expect(reported).toContain('result.changes');
  expect(reported).toContain('最多允许 0 项');
  expect(reported).not.toContain('result.handoff');
  expect(reported).not.toContain('仅用于检查不得回显的原始内容');
});
