import {
  handleExecutionClaim,
  handleExecutionComplete,
  handleExecutionFile,
  handleExecutionRenew,
  handleExecutionStart,
  handleOpenInteraction,
  handleWaitInteraction,
} from '@/platform/execution/http';
import type { ExecutionService } from '@/platform/execution/service';
import type { LocalFileStore } from '@/platform/files/local-file-store';
import {
  handleRunnerAuthorizationClaim,
  handleRunnerAuthorizationCreate,
  handleRunnerBindingConfirmation,
  handleRunnerBindings,
  handleRunnerBindingWorkClaim,
  handleRunnerBindingWorkCompletion,
  handleRunnerHeartbeat,
  handleRunnerPair,
  handleRunnerSelfRevocation,
} from './http';
import type { RunnerService } from './service';

export type RunnerHttpServices = {
  runners: RunnerService;
  executions: ExecutionService;
  files: Pick<LocalFileStore, 'read'>;
  prepare: () => void;
  bindings: {
    list: Parameters<typeof handleRunnerBindings>[2];
    confirm: Parameters<typeof handleRunnerBindingConfirmation>[2];
    claim: Parameters<typeof handleRunnerBindingWorkClaim>[2];
    complete: Parameters<typeof handleRunnerBindingWorkCompletion>[3];
  };
};

type Endpoint = (request: Request, params: string[]) => Promise<Response>;

/** The production protocol dispatch is also the in-process conformance transport. */
export function runnerFetch({
  runners,
  executions,
  files,
  bindings,
  prepare,
}: RunnerHttpServices) {
  const routes: Array<[RegExp, Record<string, Endpoint>]> = [
    [
      /^\/api\/runner$/,
      { DELETE: (r) => handleRunnerSelfRevocation(r, runners) },
    ],
    [/^\/api\/runner\/pair$/, { POST: (r) => handleRunnerPair(r, runners) }],
    [
      /^\/api\/runner\/authorizations$/,
      { POST: (r) => handleRunnerAuthorizationCreate(r, runners) },
    ],
    [
      /^\/api\/runner\/authorizations\/([^/]+)\/claim$/,
      { POST: (r, [id]) => handleRunnerAuthorizationClaim(r, id!, runners) },
    ],
    [
      /^\/api\/runner\/heartbeat$/,
      { POST: (r) => handleRunnerHeartbeat(r, runners) },
    ],
    [
      /^\/api\/runner\/bindings$/,
      {
        GET: (r) => handleRunnerBindings(r, runners, bindings.list),
        POST: (r) =>
          handleRunnerBindingConfirmation(r, runners, bindings.confirm),
      },
    ],
    [
      /^\/api\/runner\/binding-requests$/,
      { POST: (r) => handleRunnerBindingWorkClaim(r, runners, bindings.claim) },
    ],
    [
      /^\/api\/runner\/binding-requests\/([^/]+)$/,
      {
        POST: (r, [id]) =>
          handleRunnerBindingWorkCompletion(r, id!, runners, bindings.complete),
      },
    ],
    [
      /^\/api\/runner\/executions\/claim$/,
      { POST: (r) => handleExecutionClaim(r, runners, executions, prepare) },
    ],
    [
      /^\/api\/runner\/executions\/([^/]+)\/start$/,
      { POST: (r, [id]) => handleExecutionStart(r, id!, runners, executions) },
    ],
    [
      /^\/api\/runner\/executions\/([^/]+)\/renew$/,
      { POST: (r, [id]) => handleExecutionRenew(r, id!, runners, executions) },
    ],
    [
      /^\/api\/runner\/executions\/([^/]+)\/complete$/,
      {
        POST: (r, [id]) => handleExecutionComplete(r, id!, runners, executions),
      },
    ],
    [
      /^\/api\/runner\/executions\/([^/]+)\/interactions\/open$/,
      { POST: (r, [id]) => handleOpenInteraction(r, id!, runners, executions) },
    ],
    [
      /^\/api\/runner\/interactions\/([^/]+)\/wait$/,
      { POST: (r, [id]) => handleWaitInteraction(r, id!, runners, executions) },
    ],
    [
      /^\/api\/runner\/executions\/([^/]+)\/files\/([^/]+)$/,
      {
        GET: (r, [id, fileId]) =>
          handleExecutionFile(r, id!, fileId!, runners, executions, files),
      },
    ],
  ];
  return async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    for (const [pattern, methods] of routes) {
      const match = pattern.exec(path);
      if (!match) continue;
      const method = request.method === 'HEAD' ? 'GET' : request.method;
      const handle = Object.hasOwn(methods, method)
        ? methods[method]
        : undefined;
      if (!handle) return new Response(null, { status: 405 });
      let params: string[];
      try {
        params = match.slice(1).map(decodeURIComponent);
      } catch {
        return new Response(null, { status: 400 });
      }
      const response = await handle(request, params);
      return request.method === 'HEAD'
        ? new Response(null, response)
        : response;
    }
    return Response.json(
      { error: { code: 'NOT_FOUND', message: '未找到' } },
      { status: 404 },
    );
  };
}
