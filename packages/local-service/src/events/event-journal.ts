import { z } from 'zod';
import {
  EventNameSchema,
  StoredEventSchema,
  type EventRepository,
  type PageResult,
} from '@agent-party-time/shared';
import type { Logger } from '../logging/logger.js';

export const JournalItemSchema = StoredEventSchema;
export type JournalItem = z.infer<typeof JournalItemSchema>;
export const JournalFilterSchema = z.object({
  names: z.array(EventNameSchema).optional(),
  correlationId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
});
export type JournalFilter = z.infer<typeof JournalFilterSchema>;
export type EventSubscriber = (item: JournalItem) => void | Promise<void>;
export interface EventJournalOptions {
  repository: EventRepository;
  subscriberBufferSize?: number;
  logger: Logger;
}
export class EventJournal {
  private readonly wakeWaiters = new Set<() => void>();
  private closed = false;
  constructor(private readonly options: EventJournalOptions) {}
  async readAfter(
    cursor: string | null,
    limit: number,
    filter?: JournalFilter,
  ): Promise<PageResult<typeof JournalItemSchema>> {
    const page = await this.options.repository.readAfter(cursor, limit);
    const items = page.items
      .map((item) => JournalItemSchema.parse(item))
      .filter((item) => this.matches(item, filter));
    return { items, nextCursor: page.nextCursor };
  }
  latestCursor() {
    return this.options.repository.latestCursor();
  }
  publishCommitted(items: JournalItem[]): void {
    if (this.closed) return;
    for (const item of items) JournalItemSchema.parse(item);
    for (const wake of this.wakeWaiters) wake();
    this.wakeWaiters.clear();
  }
  async subscribe(
    cursor: string | null,
    subscriber: EventSubscriber,
    signal: AbortSignal,
    rawFilter?: JournalFilter,
  ): Promise<void> {
    if (this.closed) throw new Error('event journal closed');
    const filter = rawFilter ? JournalFilterSchema.parse(rawFilter) : undefined;
    let current = cursor;
    while (!signal.aborted && !this.closed) {
      const page = await this.readAfter(current, 100, filter);
      for (const item of page.items) {
        await subscriber(item);
        current = item.cursor;
      }
      if (page.nextCursor) current = page.nextCursor;
      if (page.items.length === 0) await this.waitForCommit(signal);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const wake of this.wakeWaiters) wake();
    this.wakeWaiters.clear();
  }
  private matches(item: JournalItem, filter?: JournalFilter) {
    if (!filter) return true;
    const payload = item.event.payload as Record<string, unknown>;
    return (
      (!filter.names || filter.names.includes(item.event.name)) &&
      (!filter.correlationId ||
        item.event.correlationId === filter.correlationId) &&
      (!filter.taskId || payload.taskId === filter.taskId) &&
      (!filter.runId || payload.runId === filter.runId)
    );
  }
  private waitForCommit(signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.wakeWaiters.delete(finish);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, 250);
      this.wakeWaiters.add(finish);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
