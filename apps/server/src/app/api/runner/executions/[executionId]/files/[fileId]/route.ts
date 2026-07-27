import { executionFileStore } from '@/platform/execution/files';
import { handleExecutionFile } from '@/platform/execution/http';
import { executionService } from '@/platform/execution/server';
import { runnerService } from '@/platform/runner/server';

export async function GET(
  request: Request,
  context: { params: Promise<{ executionId: string; fileId: string }> },
): Promise<Response> {
  const { executionId, fileId } = await context.params;
  return handleExecutionFile(
    request,
    executionId,
    fileId,
    runnerService(),
    executionService(),
    executionFileStore(),
  );
}
