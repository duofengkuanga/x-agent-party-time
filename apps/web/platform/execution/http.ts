import { PlatformError } from '@/platform/errors';
import type { LocalFileStore } from '@/platform/files/local-file-store';
import {
  errorResponse,
  jsonOperation,
  normalizeRequestError,
} from '@/platform/http/responses';
import { bearerCredential } from '@/platform/runner/http';
import type { RunnerService } from '@/platform/runner/service';
import {
  CompleteExecutionRequestSchema,
  ExecutionClaimRequestSchema,
  ExecutionClaimResponseSchema,
  ExecutionMutationResponseSchema,
  ExecutionRenewRequestSchema,
  ExecutionRenewResponseSchema,
  ExecutionStartRequestSchema,
  OpenInteractionRequestSchema,
  OpenInteractionResponseSchema,
  WaitInteractionRequestSchema,
  WaitInteractionResponseSchema,
} from '@agent-party-time/execution-contract';
import type { ExecutionService } from './service';

type RunnerAuthenticator = Pick<RunnerService, 'authenticateCredential'>;

export async function handleExecutionClaim(
  request: Request,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'claim'>,
  prepare: () => void = () => {},
): Promise<Response> {
  return jsonOperation(ExecutionClaimResponseSchema, async () => {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = ExecutionClaimRequestSchema.parse(await request.json());
    prepare();
    return {
      executions: await executions.claim(
        runner.id,
        body.availableSlots,
        body.waitMs,
      ),
    };
  });
}

export async function handleExecutionStart(
  request: Request,
  executionId: string,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'start'>,
): Promise<Response> {
  return jsonOperation(ExecutionMutationResponseSchema, async () => {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = ExecutionStartRequestSchema.parse(await request.json());
    return {
      execution: executions.start(runner.id, executionId, body),
    };
  });
}

export async function handleExecutionRenew(
  request: Request,
  executionId: string,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'renew'>,
): Promise<Response> {
  return jsonOperation(ExecutionRenewResponseSchema, async () => {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = ExecutionRenewRequestSchema.parse(await request.json());
    return executions.renew(runner.id, executionId, body.leaseToken);
  });
}

export async function handleOpenInteraction(
  request: Request,
  executionId: string,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'openInteraction'>,
): Promise<Response> {
  return jsonOperation(OpenInteractionResponseSchema, async () => {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = OpenInteractionRequestSchema.parse(await request.json());
    return {
      interaction: executions.openInteraction(runner.id, executionId, body),
    };
  });
}

export async function handleWaitInteraction(
  request: Request,
  interactionId: string,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'waitInteraction'>,
): Promise<Response> {
  return jsonOperation(WaitInteractionResponseSchema, async () => {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = WaitInteractionRequestSchema.parse(await request.json());
    return await executions.waitInteraction(
      runner.id,
      body.executionId,
      interactionId,
      body.leaseToken,
      body.waitMs,
    );
  });
}

export async function handleExecutionComplete(
  request: Request,
  executionId: string,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'complete'>,
): Promise<Response> {
  return jsonOperation(ExecutionMutationResponseSchema, async () => {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = CompleteExecutionRequestSchema.parse(await request.json());
    return {
      execution: executions.complete(runner.id, executionId, body),
    };
  });
}

export async function handleExecutionFile(
  request: Request,
  executionId: string,
  fileId: string,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'authorizeFile'>,
  files: Pick<LocalFileStore, 'read'>,
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const leaseToken = request.headers.get('x-execution-lease-token');
    if (!leaseToken)
      throw new PlatformError('LEASE_EXPIRED', '任务领取凭据已失效');
    const allowed = executions.authorizeFile(
      runner.id,
      executionId,
      leaseToken,
      fileId,
    );
    const stored = await files.read(fileId);
    if (
      stored.file.sha256 !== allowed.sha256 ||
      stored.file.sizeBytes !== allowed.size_bytes
    )
      throw new PlatformError('INTERNAL_ERROR', '任务附件校验失败');
    return new Response(new Blob([Uint8Array.from(stored.bytes)]), {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': allowed.media_type,
        'content-length': String(allowed.size_bytes),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(
          allowed.original_name,
        )}`,
      },
    });
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}
