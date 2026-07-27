import { describe, expect, test } from 'bun:test';
import {
  LocalScriptUpdateExecutionResultSchema,
  LocalScriptUpdateOutputJsonSchema,
} from './contract';
import {
  LOCAL_SCRIPT_UPDATE_PROMPT_KIND,
  LOCAL_SCRIPT_UPDATE_PROMPT_VERSION,
  buildContinuationLocalScriptUpdatePrompt,
  buildInitialLocalScriptUpdatePrompt,
} from './prompt';

describe('LOCAL_SCRIPT Update Prompt', () => {
  test('初始 Prompt 固定冻结顺序并包含安全边界', () => {
    const prompt = buildInitialLocalScriptUpdatePrompt({
      workspaceKey: 'update-batch:fixture',
      submissionTitle: '支付提测',
      engineeringName: '支付工程',
      repositoryUrl: 'https://example.com/payment.git',
      targetBranch: 'feature/payment',
      environmentName: '测试环境',
      deploymentCommand: 'bun run deploy:test',
      entries: [
        { bugShortId: 2, bugTitle: '第二个问题', commits: ['bbbbbbb'] },
        { bugShortId: 1, bugTitle: '第一个问题', commits: ['aaaaaaa'] },
      ],
    });
    expect(prompt).toMatchObject({
      kind: LOCAL_SCRIPT_UPDATE_PROMPT_KIND,
      version: LOCAL_SCRIPT_UPDATE_PROMPT_VERSION,
      outputJsonSchema: LocalScriptUpdateOutputJsonSchema,
    });
    expect(prompt.renderedPrompt).toContain('禁止 force push');
    expect(prompt.renderedPrompt.indexOf('bbbbbbb')).toBeLessThan(
      prompt.renderedPrompt.indexOf('aaaaaaa'),
    );
    expect(prompt.renderedPromptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('继续 Prompt 只发送增量信息', () => {
    const prompt = buildContinuationLocalScriptUpdatePrompt({
      content: '冲突文件已确认采用支付工程实现',
    });
    expect(prompt.renderedPrompt).toContain('只处理以下增量信息');
    expect(prompt.renderedPrompt).not.toContain('仓库逻辑地址');
  });

  test('结果 Schema 拒绝多余部署字段和空摘要', () => {
    expect(
      LocalScriptUpdateExecutionResultSchema.safeParse({
        outcome: 'COMPLETED',
        summary: '完成',
        provider: 'custom',
      }).success,
    ).toBe(false);
    expect(
      LocalScriptUpdateExecutionResultSchema.safeParse({
        outcome: 'FAILED',
        summary: '',
      }).success,
    ).toBe(false);
  });
});
