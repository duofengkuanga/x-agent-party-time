import {
  RunnerAuthorizationClaimRequestSchema,
  RunnerAuthorizationClaimResponseSchema,
  RunnerAuthorizationCreateRequestSchema,
  RunnerAuthorizationIssueSchema,
  RunnerBindingConfirmationRequestSchema,
  RunnerBindingConfirmationResponseSchema,
  RunnerBindingWorkCompletionResponseSchema,
  RunnerBindingWorkCompletionSchema,
  RunnerBindingWorkResponseSchema,
  RunnerBindingsResponseSchema,
  RunnerHeartbeatResponseSchema,
  RunnerPairRequestSchema,
  RunnerPairingResultSchema,
  type RunnerBindingRef,
} from '@agent-party-time/runner-contract';
import { ZodError } from 'zod';
import { publicError, PlatformError } from '@/server/errors';
import type { RunnerService } from './service';

export async function handleRunnerPair(
  request: Request,
  runners: Pick<RunnerService, 'pair'>,
): Promise<Response> {
  try {
    const body = RunnerPairRequestSchema.parse(await request.json());
    return jsonResponse(
      RunnerPairingResultSchema.parse(runners.pair(body.code, body.name)),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleRunnerAuthorizationCreate(
  request: Request,
  runners: Pick<RunnerService, 'createAuthorizationRequest'>,
): Promise<Response> {
  try {
    const body = RunnerAuthorizationCreateRequestSchema.parse(
      await request.json(),
    );
    return jsonResponse(
      RunnerAuthorizationIssueSchema.parse(
        runners.createAuthorizationRequest(body),
      ),
      201,
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleRunnerAuthorizationClaim(
  request: Request,
  requestId: string,
  runners: Pick<RunnerService, 'claimAuthorization'>,
): Promise<Response> {
  try {
    const body = RunnerAuthorizationClaimRequestSchema.parse(
      await request.json(),
    );
    return jsonResponse(
      RunnerAuthorizationClaimResponseSchema.parse(
        runners.claimAuthorization(requestId, body.verifier),
      ),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleRunnerHeartbeat(
  request: Request,
  runners: Pick<RunnerService, 'heartbeat'>,
): Promise<Response> {
  try {
    return jsonResponse(
      RunnerHeartbeatResponseSchema.parse({
        runner: runners.heartbeat(bearerCredential(request)),
      }),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleRunnerBindings(
  request: Request,
  runners: Pick<RunnerService, 'authenticateCredential'>,
  listBindingRefs: (runnerId: string) => RunnerBindingRef[],
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    return jsonResponse(
      RunnerBindingsResponseSchema.parse({
        bindings: listBindingRefs(runner.id),
      }),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleRunnerBindingConfirmation(
  request: Request,
  runners: Pick<RunnerService, 'authenticateCredential'>,
  confirm: (
    runnerId: string,
    bindingId: string,
    repositoryUrl: string,
  ) => string,
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = RunnerBindingConfirmationRequestSchema.parse(
      await request.json(),
    );
    return jsonResponse(
      RunnerBindingConfirmationResponseSchema.parse({
        ...body,
        repositoryUrl: confirm(runner.id, body.bindingId, body.repositoryUrl),
      }),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleRunnerBindingWorkClaim(
  request: Request,
  runners: Pick<RunnerService, 'authenticateCredential'>,
  claim: (runnerId: string) => unknown,
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    return jsonResponse(
      RunnerBindingWorkResponseSchema.parse({ request: claim(runner.id) }),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export async function handleRunnerBindingWorkCompletion(
  request: Request,
  requestId: string,
  runners: Pick<RunnerService, 'authenticateCredential'>,
  complete: (
    runnerId: string,
    requestId: string,
    completion: ReturnType<typeof RunnerBindingWorkCompletionSchema.parse>,
  ) => 'SUCCEEDED' | 'FAILED',
): Promise<Response> {
  try {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const completion = RunnerBindingWorkCompletionSchema.parse(
      await request.json(),
    );
    return jsonResponse(
      RunnerBindingWorkCompletionResponseSchema.parse({
        state: complete(runner.id, requestId, completion),
      }),
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export function bearerCredential(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  if (!authorization) return undefined;
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  return match?.[1];
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
