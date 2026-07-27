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
import { ZodError } from 'zod';
import { publicError, PlatformError } from '@/platform/errors';
import type { LocalFileStore } from '@/platform/files/local-file-store';
import { bearerCredential } from '@/platform/runner/http';
import type { RunnerService } from '@/platform/runner/service';
import type { ExecutionService } from './service';

type RunnerAuthenticator = Pick<RunnerService, 'authenticateCredential'>;

export async function handleExecutionClaim(
  request: Request,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'claim'>,
  prepare: () => void = () => {},
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = ExecutionClaimRequestSchema.parse(await request.json());
    prepare();
    return jsonResponse(
      ExecutionClaimResponseSchema.parse({
        executions: await executions.claim(
          runner.id,
          body.availableSlots,
          body.waitMs,
        ),
      }),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleExecutionStart(
  request: Request,
  executionId: string,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'start'>,
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = ExecutionStartRequestSchema.parse(await request.json());
    return jsonResponse(
      ExecutionMutationResponseSchema.parse({
        execution: executions.start(runner.id, executionId, body),
      }),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleExecutionRenew(
  request: Request,
  executionId: string,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'renew'>,
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = ExecutionRenewRequestSchema.parse(await request.json());
    return jsonResponse(
      ExecutionRenewResponseSchema.parse(
        executions.renew(runner.id, executionId, body.leaseToken),
      ),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleOpenInteraction(
  request: Request,
  executionId: string,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'openInteraction'>,
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = OpenInteractionRequestSchema.parse(await request.json());
    return jsonResponse(
      OpenInteractionResponseSchema.parse({
        interaction: executions.openInteraction(runner.id, executionId, body),
      }),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleWaitInteraction(
  request: Request,
  interactionId: string,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'waitInteraction'>,
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = WaitInteractionRequestSchema.parse(await request.json());
    return jsonResponse(
      WaitInteractionResponseSchema.parse({
        interaction: await executions.waitInteraction(
          runner.id,
          body.executionId,
          interactionId,
          body.leaseToken,
          body.waitMs,
        ),
      }),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleExecutionComplete(
  request: Request,
  executionId: string,
  runners: RunnerAuthenticator,
  executions: Pick<ExecutionService, 'complete'>,
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = CompleteExecutionRequestSchema.parse(await request.json());
    return jsonResponse(
      ExecutionMutationResponseSchema.parse({
        execution: executions.complete(runner.id, executionId, body),
      }),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
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
      throw new PlatformError('LEASE_EXPIRED', 'Execution Lease 已失效');
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
      throw new PlatformError('INTERNAL_ERROR', 'Execution 附件校验失败');
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

function normalizeRequestError(error: unknown): unknown {
  if (error instanceof SyntaxError || error instanceof ZodError)
    return new PlatformError('VALIDATION_FAILED', '请求内容无效', {
      cause: error,
    });
  return error;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function errorResponse(error: unknown): Response {
  const visible = publicError(error);
  return jsonResponse(
    { error: { code: visible.code, message: visible.message } },
    visible.status,
  );
}
