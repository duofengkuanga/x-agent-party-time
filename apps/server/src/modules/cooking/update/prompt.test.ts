import { describe, expect, test } from 'bun:test';
import {
  CiCdUpdateExecutionResultSchema,
  CiCdUpdateOutputJsonSchema,
  LocalScriptUpdateExecutionResultSchema,
  LocalScriptUpdateOutputJsonSchema,
} from './contract';
import {
  CI_CD_UPDATE_PROMPT_KIND,
  CI_CD_UPDATE_PROMPT_VERSION,
  LOCAL_SCRIPT_UPDATE_PROMPT_KIND,
  LOCAL_SCRIPT_UPDATE_PROMPT_VERSION,
  buildContinuationCiCdUpdatePrompt,
  buildContinuationLocalScriptUpdatePrompt,
  buildInitialCiCdUpdatePrompt,
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

  test('LOCAL_SCRIPT 与 CI/CD 输出 Schema 都是无 oneOf 的根对象', () => {
    for (const schema of [
      LocalScriptUpdateOutputJsonSchema,
      CiCdUpdateOutputJsonSchema,
    ]) {
      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['outcome', 'summary'],
      });
      expect(JSON.stringify(schema)).not.toContain('"oneOf"');
    }
  });

  test('CI/CD Prompt 只把普通 Push 解释为 PUSHED，并以失败报告增量继续', () => {
    const initial = buildInitialCiCdUpdatePrompt({
      workspaceKey: 'update-batch:ci',
      submissionTitle: '支付提测',
      engineeringName: '支付工程',
      repositoryUrl: 'https://example.com/payment.git',
      targetBranch: 'main',
      environmentName: 'CI 测试环境',
      entries: [
        { bugShortId: 3, bugTitle: '流水线失败', commits: ['ccccccc'] },
      ],
    });
    expect(initial).toMatchObject({
      kind: CI_CD_UPDATE_PROMPT_KIND,
      version: CI_CD_UPDATE_PROMPT_VERSION,
      outputJsonSchema: CiCdUpdateOutputJsonSchema,
    });
    expect(initial.renderedPrompt).toContain('PUSHED 不代表 Pipeline');
    expect(initial.renderedPrompt).not.toContain('LOCAL_SCRIPT：');
    const continuation = buildContinuationCiCdUpdatePrompt({
      reportRound: 2,
      summary: '部署健康检查失败',
      attachmentNames: ['pipeline.txt'],
    });
    expect(continuation.renderedPrompt).toContain('第 2 轮外部部署失败');
    expect(continuation.renderedPrompt).toContain('pipeline.txt');
    expect(continuation.renderedPrompt).not.toContain('仓库逻辑地址');
    expect(
      CiCdUpdateExecutionResultSchema.safeParse({
        outcome: 'COMPLETED',
        summary: '不能伪装部署完成',
      }).success,
    ).toBe(false);
  });
});
