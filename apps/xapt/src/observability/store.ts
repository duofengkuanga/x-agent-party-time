import { join } from 'node:path';
import { z } from 'zod';
import {
  ObservationBatchSchema,
  observationDigest,
  ObservationEventSchema,
  ObservationReportSchema,
  OBSERVATION_LIMITS,
  type ObservationBatch,
  type ObservationEvent,
  type ObservationReport,
} from '@agent-party-time/execution-contract/observability';
import type { LocalFileSystem } from '../platform/files';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const hash = /^[a-f0-9]{64}$/u;
const JsonChunkSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  events: z.array(ObservationEventSchema).max(128),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
});
const QueueSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  batch: ObservationBatchSchema,
});
const HeadSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  report: ObservationReportSchema,
});
const LossSchema = z.strictObject({
  updatedAt: z.iso.datetime(),
  reasons: z.array(z.enum(['expired', 'budget', 'rejected', 'corrupt'])).max(4),
});

export class ObservationCapacityError extends Error {
  constructor() {
    super('观测容量受限');
  }
}

export class ObservationStore {
  private damaged = false;
  private initialized: Promise<void> | null = null;
  get degraded(): boolean {
    return this.damaged;
  }

  constructor(
    private readonly root: string,
    private readonly files: LocalFileSystem,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      const rootInfo = await this.files.info(this.root);
      if (rootInfo && (rootInfo.type !== 'directory' || rootInfo.mode !== 0o700))
        throw new Error('观测目录权限不安全');
      await this.files.ensureDirectory(this.root, 0o700);
      for (const namespace of await this.files.list(this.root)) {
        if (!hash.test(namespace)) continue;
        const ns = join(this.root, namespace);
        const nsInfo = await this.files.info(ns);
        if (nsInfo?.type !== 'directory' || nsInfo.mode !== 0o700) {
          this.damaged = true;
          continue;
        }
        for (const executionId of await this.files.list(ns)) {
          if (!uuid.test(executionId)) continue;
          const directory = join(ns, executionId);
          const info = await this.files.info(directory);
          if (info?.type !== 'directory' || info.mode !== 0o700) {
            this.damaged = true;
            continue;
          }
          for (const name of await this.files.list(directory)) {
            if (
              !/^(?:(?:events|pending)-[a-f0-9-]{36}|head|loss)\.json\.[a-f0-9-]{36}\.tmp$/u.test(
                name,
              )
            )
              continue;
            const temporary = join(directory, name);
            const file = await this.files.info(temporary);
            if (file?.type !== 'file' || file.mode !== 0o600) {
              this.damaged = true;
              continue;
            }
            this.damaged = true;
            let reasons: Array<'expired' | 'budget' | 'rejected' | 'corrupt'> = [];
            try {
              reasons =
                (await this.read(join(directory, 'loss.json'), LossSchema))?.reasons ??
                [];
            } catch {
              /* Replace only invalid diagnostics metadata. */
            }
            await this.files.writeAtomic(
              join(directory, 'loss.json'),
              JSON.stringify({
                updatedAt: this.now().toISOString(),
                reasons: [...new Set([...reasons, 'corrupt'])],
              }),
              0o600,
            );
            await this.files.remove(temporary);
          }
        }
      }
    })().catch((error) => {
      this.initialized = null;
      throw error;
    });
    return this.initialized;
  }

  private location(namespace: string, executionId: string): string {
    if (!hash.test(namespace) || !uuid.test(executionId)) throw new Error('观测身份无效');
    return join(this.root, namespace, executionId);
  }

  private async directory(namespace: string, executionId: string): Promise<string> {
    await this.initialize();
    const location = this.location(namespace, executionId);
    for (const path of [this.root, join(this.root, namespace), location]) {
      const info = await this.files.info(path);
      if (info && (info.type !== 'directory' || info.mode !== 0o700))
        throw new Error('观测目录权限不安全');
      await this.files.ensureDirectory(path, 0o700);
    }
    return location;
  }

  private async read<T>(
    path: string,
    schema: z.ZodType<T>,
    maxBytes = OBSERVATION_LIMITS.batchBytes,
  ): Promise<T | null> {
    const info = await this.files.info(path);
    if (!info) return null;
    if (info.type !== 'file' || info.mode !== 0o600 || info.size > maxBytes)
      throw new Error('观测记录不可读取');
    const bytes = await this.files.read(path);
    return bytes ? schema.parse(JSON.parse(new TextDecoder().decode(bytes))) : null;
  }

  async append(
    namespace: string,
    executionId: string,
    chunkId: string,
    events: ObservationEvent[],
  ): Promise<void> {
    if (!uuid.test(chunkId) || events.some((event) => event.executionId !== executionId))
      throw new Error('观测块身份不一致');
    const directory = await this.directory(namespace, executionId);
    const path = join(directory, `events-${chunkId}.json`);
    const previous = await this.read(path, JsonChunkSchema);
    if (previous) {
      if (JSON.stringify(previous.events) !== JSON.stringify(events))
        throw new Error('观测块内容冲突');
      return;
    }
    const payload = { createdAt: this.now().toISOString(), events };
    const chunk = JsonChunkSchema.parse({
      ...payload,
      digest: await observationDigest(payload),
    });
    const text = JSON.stringify(chunk);
    if (new TextEncoder().encode(text).byteLength > OBSERVATION_LIMITS.batchBytes)
      throw new Error('观测块超过预算');
    const critical = events.every((event) =>
      [
        'execution.received',
        'delivery.accepted',
        'segment.opened',
        'segment.closed',
        'gap',
      ].includes(event.name),
    );
    if (
      (await this.byteSize(directory)) + new TextEncoder().encode(text).byteLength >
      OBSERVATION_LIMITS.executionBytes + (critical ? 1024 * 1024 : 0)
    ) {
      await this.noteLoss(namespace, executionId, 'budget');
      throw new ObservationCapacityError();
    }
    await this.files.writeAtomic(path, text, 0o600);
  }

  async events(
    namespace: string,
    executionId: string,
  ): Promise<{ events: ObservationEvent[]; incomplete: boolean }> {
    const directory = await this.directory(namespace, executionId);
    const events: ObservationEvent[] = [];
    let incomplete = (await this.loss(namespace, executionId)).length > 0;
    for (const name of await this.files.list(directory)) {
      if (!/^events-[a-f0-9-]{36}\.json$/u.test(name)) continue;
      try {
        const chunk = await this.read(join(directory, name), JsonChunkSchema);
        if (!chunk) continue;
        const { digest, ...payload } = chunk;
        if ((await observationDigest(payload)) !== digest)
          throw new Error('观测块摘要不一致');
        if (this.expired(chunk.createdAt, OBSERVATION_LIMITS.detailDays)) {
          incomplete = true;
          continue;
        }
        for (const event of chunk.events) {
          if (event.executionId !== executionId) {
            incomplete = true;
            continue;
          }
          if (events.length < 4000) events.push(event);
          else {
            incomplete = true;
            const boundary = [
              'execution.received',
              'delivery.accepted',
              'segment.opened',
              'segment.closed',
              'gap',
            ];
            if (boundary.includes(event.name)) {
              const index = events.findIndex((entry) => !boundary.includes(entry.name));
              if (index >= 0) events[index] = event;
            }
          }
        }
      } catch {
        incomplete = true;
        this.damaged = true;
        await this.noteLoss(namespace, executionId, 'corrupt');
        await this.files.remove(join(directory, name));
      }
    }
    return { events, incomplete };
  }

  async head(namespace: string, executionId: string): Promise<ObservationReport | null> {
    const directory = await this.directory(namespace, executionId);
    try {
      const value = await this.read(join(directory, 'head.json'), HeadSchema);
      return value && !this.expired(value.createdAt, OBSERVATION_LIMITS.detailDays)
        ? value.report
        : null;
    } catch {
      this.damaged = true;
      await this.noteLoss(namespace, executionId, 'corrupt');
      await this.files.remove(join(directory, 'head.json'));
      return null;
    }
  }

  async saveHead(
    namespace: string,
    executionId: string,
    report: ObservationReport,
  ): Promise<void> {
    const directory = await this.directory(namespace, executionId);
    const head = HeadSchema.parse({ createdAt: this.now().toISOString(), report });
    if (
      report.executionId !== executionId ||
      new TextEncoder().encode(JSON.stringify(report)).byteLength >
        OBSERVATION_LIMITS.summaryBytes
    )
      throw new Error('归因摘要超过预算或归属错误');
    const previous = await this.head(namespace, executionId);
    if (previous && previous.reportId === report.reportId) {
      if (JSON.stringify(previous) !== JSON.stringify(report))
        throw new Error('归因摘要身份冲突');
      return;
    }
    if (
      previous &&
      (report.revision <= previous.revision ||
        report.parentReportId !== previous.reportId)
    )
      throw new Error('归因摘要版本冲突');
    await this.files.writeAtomic(
      join(directory, 'head.json'),
      JSON.stringify(head),
      0o600,
    );
  }

  async enqueue(
    namespace: string,
    executionId: string,
    batch: ObservationBatch,
  ): Promise<void> {
    const directory = await this.directory(namespace, executionId);
    const path = join(directory, `pending-${batch.batchId}.json`);
    const previous = await this.read(path, QueueSchema);
    if (previous) {
      if (JSON.stringify(previous.batch) !== JSON.stringify(batch))
        throw new Error('归因批次内容冲突');
      return;
    }
    const value = QueueSchema.parse({ createdAt: this.now().toISOString(), batch });
    if (batch.executionId !== executionId) throw new Error('归因批次归属错误');
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).byteLength > OBSERVATION_LIMITS.batchBytes)
      throw new Error('归因批次超过预算');
    if (
      (await this.byteSize(directory)) + new TextEncoder().encode(text).byteLength >
      OBSERVATION_LIMITS.executionBytes + 1024 * 1024
    ) {
      await this.noteLoss(namespace, executionId, 'budget');
      throw new ObservationCapacityError();
    }
    await this.files.writeAtomic(path, text, 0o600);
  }

  async pending(
    namespace: string,
    onlyExecutionId?: string,
  ): Promise<Array<{ createdAt: string; batch: ObservationBatch }>> {
    if (!hash.test(namespace)) throw new Error('观测身份无效');
    await this.initialize();
    const namespaceInfo = await this.files.info(join(this.root, namespace));
    if (
      namespaceInfo &&
      (namespaceInfo.type !== 'directory' || namespaceInfo.mode !== 0o700)
    )
      throw new Error('观测目录权限不安全');
    const values: Array<{ createdAt: string; batch: ObservationBatch }> = [];
    let bytes = 0;
    let limited = false;
    const compare = (a: (typeof values)[number], b: (typeof values)[number]) =>
      a.batch.executionId.localeCompare(b.batch.executionId) ||
      (a.batch.report?.revision ?? 0) - (b.batch.report?.revision ?? 0) ||
      a.createdAt.localeCompare(b.createdAt);
    for (const executionId of await this.files.list(join(this.root, namespace))) {
      if (!uuid.test(executionId) || (onlyExecutionId && executionId !== onlyExecutionId))
        continue;
      let directory: string;
      try {
        directory = await this.directory(namespace, executionId);
      } catch {
        this.damaged = true;
        continue;
      }
      for (const name of await this.files.list(directory)) {
        if (!/^pending-[a-f0-9-]{36}\.json$/u.test(name)) continue;
        try {
          const value = await this.read(join(directory, name), QueueSchema);
          if (!value) continue;
          if (value.batch.executionId !== executionId) throw new Error('归属错误');
          const { digest, ...payload } = value.batch;
          if ((await observationDigest(payload)) !== digest)
            throw new Error('待报摘要不一致');
          if (this.expired(value.createdAt, OBSERVATION_LIMITS.detailDays)) {
            await this.noteLoss(namespace, executionId, 'expired');
            await this.files.remove(join(directory, name));
            continue;
          }
          const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
          bytes += size;
          values.push(value);
          values.sort(compare);
          while (bytes > OBSERVATION_LIMITS.memoryBytes / 8 || values.length > 512) {
            const removed = values.pop()!;
            bytes -= new TextEncoder().encode(JSON.stringify(removed)).byteLength;
            limited = true;
          }
        } catch {
          this.damaged = true;
          await this.noteLoss(namespace, executionId, 'corrupt');
          await this.files.remove(join(directory, name));
        }
      }
    }
    if (limited && onlyExecutionId)
      throw new Error('待报读取达到预算，等待已有批次接受后再生成版本');
    return values.sort(compare);
  }

  async acknowledge(namespace: string, batch: ObservationBatch): Promise<void> {
    const directory = await this.directory(namespace, batch.executionId);
    await this.files.remove(join(directory, `pending-${batch.batchId}.json`));
  }

  async discard(namespace: string, batch: ObservationBatch): Promise<void> {
    await this.noteLoss(namespace, batch.executionId, 'rejected');
    await this.acknowledge(namespace, batch);
  }

  async loss(
    namespace: string,
    executionId: string,
  ): Promise<Array<'expired' | 'budget' | 'rejected' | 'corrupt'>> {
    const directory = await this.directory(namespace, executionId);
    try {
      return (await this.read(join(directory, 'loss.json'), LossSchema))?.reasons ?? [];
    } catch {
      this.damaged = true;
      return ['corrupt'];
    }
  }

  private async noteLoss(
    namespace: string,
    executionId: string,
    reason: z.infer<typeof LossSchema>['reasons'][number],
  ): Promise<void> {
    const directory = await this.directory(namespace, executionId);
    const reasons = await this.loss(namespace, executionId);
    await this.files.writeAtomic(
      join(directory, 'loss.json'),
      JSON.stringify({
        updatedAt: this.now().toISOString(),
        reasons: [...new Set([...reasons, reason])],
      }),
      0o600,
    );
  }

  async prune(activeExecutions: ReadonlySet<string> = new Set()): Promise<void> {
    await this.initialize();
    const retained: Array<{
      path: string;
      size: number;
      createdAt: string;
      namespace: string;
      executionId: string;
    }> = [];
    for (const namespace of await this.files.list(this.root)) {
      if (!hash.test(namespace)) continue;
      for (const executionId of await this.files.list(join(this.root, namespace))) {
        if (!uuid.test(executionId)) continue;
        const directory = await this.directory(namespace, executionId);
        for (const name of await this.files.list(directory)) {
          if (!/^(?:(?:events|pending)-[a-f0-9-]{36}|head|loss)\.json$/u.test(name))
            continue;
          const path = join(directory, name);
          const schema = name.startsWith('events-')
            ? JsonChunkSchema
            : name.startsWith('pending-')
              ? QueueSchema
              : name === 'head.json'
                ? HeadSchema
                : LossSchema;
          try {
            const value = await this.read(
              path,
              schema as z.ZodType<{ createdAt?: string; updatedAt?: string }>,
            );
            const info = await this.files.info(path);
            if (!value || !info) continue;
            if (
              this.expired(
                value.createdAt ?? value.updatedAt!,
                OBSERVATION_LIMITS.detailDays,
              )
            ) {
              if (name !== 'loss.json')
                await this.noteLoss(namespace, executionId, 'expired');
              await this.files.remove(path);
            } else if (name !== 'loss.json')
              retained.push({
                path,
                size: info.size,
                createdAt: value.createdAt ?? value.updatedAt!,
                namespace,
                executionId,
              });
          } catch {
            this.damaged = true;
            await this.noteLoss(namespace, executionId, 'corrupt');
            if (name !== 'loss.json') await this.files.remove(path);
          }
        }
        const lossPath = join(directory, 'loss.json');
        const lossInfo = await this.files.info(lossPath);
        const loss = await this.read(lossPath, LossSchema);
        if (lossInfo && loss)
          retained.push({
            path: lossPath,
            size: lossInfo.size,
            createdAt: loss.updatedAt,
            namespace,
            executionId,
          });
      }
    }
    let total = retained.reduce((sum, file) => sum + file.size, 0);
    for (const file of retained.sort(
      (a, b) =>
        Number(activeExecutions.has(a.executionId)) -
          Number(activeExecutions.has(b.executionId)) ||
        a.createdAt.localeCompare(b.createdAt),
    )) {
      if (total <= OBSERVATION_LIMITS.installationBytes) break;
      this.damaged = true;
      const size = (await this.files.info(file.path))?.size ?? file.size;
      if (!file.path.endsWith('/loss.json')) {
        const lossPath = join(this.root, file.namespace, file.executionId, 'loss.json');
        const before = (await this.files.info(lossPath))?.size ?? 0;
        await this.noteLoss(file.namespace, file.executionId, 'budget');
        total += ((await this.files.info(lossPath))?.size ?? 0) - before;
      }
      await this.files.remove(file.path);
      total -= size;
    }
  }

  private expired(createdAt: string, days: number): boolean {
    const age = this.now().getTime() - Date.parse(createdAt);
    return Number.isFinite(age) && age > days * 86_400_000;
  }

  private async byteSize(directory: string): Promise<number> {
    let total = 0;
    for (const name of await this.files.list(directory))
      total += (await this.files.info(join(directory, name)))?.size ?? 0;
    return total;
  }
}
