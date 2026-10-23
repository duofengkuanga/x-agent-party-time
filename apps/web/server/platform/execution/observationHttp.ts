import {
  ObservationBatchSchema,
  OBSERVATION_LIMITS,
  observationMarkdown,
} from '@agent-party-time/execution-contract/observability';
import type { RunnerService } from '@/server/platform/runner/service';
import { bearerCredential } from '@/server/platform/runner/http';
import { errorResponse, normalizeRequestError } from '@/server/platform/http/responses';
import { PlatformError } from '@/server/platform/errors/index';
import type { ExecutionObservations } from './observations';
import { z } from 'zod';

export async function handleObservationUpload(
  request: Request,
  executionId: string,
  runners: Pick<RunnerService, 'authenticateCredential'>,
  observations: ExecutionObservations,
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const reader = request.body?.getReader();
    if (!reader) throw new PlatformError('VALIDATION_FAILED', '缺少归因批次');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > OBSERVATION_LIMITS.batchBytes) {
          await reader.cancel();
          throw new PlatformError('FILE_TOO_LARGE', '归因批次超过预算');
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const batch = ObservationBatchSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (batch.executionId !== executionId)
      throw new PlatformError('VALIDATION_FAILED', '归因执行关联无效');
    return Response.json(await observations.accept(runner.id, batch), {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return errorResponse(normalizeRequestError(error), '补报耗时记录');
  }
}

export function handleObservationRead(
  request: Request,
  userId: string,
  executionId: string,
  observations: ExecutionObservations,
): Response {
  try {
    z.uuid().parse(executionId);
    const query = new URL(request.url).searchParams;
    const headers = {
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    };
    if (query.get('mode') === 'metadata')
      return Response.json(observations.metadata(userId, executionId), { headers });
    const reportId = query.get('reportId');
    if (reportId) z.uuid().parse(reportId);
    const selected = observations.read(userId, executionId, reportId ?? undefined);
    const format = query.get('format');
    if (!format)
      return Response.json(
        selected ?? { report: null, detailAvailable: false, storedEventCount: 0 },
        { headers },
      );
    if (!['md', 'json'].includes(format))
      throw new PlatformError('VALIDATION_FAILED', '不支持的报告格式');
    if (!reportId || !selected)
      throw new PlatformError('NOT_FOUND', '所选报告版本已不可用，请更新数据');
    const summaryOnly = query.get('summary') === '1';
    const report = summaryOnly
      ? { ...selected.report, intervals: [], unplaced: [], incompleteActivities: [] }
      : selected.report;
    if (
      !summaryOnly &&
      report.intervals.length +
        report.unplaced.length +
        report.incompleteActivities.length >
        2000
    )
      throw new PlatformError('FILE_TOO_LARGE', '报告明细超过预算，请选择仅导出摘要');
    const generatedAt = new Date().toISOString();
    const body =
      format === 'md'
        ? observationMarkdown(report, {
            detailAvailable: selected.detailAvailable,
            summaryOnly,
            generatedAt,
          })
        : JSON.stringify(
            {
              reportSchemaVersion: 1,
              generatedAt,
              displayTimeZone: 'UTC',
              scope: { executionId },
              detailAvailable: selected.detailAvailable,
              storedEventCount: selected.storedEventCount,
              summaryOnly,
              report,
            },
            null,
            2,
          );
    if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024)
      throw new PlatformError('FILE_TOO_LARGE', '报告文件超过预算，请选择仅导出摘要');
    if (!observations.read(userId, executionId, reportId))
      throw new PlatformError('NOT_FOUND', '所选报告已不可用');
    return new Response(body, {
      headers: {
        ...headers,
        'content-type':
          format === 'md'
            ? 'text/markdown; charset=utf-8'
            : 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="xapt-timing-${report.reportId}.${format}"`,
      },
    });
  } catch (error) {
    const response = errorResponse(normalizeRequestError(error), '读取耗时分析');
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
}
