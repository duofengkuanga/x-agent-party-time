import { describe, expect, test } from 'bun:test';
import {
  RepairExecutionResultSchema,
  RepairOutputJsonSchema,
} from './contract';
import {
  REPAIR_PROMPT_KIND,
  REPAIR_PROMPT_VERSION,
  buildContinuationRepairPrompt,
  buildInitialRepairPrompt,
} from './prompt';

describe('Repair prompt contract', () => {
  test('初始 Prompt 保持稳定边界且版本信息不进入正文', () => {
    const prompt = buildInitialRepairPrompt({
      workspaceKey: 'bug-repair:fixture',
      submissionTitle: '支付提测',
      requirementDescription: '修复支付流程',
      engineeringName: '前端工程',
      repositoryUrl: 'https://example.com/front.git',
      targetBranch: 'feature/payment',
      bugTitle: '支付按钮无响应',
      feedback: ['请覆盖键盘操作'],
      pendingCommits: [],
    });
    expect(prompt).toMatchObject({
      kind: REPAIR_PROMPT_KIND,
      version: REPAIR_PROMPT_VERSION,
      outputJsonSchema: RepairOutputJsonSchema,
    });
    expect(prompt.renderedPrompt).toContain('不得 push、部署、改写历史');
    expect(prompt.renderedPrompt).toContain('支付按钮无响应');
    expect(prompt.renderedPrompt).not.toContain('Execution ID');
    expect(prompt.renderedPrompt).not.toContain('Prompt Version');
    expect(prompt.renderedPrompt).not.toContain(new Date().toISOString());
    expect(prompt.renderedPromptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('继续 Prompt 只包含增量信息并复用同一结果 Schema', () => {
    const prompt = buildContinuationRepairPrompt({
      content: '仍需修复键盘回车提交',
      pendingCommits: ['aaaaaaa'],
    });
    expect(prompt.renderedPrompt).toContain('只处理以下增量信息');
    expect(prompt.renderedPrompt).toContain('仍需修复键盘回车提交');
    expect(prompt.renderedPrompt).not.toContain('需求：');
    expect(prompt.outputJsonSchema).toEqual(RepairOutputJsonSchema);
  });

  test('结构化结果拒绝空 Commit、重复以外字段与伪造字段', () => {
    expect(
      RepairExecutionResultSchema.safeParse({
        outcome: 'COMPLETED',
        summary: '完成',
        commits: [],
      }).success,
    ).toBe(false);
    expect(
      RepairExecutionResultSchema.safeParse({
        outcome: 'COMPLETED',
        summary: '完成',
        commits: ['aaaaaaa'],
        deployed: true,
      }).success,
    ).toBe(false);
  });

  test('Codex 输出 Schema 使用根对象且失败结果可用空 Commit 数组传输', () => {
    expect(RepairOutputJsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'summary', 'commits'],
    });
    expect(JSON.stringify(RepairOutputJsonSchema)).not.toContain('"oneOf"');
    expect(
      RepairExecutionResultSchema.safeParse({
        outcome: 'FAILED',
        summary: '无法安全完成',
        commits: [],
      }).success,
    ).toBe(true);
  });
});
