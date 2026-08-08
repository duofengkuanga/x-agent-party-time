import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const bugBoardPath = new URL('./bug-board.tsx', import.meta.url);
const cookingCssPath = new URL(
  '../../../../app/cooking/cooking.css',
  import.meta.url,
);
const submissionWorkspacePath = new URL(
  '../../submissions/presentation/submission-workspace.tsx',
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

  test('卡片不展示内部缺陷编号，并允许摘要内容换行', async () => {
    const [source, css] = await Promise.all([
      readFile(bugBoardPath, 'utf8'),
      readFile(cookingCssPath, 'utf8'),
    ]);
    expect(source).toContain(
      '<small>{bug.presentation.assignmentLabel}</small>',
    );
    expect(source).not.toContain(
      '{bugLabel(bug)} · {bug.presentation.assignmentLabel}',
    );
    expect(css).toContain('grid-row: 1 / -1;');
    expect(css).toContain('min-width: 0;');
    expect(css).toContain('overflow-wrap: anywhere;');
  });

  test('更新中列只渲染共享批次卡并从 Bug 摘要进入同一详情', async () => {
    const source = await readFile(bugBoardPath, 'utf8');
    expect(source).toContain('batches.map((batch)');
    expect(source).toContain('统一更新批次 · {batch.entries.length} 条缺陷');
    expect(source).toContain("batches.length.toString().padStart(2, '0')");
    expect(source).not.toContain('个批次 · ${bugs.length} 条缺陷');
    expect(source).toContain('查看共享批次详情');
    expect(source).toContain("node.kind === 'UPDATE_ATTEMPT'");
    expect(source).toContain("batch.availableActions.includes('RETRY_UPDATE')");
    expect(source).toContain('重新执行统一更新');
    expect(source).not.toContain('补充信息并继续统一更新');
  });

  test('已取消与归档使用左右语义图标，更新列只显示批次数字', async () => {
    const source = await readFile(bugBoardPath, 'utf8');
    const css = await readFile(cookingCssPath, 'utf8');
    const cancelled = source.indexOf('collab-storage-button--cancelled');
    const title = source.indexOf(
      '{snapshot.submission.submission.title} · 缺陷看板',
    );
    const create = source.indexOf('＋ 登记缺陷');
    const archived = source.indexOf('collab-storage-button--archived');

    expect(cancelled).toBeGreaterThan(-1);
    expect(cancelled).toBeLessThan(title);
    expect(archived).toBeGreaterThan(create);
    expect(source).toContain('🗑');
    expect(source).toContain('🗄');
    expect(source).toContain("batches.length.toString().padStart(2, '0')");
    expect(css).toContain('.collab-shell .collab-storage-button--icon');
    expect(css).toContain('border: 0 !important');
    expect(css).toContain('background: transparent !important');
    expect(css).toContain('background: var(--paper) !important');
    expect(css).toContain('color: var(--ink) !important');
    expect(css).toContain(
      '.collab-shell .collab-storage-button--icon:hover > sup',
    );
    expect(css).toContain(
      ".collab-shell .collab-storage-button--icon[data-drop-target='true'] > sup",
    );
    expect(source).toContain('<sup aria-hidden="true">');
    expect(css).toContain(
      '.collab-storage-button--icon:hover .collab-storage-button__glyph',
    );
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

  test('自由输入只保留在验证失败和重新打开上下文', async () => {
    const source = await readFile(bugBoardPath, 'utf8');
    expect(source).toContain('验证失败并返修');
    expect(source).toContain('重新打开');
    expect(source).toContain('已进入第 {node.repairAttempt} 轮修复');
    expect(source).toContain("node.kind === 'VERIFICATION'");
    expect(source).toContain("node.kind === 'REOPEN'");
    expect(source).not.toContain('补充反馈');
    expect(source).not.toContain('追加反馈');
    expect(source).not.toContain('ADD_FEEDBACK');
  });

  test('生命周期拖拽只保留四条合法转换且待修复卡无操作按钮', async () => {
    const [source, css] = await Promise.all([
      readFile(bugBoardPath, 'utf8'),
      readFile(cookingCssPath, 'utf8'),
    ]);
    expect(source).toContain("target === 'REPAIRING'");
    expect(source).toContain("bug.stage === 'WAITING_FOR_REPAIR'");
    expect(source).toContain("target === 'DONE'");
    expect(source).toContain("bug.stage === 'WAITING_FOR_VERIFICATION'");
    expect(source).toContain("bug.availableActions.includes('CANCEL')");
    expect(source).toContain("bug.availableActions.includes('ARCHIVE')");
    expect(source).toContain('draggingBugIdRef.current = bug.id');
    expect(source).toContain('draggedBugFrom(event)');
    expect(source).not.toContain('stopCardAction(onCancel)');
    expect(source).not.toContain('stopCardAction(onStartRepair)');
    expect(source).not.toContain('onCancel={() => cancelBug(bug)}');
    expect(source).not.toContain('onStartRepair={() =>');
    expect(source).toContain('恢复到待修复');
    expect(source).toContain('移出归档');
    expect(source).toContain('撤销');
    expect(source).not.toContain("target === 'WAITING_FOR_REPAIR'");
    expect(source).not.toContain('WITHDRAW_REPAIR');
    expect(source).not.toContain('停止当前修复');
    expect(source).not.toContain('停止统一更新');
    expect(source).not.toContain('取消更新批次');
    expect(source).toContain("data-drop-eligible={cancelDropEligible ? 'true'");
    expect(source).toContain(
      "data-drop-eligible={archiveDropEligible ? 'true'",
    );
    expect(source).toContain("cancelDropEligible ? ' is-active' : ''");
    expect(source).toContain("archiveDropEligible ? ' is-active' : ''");
    expect(source).toContain('event.dataTransfer.setDragImage');
    expect(source).toContain('collab-bug-drag-preview');
    expect(source).toContain("dragPreview.textContent = '✊';");
    expect(source).toContain('拖到这里取消');
    expect(source).toContain('拖到这里归档');
    expect(source).toContain('🖐 松开即可取消');
    expect(source).toContain('🖐 松开即可归档');
    expect(css).toContain("[data-drop-eligible='true']");
    expect(css).toContain('.collab-storage-button__drop-label');
    expect(css).toContain('.collab-bug-drag-preview');
    expect(css).toContain('font-size: 24px;');
    expect(
      css.split('.collab-bug-drag-preview')[1]?.split('}')[0],
    ).not.toContain('border:');
    expect(
      css.split('.collab-bug-drag-preview')[1]?.split('}')[0],
    ).not.toContain('box-shadow');
    expect(
      css
        .split(
          ".collab-shell .collab-storage-button--icon[data-drop-eligible='true']",
        )[1]
        ?.split('}')[0],
    ).toContain('border: 0 !important');
    expect(
      css
        .split(
          ".collab-shell .collab-storage-button--icon[data-drop-target='true']",
        )[1]
        ?.split('}')[0],
    ).toContain('box-shadow: none !important');
  });

  test('取消与归档只保留可撤销提示且临时提示三秒后关闭', async () => {
    const [source, workspaceSource] = await Promise.all([
      readFile(bugBoardPath, 'utf8'),
      readFile(submissionWorkspacePath, 'utf8'),
    ]);

    expect(source).toContain('const TRANSIENT_NOTICE_MS = 3_000;');
    expect(source).toMatch(
      /window\.setTimeout\(\s*\(\) => setUndoAction\(null\),\s*TRANSIENT_NOTICE_MS/u,
    );
    expect(source).toContain(
      'onChanged(result.result.revision, noticeMessage);',
    );
    expect(source.match(/\n\s+null,\n\s+\);/gu)).toHaveLength(2);
    expect(workspaceSource).toContain('const TRANSIENT_NOTICE_MS = 3_000;');
    expect(workspaceSource).toMatch(
      /window\.setTimeout\(\s*\(\) => setNotice\(null\),\s*TRANSIENT_NOTICE_MS/u,
    );
    expect(workspaceSource).toContain('setNotice(message);');
  });

  test('缺陷详情打开后定位到底部且登记表单按钮区保留边距', async () => {
    const [source, css] = await Promise.all([
      readFile(bugBoardPath, 'utf8'),
      readFile(cookingCssPath, 'utf8'),
    ]);

    expect(source).toContain(
      'const detailBodyRef = useRef<HTMLDivElement>(null)',
    );
    expect(source).toContain('detailBodyRef.current.scrollTop =');
    expect(source).toContain('detailBodyRef.current.scrollHeight;');
    expect(source).toContain('ref={detailBodyRef}');
    expect(css).toContain('.collab-bug-drawer__actions');
    expect(css).toContain('padding: 15px 20px 20px;');
    expect(css).toContain('position: sticky;');
    expect(css).toContain('bottom: 0;');
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
    expect(source).toContain("node.kind === 'UPDATE_BATCH'");
    expect(source).toContain("node.kind === 'CANCELLED'");
    expect(source).toContain("node.kind === 'RESTORED'");
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

  test('缺陷详情暴露 Bug ID 与复制删除命令', async () => {
    const [source, css] = await Promise.all([
      readFile(bugBoardPath, 'utf8'),
      readFile(cookingCssPath, 'utf8'),
    ]);
    expect(source).toContain('<Detail label="缺陷 ID">');
    expect(source).toContain('className="collab-bug-id"');
    expect(source).toContain('<code>{bug.id}</code>');
    expect(source).toContain('aria-label="复制删除命令"');
    expect(source).toContain('`xapt bugs delete ${bug.id}`');
    expect(source).toContain('navigator.clipboard.writeText');
    expect(source).toContain('setCopied(true)');
    expect(source).toContain("{copied ? '已复制' : '复制'}");
    expect(source).toContain('const [copied, setCopied] = useState(false)');
    expect(css).toContain('.collab-bug-id');
    expect(css).toContain('.collab-bug-id code');
    expect(css).toContain('.collab-bug-id button');
  });

  test('待统一更新展示开始更新倒计时并保留主状态文案', async () => {
    const [source, css] = await Promise.all([
      readFile(bugBoardPath, 'utf8'),
      readFile(cookingCssPath, 'utf8'),
    ]);
    expect(source).toContain('collab-bug-card__countdown');
    expect(source).toContain('<UpdateCountdown eligibleAt={eligibleAt} />');
    expect(source).toContain('{visual.label}');
    expect(source).toContain('后开始更新');
    expect(source).toContain('正在准备统一更新');
    expect(source).toMatch(/window\.setInterval\(update, 1_000\)/u);
    expect(source).toContain('window.clearInterval(timer)');
    expect(source).toContain('pendingDeliveryFor(bug, snapshot)');
    expect(source).toContain('（<UpdateCountdown eligibleAt={');
    expect(css).toContain('.collab-bug-card__countdown');
    expect(css).toContain('display: block;');
  });

  test('卡片高度自适应，两行标题不压住操作按钮', async () => {
    const css = await readFile(cookingCssPath, 'utf8');
    const cardRule = css.match(/\.collab-bug-card\s*\{([^}]*)\}/u)?.[1] ?? '';
    expect(cardRule).toContain('height: auto;');
    expect(cardRule).toContain('min-height: 132px;');
    expect(cardRule).not.toMatch(/(?<!-)height: 132px;/u);
  });
});
