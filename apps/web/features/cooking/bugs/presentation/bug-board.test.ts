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
  });

  test('卡片保留六阶段语义色与进行中呼吸效果', async () => {
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
    expect(css).toContain("[data-stage='REPAIRING']");
    expect(css).toContain("[data-stage='UPDATING']");
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('等待用户和执行异常覆盖阶段呼吸色并引导查看详情', async () => {
    const [source, css] = await Promise.all([
      readFile(bugBoardPath, 'utf8'),
      readFile(cookingCssPath, 'utf8'),
    ]);
    expect(source).toContain('data-visual-state={visual.state ?? undefined}');
    expect(source).toContain('collab-bug-card__attention');
    expect(css).toContain("[data-visual-state='attention']");
    expect(css).toContain("[data-visual-state='failed']");
    expect(css).toContain('--bug-stage-color: var(--warning)');
    expect(css).toContain('--bug-stage-color: var(--danger)');
    expect(css).toContain('animation: none');
  });
});
