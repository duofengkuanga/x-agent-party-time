import type { Activity, Finding, ObservationPhase, ObservationReport } from './schema';

export const activityLabels: Record<Activity, string> = {
  read: '读取',
  search: '检索',
  edit: '编辑',
  test: '测试',
  typecheck: '类型检查',
  lint: '静态检查',
  build: '构建',
  install: '依赖准备',
  'git.inspect': 'Git 检查',
  'git.integrate': '集成',
  'git.commit': '提交',
  'git.push': '推送',
  deploy: '部署',
  message: '可见输出',
  mixed: '混合活动',
  unknown: '未识别活动',
};
export const phaseLabels: Record<ObservationPhase, string> = {
  local_wait: '本机等待',
  workspace: '工作区准备',
  attachments: '附件处理',
  skill: '规则包解析',
  baseline: '结果基线',
  startup: '执行服务启动',
  session: '会话准备',
  turn_start: '调用启动',
  turn: 'Codex 调用窗口',
  shutdown: '执行服务关闭',
  validation: '结果校验',
  delivery: '结果回传',
  synchronization: '只读同步',
};
export const findingLabels: Record<Finding['kind'], string> = {
  cost_contributor: '本轮耗时大项',
  repeated_invocation: '已观察到多次调用',
  potential_duplicate_work: '疑似重复工作',
  unassigned_interval: '尚未归因的时间',
  attribution_limited: '归因能力受限',
};
export const effortLabels = {
  none: '无',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  ultra: '极高',
};
export const classificationLabels = {
  observed: '直接命令分类',
  static_definition: '静态脚本推断',
  source_reported: '来源报告',
  unknown: '分类依据未知',
};
export const evidenceLabels: Record<Finding['strength'], string> = {
  observed: '直接观察',
  source_reported: '来源报告',
  inferred: '规则推断',
  unknown: '证据不足',
  conflict: '证据冲突',
};
export const missingLabels: Record<Finding['missing'][number], string> = {
  equivalent_inputs: '尚未核验输入等价',
  coverage: '尚未核验检查覆盖',
  phase_requirements: '尚未核验阶段要求',
  interval: '缺少可定位区间',
  source_support: '来源观测能力有限',
};
export const issueLabels: Record<ObservationReport['issues'][number], string> = {
  conflict: '记录存在冲突',
  missing_boundary: '部分活动缺少边界',
  recording_gap: '存在记录缺口',
  unrecognized: '部分来源无法识别',
  clock_unknown: '时钟是否包含休眠尚未确认',
  budget: '明细受容量或处理预算限制',
};

