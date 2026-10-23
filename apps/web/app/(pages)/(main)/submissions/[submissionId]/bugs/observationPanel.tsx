'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ObservationReportSchema,
  activityLabels,
  evidenceLabels,
  findingLabels,
  formatObservationDuration,
  issueLabels,
  missingLabels,
  effortLabels,
  classificationLabels,
  phaseLabels,
  type ObservationReport,
} from '@agent-party-time/execution-contract/observability';

const SnapshotSchema = z.strictObject({
  report: ObservationReportSchema.nullable(),
  detailAvailable: z.boolean(),
  storedEventCount: z.number().int().nonnegative(),
});
const MetadataSchema = z.strictObject({
  reportId: z.uuid().nullable(),
  revision: z.number().int().nullable(),
  detailAvailable: z.boolean(),
  available: z.boolean(),
  receivedAt: z.iso.datetime().nullable(),
});
type Snapshot = z.infer<typeof SnapshotSchema>;
const statusLabels = {
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  interrupted: '中断',
  handed_off: '人工接管',
  unknown: '结果未确认',
};

function totalLabel(report: ObservationReport): string {
  if (report.totalMs !== null)
    return `本轮观测历时 ${formatObservationDuration(report.totalMs)}`;
  if (report.envelopeQuality === 'fragmented')
    return '分片段记录，整体历时无法确认';
  if (report.envelopeQuality === 'conflict')
    return '记录存在冲突，整体历时无法确认';
  return '观测尚未封闭，整体历时无法确认';
}

