import { ZodError } from 'zod';
import { PlatformError, publicError } from '@/platform/errors';
import { logger } from '@/platform/logging';
import type { CookingWorkspaceService } from '@/modules/cooking/workspace/application/workspace-service';
import { CookingWorkspaceSnapshotSchema } from '@/modules/cooking/workspace/contract';
import {
  SubmissionIdSchema,
  WorkspaceInvalidationSchema,
  type WorkspaceInvalidation,
} from '../contract';
import type { WorkspaceEventBus } from '../application/workspace-events';

const encoder = new TextEncoder();

export function handleWorkspaceSnapshot(
  submissionIdInput: string,
  userId: string,
  submissions: Pick<CookingWorkspaceService, 'getWorkspace'>,
): Response {
  try {
    const submissionId = SubmissionIdSchema.parse(submissionIdInput);
    return Response.json(
      CookingWorkspaceSnapshotSchema.parse(
        submissions.getWorkspace(userId, submissionId),
      ),
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

export function handleWorkspaceEvents(
  request: Request,
  userId: string,
  submissions: Pick<
    CookingWorkspaceService,
    'canAccessSubmission' | 'getWorkspace'
  >,
  events: WorkspaceEventBus,
  keepaliveMs = 15_000,
): Response {
  try {
    const submissionId = submissionIdFromRequest(request);
    let unsubscribe: (() => void) | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let deliver: ((event: WorkspaceInvalidation) => void) | undefined;
    const pending: WorkspaceInvalidation[] = [];
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      deliver = undefined;
      unsubscribe?.();
      if (keepalive) clearInterval(keepalive);
    };
    unsubscribe = events.subscribe((event) => {
      if (event.submissionId !== submissionId || closed) return;
      if (deliver) deliver(event);
      else pending.push(event);
    });
    let current: ReturnType<CookingWorkspaceService['getWorkspace']>;
    try {
      current = submissions.getWorkspace(userId, submissionId);
    } catch (error) {
      close();
      throw error;
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (value: string) => {
          if (!closed) controller.enqueue(encoder.encode(value));
        };
        deliver = (event) => {
          try {
            if (!submissions.canAccessSubmission(userId, submissionId)) {
              close();
              controller.close();
              return;
            }
            send(eventData(event));
          } catch (error) {
            logger.error('cooking_workspace_event_delivery_failed', error, {
              submissionId,
              userId,
            });
            close();
            controller.error(error);
          }
        };
        send('retry: 1000\n\n');
        send(
          eventData({
            submissionId,
            revision: current.revision,
          }),
        );
        for (const event of pending)
          if (event.revision > current.revision) deliver(event);
        pending.length = 0;
        keepalive = setInterval(() => send(': keepalive\n\n'), keepaliveMs);
        if (request.signal.aborted) {
          close();
          controller.close();
          return;
        }
        request.signal.addEventListener(
          'abort',
          () => {
            if (closed) return;
            close();
            controller.close();
          },
          { once: true },
        );
      },
      cancel() {
        close();
      },
    });
    return new Response(stream, {
      headers: {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    return errorResponse(normalizeRequestError(error));
  }
}

function submissionIdFromRequest(request: Request): string {
  return SubmissionIdSchema.parse(
    new URL(request.url).searchParams.get('submissionId'),
  );
}

function eventData(value: unknown): string {
  return `data: ${JSON.stringify(WorkspaceInvalidationSchema.parse(value))}\n\n`;
}

function normalizeRequestError(error: unknown): unknown {
  if (error instanceof ZodError)
    return new PlatformError('VALIDATION_FAILED', '请求内容无效', {
      cause: error,
    });
  return error;
}

function errorResponse(error: unknown): Response {
  const visible = publicError(error);
  return Response.json(
    { error: { code: visible.code, message: visible.message } },
    {
      status: visible.status,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
