import { jsonOperation } from '@/platform/http/responses';
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
  RunnerHeartbeatRequestSchema,
  RunnerPairRequestSchema,
  RunnerPairingResultSchema,
  type RunnerBindingRef,
} from '@agent-party-time/runner-contract';
import type { RunnerService } from './service';

export async function handleRunnerPair(
  request: Request,
  runners: Pick<RunnerService, 'pair'>,
): Promise<Response> {
  return jsonOperation(RunnerPairingResultSchema, async () => {
    const body = RunnerPairRequestSchema.parse(await request.json());
    return runners.pair(body.code, body.name);
  });
}

export async function handleRunnerAuthorizationCreate(
  request: Request,
  runners: Pick<RunnerService, 'createAuthorizationRequest'>,
): Promise<Response> {
  return jsonOperation(
    RunnerAuthorizationIssueSchema,
    async () => {
      const body = RunnerAuthorizationCreateRequestSchema.parse(
        await request.json(),
      );
      return runners.createAuthorizationRequest(body);
    },
    { status: 201 },
  );
}

export async function handleRunnerAuthorizationClaim(
  request: Request,
  requestId: string,
  runners: Pick<RunnerService, 'claimAuthorization'>,
): Promise<Response> {
  return jsonOperation(RunnerAuthorizationClaimResponseSchema, async () => {
    const body = RunnerAuthorizationClaimRequestSchema.parse(
      await request.json(),
    );
    return runners.claimAuthorization(requestId, body.verifier);
  });
}

export async function handleRunnerHeartbeat(
  request: Request,
  runners: Pick<RunnerService, 'authenticateCredential' | 'heartbeat'>,
): Promise<Response> {
  return jsonOperation(RunnerHeartbeatResponseSchema, async () => {
    const credential = bearerCredential(request);
    runners.authenticateCredential(credential);
    const body = RunnerHeartbeatRequestSchema.parse(await request.json());
    return {
      runner: runners.heartbeat(credential, body.availableSlots),
    };
  });
}

export async function handleRunnerSelfRevocation(
  request: Request,
  runners: Pick<RunnerService, 'revokeSelf'>,
): Promise<Response> {
  return jsonOperation(RunnerHeartbeatResponseSchema, async () => {
    return {
      runner: runners.revokeSelf(bearerCredential(request)),
    };
  });
}

export async function handleRunnerBindings(
  request: Request,
  runners: Pick<RunnerService, 'authenticateCredential'>,
  listBindingRefs: (runnerId: string) => RunnerBindingRef[],
): Promise<Response> {
  return jsonOperation(RunnerBindingsResponseSchema, async () => {
    const runner = runners.authenticateCredential(bearerCredential(request));
    return {
      bindings: listBindingRefs(runner.id),
    };
  });
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
  return jsonOperation(RunnerBindingConfirmationResponseSchema, async () => {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const body = RunnerBindingConfirmationRequestSchema.parse(
      await request.json(),
    );
    return {
      ...body,
      repositoryUrl: confirm(runner.id, body.bindingId, body.repositoryUrl),
    };
  });
}

export async function handleRunnerBindingWorkClaim(
  request: Request,
  runners: Pick<RunnerService, 'authenticateCredential'>,
  claim: (runnerId: string) => unknown,
): Promise<Response> {
  return jsonOperation(RunnerBindingWorkResponseSchema, async () => {
    const runner = runners.authenticateCredential(bearerCredential(request));
    return { request: claim(runner.id) };
  });
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
  return jsonOperation(RunnerBindingWorkCompletionResponseSchema, async () => {
    const runner = runners.authenticateCredential(bearerCredential(request));
    const completion = RunnerBindingWorkCompletionSchema.parse(
      await request.json(),
    );
    return {
      state: complete(runner.id, requestId, completion),
    };
  });
}

export function bearerCredential(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  if (!authorization) return undefined;
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  return match?.[1];
}
