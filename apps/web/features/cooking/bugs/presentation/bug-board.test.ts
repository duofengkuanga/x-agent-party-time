import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const bugBoardPath = new URL('./bug-board.tsx', import.meta.url);
const cookingCssPath = new URL(
  '../../../../app/cooking/cooking.css',
  import.meta.url,
);

describe('缺陷看板展示', () => {
  test('只按当前提测快照分组展示名称和稳定标识', async () => {
    const source = await readFile(bugBoardPath, 'utf8');
    expect(source).toContain("engineering.type === 'FRONTEND'");
    expect(source).toContain("engineering.type === 'BACKEND'");
    expect(source).toContain('<option value="">暂不确定</option>');
    expect(source).toContain('<optgroup label="前端">');
    expect(source).toContain('<optgroup label="后端">');
    expect(source).toContain(
      '{item.engineering.name}（{item.engineering.identifier}）',
    );
    expect(source).toContain('value={item.id}');
    expect(source).not.toContain('item.engineering.id}');
    expect(source).not.toContain('全局修复队列');
    expect(source).not.toContain('reorderRepairQueueAction');
  });

  test('卡片保留六阶段语义色，只有服务端 RUNNING 状态呼吸', async () => {
    const [source, css] = await Promise.all([
      readFile(bugBoardPath, 'utf8'),
      readFile(cookingCssPath, 'utf8'),
    ]);
    expect(source).toContain('data-stage={bug.stage}');
    for (const [stage, color] of [
      ['WAITING_FOR_REPAIR', 'var(--accent-dark)'],
      ['REPAIRING', 'var(--accent)'],
      ['WAITING_FOR_UPDATE', 'var(--olive)'],
      ['UPDATING', 'var(--blue)'],
      ['WAITING_FOR_VERIFICATION', 'var(--warning)'],
      ['DONE', 'var(--success)'],
    ]) {
      const selector = `.collab-bug-card[data-stage='${stage}']`;
      expect(css).toContain(selector);
      expect(css.split(selector)[1]?.split('}')[0]).toContain(color);
    }
    expect(css).toContain('@keyframes collab-bug-card-breathe');
    expect(css).toContain("[data-visual-state='RUNNING']");
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('卡片直接渲染唯一服务端状态的文字、符号和 ARIA', async () => {
    const [source, css] = await Promise.all([
      readFile(bugBoardPath, 'utf8'),
      readFile(cookingCssPath, 'utf8'),
    ]);
    expect(source).toContain('data-visual-state={visual.state}');
    expect(source).toContain(
      'aria-label={`${bugLabel(bug)}，${visual.label}`}',
    );
    expect(source).toContain('{visual.symbol}');
    expect(source).toContain('collab-bug-card__attention');
    expect(source).toContain('collab-current-visual');
    expect(source).toContain('permissionSummary');
    expect(source).toContain('item.map(valueLabel)');
    expect(source).toContain('interaction.canResolve');
    expect(source).not.toContain('JSON.stringify(request.permissions)');
    for (const state of [
      'NEEDS_APPROVAL',
      'NEEDS_INPUT',
      'FAILED',
      'WAITING_TO_RESUME',
      'QUEUED_FOR_ENGINEERING',
      'IDLE',
    ]) {
      expect(css).toContain(`[data-visual-state='${state}']`);
    }
    expect(css).toContain('--bug-stage-color: var(--warning)');
    expect(css).toContain('--bug-stage-color: var(--danger)');
    expect(css.split("[data-visual-state='IDLE']")[1]?.split('}')[0]).toContain(
      '--bug-stage-color: var(--ink)',
    );
    expect(css).toContain('animation: none');
  });

  test('原生 Interaction 保留三种审批决定和问题选项结构', async () => {
    const source = await readFile(bugBoardPath, 'utf8');
    expect(source).toContain('仅允许这一次');
    expect(source).toContain('本次会话允许');
    expect(source).toContain('data-primary="true"');
    expect(source).toContain('{option.label}');
    expect(source).toContain('{option.description}');
    expect(source).toContain('自定义回答');
    expect(source).toContain('统一提交回答');
    expect(source).toContain('interaction.resolution?.answers');
    expect(source).not.toContain('waitingForInteraction');
    expect(source).not.toContain('queuePosition');
  });

  test('详情默认展示旧到新的结构化进展并隔离冻结报告', async () => {
    const [source, css] = await Promise.all([
      readFile(bugBoardPath, 'utf8'),
      readFile(cookingCssPath, 'utf8'),
    ]);
    expect(source).toMatch(
      /useState<'progress' \| 'report'>\(\s*'progress',?\s*\)/u,
    );
    expect(source).toContain('aria-label="缺陷详情视图"');
    expect(source).toContain('进展');
    expect(source).toContain('缺陷资料');
    expect(source).toContain("node.kind === 'BUG_REGISTERED'");
    expect(source).toContain('data-node-kind={node.kind}');
    expect(source).toContain("node.result.outcome === 'COMPLETED'");
    expect(source).toContain('重新执行修复');
    expect(source).toContain("scrollIntoView({ block: 'nearest' })");
    expect(source).toContain('原始报告已永久冻结');
    expect(source).not.toContain('补充信息并在原修复会话中继续');
    expect(css).toContain('.collab-bug-detail-hero');
    expect(css).toContain('position: sticky');
    expect(css).toContain('.collab-bug-drawer__body');
    expect(css).toContain('scrollbar-width: none');
  });
});
