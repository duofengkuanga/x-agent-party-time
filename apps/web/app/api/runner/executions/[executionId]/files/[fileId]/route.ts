import { executionFileStore } from '@/server/execution/files';
import { handleExecutionFile } from '@/server/execution/http';
import { executionService } from '@/server/execution/server';
import { runnerService } from '@/server/runner/server';

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
