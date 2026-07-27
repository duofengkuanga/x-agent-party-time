import {
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