export function formatObservationDuration(value: number | null): string {
  if (value === null) return '无法确认';
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} 秒`;
  return `${Math.floor(value / 60_000)} 分 ${Math.floor((value % 60_000) / 1000)} 秒`;
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_[\]<>|#]/gu, '\\$&').replace(/[\r\n]/gu, ' ');
}

export function observationMarkdown(
  report: ObservationReport,
  options: { detailAvailable: boolean; summaryOnly: boolean; generatedAt: string },
): string {
  const lines = [
    '# 本轮耗时分析',
    '',
    `报告：${report.reportId}`,
    `执行：${report.executionId}`,
    `版本：${report.revision} · 规则版本：${report.ruleVersion}`,
    `数据截止：${report.calculatedAt}`,
    `生成时间：${options.generatedAt}（UTC）`,
    '',
    `本轮观测历时：${formatObservationDuration(report.totalMs)}`,
    `总历时：${report.envelopeQuality === 'complete' ? '端点完整' : report.envelopeQuality === 'fragmented' ? '跨片段，无法确认整体历时' : report.envelopeQuality === 'conflict' ? '存在冲突' : '尚未封闭'}`,
    '活动归因：部分可用；工具外时间不能直接认定为模型思考。',
    '',
    '## 记录片段',
    '',
    '| 片段 | 已定位工具历时 | 同层工具累计 | 已定位交互 | 重叠 | 未定位两者 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const segment of report.segments)
    lines.push(
      `| ${segment.id} | ${formatObservationDuration(segment.toolMs)} | ${formatObservationDuration(segment.cumulativeToolMs)} | ${formatObservationDuration(segment.interactionMs)} | ${formatObservationDuration(segment.overlapMs)} | ${formatObservationDuration(segment.unassignedMs)} |`,
    );
  lines.push(
    '',
    '工具与交互允许重叠，两列不能直接相加。跨片段不默认合计。',
    '',
    '## 诊断与证据',
    '',
  );
  for (const finding of report.findings) {
    lines.push(
      `- ${findingLabels[finding.kind]}${finding.activity ? `：${activityLabels[finding.activity]}` : ''}（${evidenceLabels[finding.strength]}）`,
    );
    if (finding.durationMs !== null)
      lines.push(`  - 已知时长：${formatObservationDuration(finding.durationMs)}`);
    lines.push('  - 可省略性尚未确认；节省时长未知。');
    for (const missing of finding.missing) lines.push(`  - ${missingLabels[missing]}`);
    if (finding.evidence.length)
      lines.push(`  - 安全证据引用：${finding.evidence.join('、')}`);
  }
  if (!report.findings.length) lines.push('暂无可确认的诊断，不表示没有性能问题。');
  lines.push('', '## 限制', '');
  for (const issue of report.issues) lines.push(`- ${issueLabels[issue]}`);
  if (!options.detailAvailable) lines.push('- 时间线明细已过期或不可用，仅保留摘要。');
  if (options.summaryOnly) lines.push('- 本次显式导出摘要，不包含时间线明细。');
  if (!options.summaryOnly && options.detailAvailable) {
    lines.push(
      '',
      '## 可定位活动',
      '',
      '| 片段 | 活动 | 相对开始（毫秒） | 相对结束（毫秒） |',
      '| --- | --- | ---: | ---: |',
    );
    for (const interval of report.intervals)
      lines.push(
        `| ${interval.segmentId} | ${markdownText(interval.phase ? phaseLabels[interval.phase] : activityLabels[interval.activity])} | ${interval.startMs} | ${interval.endMs} |`,
      );
    for (const entry of report.incompleteActivities)
      lines.push(
        `- ${entry.phase ? phaseLabels[entry.phase] : activityLabels[entry.activity]}：${entry.boundary === 'start_only' ? '缺少结束' : entry.boundary === 'end_only' ? '缺少开始' : '边界冲突'}；下界 ${formatObservationDuration(entry.lowerMs)}、上界 ${formatObservationDuration(entry.upperMs)}。`,
      );
    if (report.unplaced.length) {
      lines.push('', '## 来源报告时长（位置未确认）', '');
      for (const entry of report.unplaced)
        lines.push(
          `- ${activityLabels[entry.activity]}：${formatObservationDuration(entry.durationMs)}；未从总历时扣除。`,
        );
    }
  }
  lines.push('', '## 配置与观测能力', '');
  for (const configuration of report.configurations)
    lines.push(
      `- 片段 ${configuration.segmentId}：${markdownText(JSON.stringify(configuration.value))}`,
    );
  for (const usage of report.usages)
    lines.push(
      `- 来源用量（${usage.value.scope === 'session' ? '会话范围' : usage.value.scope === 'turn' ? '轮次范围' : '范围未知'}，${usage.value.mode === 'cumulative' ? '累计快照，不跨快照相加' : usage.value.mode === 'delta' ? '增量' : '计数语义未知'}）：输入 ${usage.value.inputTokens ?? '未知'}，输出 ${usage.value.outputTokens ?? '未知'}，缓存读取 ${usage.value.cachedInputTokens ?? '未知'}，缓存写入 ${usage.value.cacheWriteInputTokens ?? '未知'}。`,
    );
  lines.push(
    '',
    `输入覆盖：${report.inputDigest} · ${report.eventCount} 条输入事实`,
    '本报告仅含安全投影；不包含原始命令、输出、本机路径或私有推理。证据引用不代表网页能够读取本机原文。',
    '',
  );
  return lines.join('\n');
}
