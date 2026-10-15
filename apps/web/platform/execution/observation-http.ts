import {
  ObservationBatchSchema,
  OBSERVATION_LIMITS,
} from '@agent-party-time/execution-contract/observability';
import type { RunnerService } from '@/platform/runner/service';
import { bearerCredential } from '@/platform/runner/http';
import { errorResponse, normalizeRequestError } from '@/platform/http/responses';
import { PlatformError } from '@/platform/errors';
import type { ExecutionObservations } from './observations';

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
