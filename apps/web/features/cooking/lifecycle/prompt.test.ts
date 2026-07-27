import { describe, expect, test } from 'bun:test';
import {
  CleanupExecutionResultSchema,
  CleanupOutputJsonSchema,
} from './contract';
import {
  CLEANUP_PROMPT_KIND,
  CLEANUP_PROMPT_VERSION,
  buildContinuationCleanupPrompt,
  buildInitialCleanupPrompt,
} from './prompt';

describe('Cleanup Prompt', () => {
  test('只允许清理明确逻辑工作区且资源不存在视为成功', () => {
    const prompt = buildInitialCleanupPrompt({
      reason: 'SUBMISSION_CLOSED',
      submissionTitle: '支付提测',
      engineeringName: '支付工程',
      targetBranch: 'main',
      workspaceKeys: ['repair:bug-1', 'update-batch:batch-1'],
    });
    expect(prompt).toMatchObject({
      kind: CLEANUP_PROMPT_KIND,
      version: CLEANUP_PROMPT_VERSION,
      outputJsonSchema: CleanupOutputJsonSchema,
    });
    expect(prompt.renderedPrompt).toContain('资源已经不存在时视为幂等成功');
    expect(prompt.renderedPrompt).toContain('repair:bug-1');
    expect(prompt.renderedPrompt).toContain('update-batch:batch-1');
    expect(prompt.renderedPrompt).toContain('不得删除目标仓库');
  });

  test('继续清理不重复完整业务上下文，结果拒绝伪造字段', () => {
    const prompt = buildContinuationCleanupPrompt();
    expect(prompt.renderedPrompt).toContain('继续原 Cleanup Session');
    expect(prompt.renderedPrompt).not.toContain('提测单：');
    expect(
      CleanupExecutionResultSchema.safeParse({
        outcome: 'COMPLETED',
        summary: '已清理',
        deletedRepository: true,
      }).success,
    ).toBe(false);
  });

  test('Cleanup 输出 Schema 是所有字段 required 的根对象', () => {
    expect(CleanupOutputJsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'summary'],
    });
    expect(JSON.stringify(CleanupOutputJsonSchema)).not.toContain('"oneOf"');
  });
});