export function ObservationPanel({
  executionId,
  onSummary,
}: {
  executionId: string;
  onSummary: (value: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newReportId, setNewReportId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const current = useRef<Snapshot | null>(null);
  const reading = useRef<AbortController | null>(null);
  const downloading = useRef<AbortController | null>(null);
  const forbidden = useRef(false);
  const endpoint = `/api/submissions/executions/${encodeURIComponent(executionId)}/observations`;
  const clearPrivate = useCallback(() => {
    reading.current?.abort();
    downloading.current?.abort();
    setLoading(false);
    setError('报告版本不可用或当前无权读取。');
    current.current = null;
    setSnapshot(null);
    setNewReportId(null);
    forbidden.current = true;
    onSummary('当前报告不可访问或已过期');
  }, [onSummary]);

  const load = useCallback(
    async (reportId?: string) => {
      reading.current?.abort();
      const controller = new AbortController();
      reading.current = controller;
      forbidden.current = false;
      setLoading(true);
      setError(null);
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 20_000);
      try {
        const response = await fetch(
          `${endpoint}${reportId ? `?reportId=${encodeURIComponent(reportId)}` : ''}`,
          { cache: 'no-store', signal: controller.signal },
        );
        if ([401, 403, 404].includes(response.status)) {
          clearPrivate();
          throw new Error('报告版本不可用或当前无权读取。');
        }
        if (!response.ok)
          throw new Error('读取失败，请重试；业务执行结果不受影响。');
        const value = SnapshotSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        current.current = value;
        setSnapshot(value);
        setNewReportId(null);
        setPage(0);
        onSummary(value.report ? totalLabel(value.report) : '本轮暂无耗时记录');
      } catch (caught) {
        if (timedOut) setError('读取超时，请重试。');
        else if (!controller.signal.aborted)
          setError(
            caught instanceof Error && caught.message.startsWith('报告版本')
              ? caught.message
              : '暂时无法读取耗时分析，请重试。',
          );
      } finally {
        window.clearTimeout(timeout);
        if (!controller.signal.aborted || timedOut) setLoading(false);
      }
    },
    [endpoint, clearPrivate, onSummary],
  );

  useEffect(() => {
    void load();
    return () => {
      reading.current?.abort();
      downloading.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const openedAt = Date.now();
    let lastCheck = 0;
    let pending = false;
    let failures = 0;
    const controller = new AbortController();
    const check = async () => {
      const report = current.current?.report;
      if (
        pending ||
        forbidden.current ||
        controller.signal.aborted ||
        document.visibilityState === 'hidden' ||
        (report?.sealed && !newReportId)
      )
        return;
      const interval = Math.min(
        60_000,
        (Date.now() - openedAt > 120_000 ? 30_000 : 5000) *
          2 ** Math.min(failures, 3),
      );
      if (Date.now() - lastCheck < interval) return;
      lastCheck = Date.now();
      pending = true;
      try {
        const response = await fetch(`${endpoint}?mode=metadata`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if ([401, 403, 404].includes(response.status)) {
          clearPrivate();
          setError('当前无权读取耗时分析。');
          return;
        }
        if (!response.ok) {
          failures++;
          return;
        }
        const value = MetadataSchema.parse(await response.json());
        failures = 0;
        if (
          value.reportId &&
          value.reportId !== current.current?.report?.reportId
        )
          setNewReportId(value.reportId);
      } catch {
        if (!controller.signal.aborted) failures++;
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(() => {
      void check();
    }, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [endpoint, clearPrivate, newReportId]);

  const exportReport = async (format: 'md' | 'json', summaryOnly = false) => {
    const report = current.current?.report;
    if (!report || exporting) return;
    const controller = new AbortController();
    downloading.current = controller;
    setExporting(true);
    setError(null);
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    try {
      const query = new URLSearchParams({
        reportId: report.reportId,
        format,
        ...(summaryOnly ? { summary: '1' } : {}),
      });
      const response = await fetch(`${endpoint}?${query}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if ([401, 403, 404].includes(response.status)) {
        clearPrivate();
        throw new Error('不可访问');
      }
      if (response.status === 413) {
        setError('报告明细超过预算，请选择仅导出摘要。');
        return;
      }
      if (!response.ok) throw new Error('下载失败');
      const blob = await response.blob();
      if (controller.signal.aborted || forbidden.current) return;
      if (blob.size > 2 * 1024 * 1024) throw new Error('下载文件超过预算');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `xapt-timing-${report.reportId}.${format}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (timedOut) setError('导出超时，请重试。');
      else if (!controller.signal.aborted)
        setError('导出失败，请重试读取或更新报告版本。');
    } finally {
      window.clearTimeout(timeout);
      setExporting(false);
    }
  };

  const report = snapshot?.report;
  const intervals = report?.intervals.slice(page * 50, (page + 1) * 50) ?? [];
  return (
    <div className="collab-observation__panel" aria-busy={loading}>
      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p role="status">正在读取耗时记录…</p> : null}
      {!loading && !report ? (
        <p>
          本轮暂无可用耗时记录。旧执行或不支持的来源可能没有记录，不能据此认定耗时为零。
        </p>
      ) : null}
      {newReportId ? (
        <div className="collab-observation__update" role="status">
          有新耗时记录{' '}
          <button type="button" onClick={() => void load(newReportId)}>
            更新数据
          </button>
        </div>
      ) : null}
      {!loading && !forbidden.current ? (
        <button type="button" onClick={() => void load()}>
          重新读取最新记录
        </button>
      ) : null}
      {report ? (
        <>
          <div className="collab-observation__summary">
            <strong>{totalLabel(report)}</strong>
            <span>
              {report.envelopeQuality === 'complete'
                ? '总历时端点完整'
                : '总历时未完整确认'}{' '}
              · 活动归因部分可用
            </span>
            <span>
              数据截止：{new Date(report.calculatedAt).toLocaleString()} ·
              报告版本 {report.revision}
            </span>
            <p>
              从本机收到执行到收到终态接受证据。服务端排队另计，工具外时间不能直接认定为模型思考。
            </p>
          </div>
          <p>
            本机报告引用 {report.eventCount} 条事实；服务端当前保留{' '}
            {snapshot.storedEventCount}{' '}
            条安全事实。事实可能分批到达，服务端未独立复算，不能据此认定证据齐全。
          </p>
          {!snapshot.detailAvailable ? (
            <p>摘要可用，时间线明细已过期或不可用。</p>
          ) : null}
          <section aria-label="耗时分区">
            <h5>记录片段与耗时分区</h5>
            <p>
              工具和交互允许重叠，两列不能直接相加。跨片段不默认合计。工具累计只加完整、互不为祖先的外层活动，并行会相加，与历时分开。
            </p>
            <div className="collab-observation__table">
              <table>
                <thead>
                  <tr>
                    <th>片段</th>
                    <th>仅已定位工具</th>
                    <th>仅已定位交互</th>
                    <th>工具与交互重叠</th>
                    <th>两者均未定位</th>
                  </tr>
                </thead>
                <tbody>
                  {report.segments.map((segment, i) => (
                    <tr key={segment.id}>
                      <th>
                        片段 {i + 1}
                        {segment.hasGap ? '（有缺口）' : ''}
                      </th>
                      <td>
                        {formatObservationDuration(
                          segment.toolMs - segment.overlapMs,
                        )}
                      </td>
                      <td>
                        {formatObservationDuration(
                          segment.interactionMs - segment.overlapMs,
                        )}
                      </td>
                      <td>{formatObservationDuration(segment.overlapMs)}</td>
                      <td>{formatObservationDuration(segment.unassignedMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <p>
            已定位同层工具累计：
            {report.segments
              .map(
                (segment, i) =>
                  `片段 ${i + 1} ${formatObservationDuration(segment.cumulativeToolMs)}`,
              )
              .join('；')}
            。此值仅覆盖完整活动，缺失活动不能按零耗时理解。
          </p>
          {report.issues.length ? (
            <ul>
              {report.issues.map((issue) => (
                <li key={issue}>{issueLabels[issue]}</li>
              ))}
            </ul>
          ) : null}
          <section aria-label="诊断与证据">
            <h5>诊断与证据</h5>
            {!report.findings.length ? (
              <p>暂无可确认的诊断，不表示没有性能问题。</p>
            ) : null}
            {report.findings.map((finding) => (
              <details className="collab-observation__finding" key={finding.id}>
                <summary>
                  {findingLabels[finding.kind]}
                  {finding.activity
                    ? `：${activityLabels[finding.activity]}`
                    : ''}{' '}
                  · {evidenceLabels[finding.strength]}
                </summary>
                {finding.durationMs !== null ? (
                  <p>
                    已知时长：{formatObservationDuration(finding.durationMs)}
                  </p>
                ) : null}
                <p>工作等价与可省略性需要独立核验，节省时长尚未证实。</p>
                {finding.missing.length ? (
                  <ul>
                    {finding.missing.map((item) => (
                      <li key={item}>{missingLabels[item]}</li>
                    ))}
                  </ul>
                ) : null}
                {finding.evidence.length ? (
                  <p className="collab-observation__ids">
                    安全证据引用：{finding.evidence.join('、')}
                  </p>
                ) : null}
                <p>引用用于关联安全记录，不是本机原文下载链接。</p>
              </details>
            ))}
          </section>
          <section aria-label="活动时间线">
            <h5>活动时间线</h5>
            <p>
              下列均为同一片段内的接收端观察区间；片段间的空白历时无法确认。
            </p>
            <div className="collab-observation__table">
              <table>
                <thead>
                  <tr>
                    <th>片段</th>
                    <th>活动</th>
                    <th>相对开始</th>
                    <th>相对结束</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {intervals.map((entry) => (
                    <tr
                      key={`${entry.segmentId}:${entry.id}:${entry.evidence[0]}`}
                    >
                      <td>
                        片段{' '}
                        {report.segments.findIndex(
                          (s) => s.id === entry.segmentId,
                        ) + 1}
                      </td>
                      <td>
                        {entry.phase
                          ? phaseLabels[entry.phase]
                          : activityLabels[entry.activity]}
                        （{classificationLabels[entry.classificationBasis]}）
                      </td>
                      <td>{formatObservationDuration(entry.startMs)}</td>
                      <td>{formatObservationDuration(entry.endMs)}</td>
                      <td>{statusLabels[entry.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.incompleteActivities.length ? (
              <details>
                <summary>
                  边界不完整的活动（{report.incompleteActivities.length} 条）
                </summary>
                <ul>
                  {report.incompleteActivities.slice(0, 50).map((entry) => (
                    <li key={entry.eventId}>
                      {entry.phase
                        ? phaseLabels[entry.phase]
                        : activityLabels[entry.activity]}
                      ：
                      {entry.boundary === 'start_only'
                        ? '缺少结束'
                        : entry.boundary === 'end_only'
                          ? '缺少开始'
                          : '边界冲突'}
                      ；下界 {formatObservationDuration(entry.lowerMs)}，上界{' '}
                      {formatObservationDuration(entry.upperMs)}。
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {!report.intervals.length ? (
              <p>暂无可定位的完整活动区间。</p>
            ) : null}
            {report.intervals.length > 50 ? (
              <div className="collab-observation__toolbar">
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage((n) => n - 1)}
                >
                  上一页
                </button>
                <span>
                  第 {page + 1} 页 · 共 {report.intervals.length}{' '}
                  条；概况仍为本轮全部输入范围
                </span>
                <button
                  type="button"
                  disabled={(page + 1) * 50 >= report.intervals.length}
                  onClick={() => setPage((n) => n + 1)}
                >
                  下一页
                </button>
              </div>
            ) : null}
            {report.unplaced.length ? (
              <details>
                <summary>
                  来源报告时长，位置未确认（{report.unplaced.length} 条）
                </summary>
                <ul>
                  {report.unplaced.slice(0, 50).map((entry) => (
                    <li key={entry.eventId}>
                      {activityLabels[entry.activity]}：
                      {formatObservationDuration(entry.durationMs)}
                      ；未从总历时扣除。
                    </li>
                  ))}
                </ul>
                {report.unplaced.length > 50 ? (
                  <p>此处列出前 50 条，导出报告保留预算内全部可用明细。</p>
                ) : null}
              </details>
            ) : null}
          </section>
          <div
            className="collab-observation__toolbar"
            aria-label="导出所见报告"
          >
            <button
              type="button"
              disabled={exporting}
              onClick={() => void exportReport('md')}
            >
              {exporting ? '正在导出…' : '导出阅读版报告'}
            </button>
            <button
              type="button"
              disabled={exporting}
              onClick={() => void exportReport('json')}
            >
              导出结构化报告
            </button>
            <button
              type="button"
              disabled={exporting}
              onClick={() => void exportReport('md', true)}
            >
              仅导出摘要
            </button>
          </div>
          <details>
            <summary>配置、版本与观测能力</summary>
            <p>
              输入事实 {report.eventCount} 条 · 规则版本 {report.ruleVersion} ·
              输入覆盖 {report.inputDigest}
            </p>
            {report.configurations.map((configuration, i) => (
              <p key={`${configuration.segmentId}:${i}`}>
                片段{' '}
                {report.segments.findIndex(
                  (s) => s.id === configuration.segmentId,
                ) + 1}
                ： 实际模型 {configuration.value.effectiveModel ?? '未观测'} ·
                实际推理档位{' '}
                {configuration.value.effectiveEffort
                  ? effortLabels[configuration.value.effectiveEffort]
                  : '未观测'}{' '}
                · Codex 版本 {configuration.value.codexVersion ?? '未观测'} ·
                xapt {configuration.value.xaptVersion ?? '未观测'}
              </p>
            ))}
            {report.usages.map((usage, i) => (
              <p key={i}>
                来源用量：
                {usage.value.scope === 'session'
                  ? '会话范围'
                  : usage.value.scope === 'turn'
                    ? '轮次范围'
                    : '范围未知'}{' '}
                ·{' '}
                {usage.value.mode === 'cumulative'
                  ? '累计快照，不跨快照相加'
                  : usage.value.mode === 'delta'
                    ? '增量'
                    : '计数语义未知'}
                ；输入 {usage.value.inputTokens ?? '未知'}，输出{' '}
                {usage.value.outputTokens ?? '未知'}，缓存读取{' '}
                {usage.value.cachedInputTokens ?? '未知'}，缓存写入{' '}
                {usage.value.cacheWriteInputTokens ?? '未知'}。
              </p>
            ))}
            <p>当前未提供强制只读的模型分析入口，确定性归因不额外调用模型。</p>
          </details>
        </>
      ) : null}
    </div>
  );
}
