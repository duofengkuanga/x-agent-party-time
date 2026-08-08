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
  buildInitialCiCdUpdatePrompt,
  buildInitialLocalScriptUpdatePrompt,
  buildRetryCiCdUpdatePrompt,
  buildRetryLocalScriptUpdatePrompt,
} from './prompt';

describe('Update Prompt', () => {
  test('初始 LOCAL_SCRIPT Prompt 固定冻结顺序并要求结构化结果', () => {
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
    expect(prompt.renderedPrompt).toContain(
      'Detached HEAD Integration Worktree',
    );
    expect(prompt.renderedPrompt).toContain('completedActions');
    expect(prompt.renderedPrompt.indexOf('bbbbbbb')).toBeLessThan(
      prompt.renderedPrompt.indexOf('aaaaaaa'),
    );
    expect(prompt.renderedPromptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('失败后无输入重试并继续原 Session 语义', () => {
    const local = buildRetryLocalScriptUpdatePrompt();
    const ci = buildRetryCiCdUpdatePrompt();
    for (const prompt of [local, ci]) {
      expect(prompt.renderedPrompt).toContain('上一轮结构化失败结果');
      expect(prompt.renderedPrompt).toContain(
        '冻结的缺陷、Commit、顺序、分支和环境保持不变',
      );
      expect(prompt.renderedPrompt).toContain('跳过浏览器验证');
      expect(prompt.renderedPrompt).not.toContain('只处理以下增量信息');
    }
  });

  test('结构化结果覆盖成功、Push、失败和格式无效', () => {
    expect(
      LocalScriptUpdateExecutionResultSchema.safeParse({
        outcome: 'COMPLETED',
        summary: '完成',
        completedActions: ['普通 Push', '运行部署脚本'],
        validations: [{ name: '类型检查', status: 'PASSED', detail: null }],
        warnings: [],
        failedStep: null,
        reason: null,
        pendingActions: [],
      }).success,
    ).toBe(true);
    expect(
      CiCdUpdateExecutionResultSchema.safeParse({
        outcome: 'PUSHED',
        summary: '已推送',
        completedActions: ['普通 Push'],
        validations: [],
        warnings: ['等待流水线'],
        failedStep: null,
        reason: null,
        pendingActions: [],
      }).success,
    ).toBe(true);
    expect(
      LocalScriptUpdateExecutionResultSchema.safeParse({
        outcome: 'FAILED',
        summary: '部署失败',
        completedActions: ['完成集成'],
        validations: [],
        warnings: [],
        failedStep: '运行部署脚本',
        reason: '退出码为 1',
        pendingActions: ['修复部署配置'],
      }).success,
    ).toBe(true);
    expect(
      LocalScriptUpdateExecutionResultSchema.safeParse({
        outcome: 'FAILED',
        summary: '缺少结构化字段',
      }).success,
    ).toBe(false);
  });

  test('输出 Schema 使用单一根对象并强制所有结构化槽位', () => {
    for (const schema of [
      LocalScriptUpdateOutputJsonSchema,
      CiCdUpdateOutputJsonSchema,
    ]) {
      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: [
          'outcome',
          'summary',
          'completedActions',
          'validations',
          'warnings',
          'failedStep',
          'reason',
          'pendingActions',
        ],
      });
      expect(JSON.stringify(schema)).not.toContain('"oneOf"');
    }
  });

  test('CI/CD 只把普通 Push 解释为 PUSHED，并携带外部失败证据继续', () => {
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
    const continuation = buildContinuationCiCdUpdatePrompt({
      reportRound: 2,
      summary: '部署健康检查失败',
      attachmentNames: ['pipeline.txt'],
    });
    expect(continuation.renderedPrompt).toContain('第 2 轮外部部署失败');
    expect(continuation.renderedPrompt).toContain('跳过浏览器验证');
    expect(continuation.renderedPrompt).toContain('pipeline.txt');
    expect(continuation.renderedPrompt).not.toContain('仓库逻辑地址');
  });
});
