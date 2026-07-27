import {
  WorkspaceInvalidationSchema,
  type WorkspaceInvalidation,
} from '../contract';
import { logger } from '@/platform/logging';

type WorkspaceEventListener = (event: WorkspaceInvalidation) => void;

export class WorkspaceEventBus {
  private readonly listeners = new Set<WorkspaceEventListener>();

  constructor(
    private readonly onListenerError: (error: unknown) => void = (error) =>
      logger.error('cooking_workspace_event_listener_failed', error),
  ) {}

  publish(event: WorkspaceInvalidation): void {
    const parsed = WorkspaceInvalidationSchema.parse(event);
    for (const listener of this.listeners)
      try {
        listener(parsed);
      } catch (error) {
        this.onListenerError(error);
      }
  }

  subscribe(listener: WorkspaceEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

type WorkspaceEventGlobal = typeof globalThis & {
  __agentPartyTimeWorkspaceEvents?: WorkspaceEventBus;
};

export function workspaceEvents(): WorkspaceEventBus {
  const globalState = globalThis as WorkspaceEventGlobal;
  if (!globalState.__agentPartyTimeWorkspaceEvents)
    globalState.__agentPartyTimeWorkspaceEvents = new WorkspaceEventBus();
  return globalState.__agentPartyTimeWorkspaceEvents;
}
