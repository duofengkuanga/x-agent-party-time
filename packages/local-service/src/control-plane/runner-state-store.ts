import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  CollaborativeCommandSchema,
  FinishDeploymentAttemptCommandSchema,
  FinishRepairAttemptCommandSchema,
  LocalEngineeringBindingSchema,
  ProjectBindingSchema,
  RunnerIdSchema,
  type ProjectBinding,
  type LocalEngineeringBinding,
} from '@agent-party-time/shared';

const IsoUtcDateTimeSchema = z.string().datetime({ offset: false });

const PendingRepairOutcomeSchema = z.object({
  id: z.uuid(),
  kind: z.literal('repair'),
  createdAt: IsoUtcDateTimeSchema,
  input: FinishRepairAttemptCommandSchema,
});
const PendingDeploymentOutcomeSchema = z.object({
  id: z.uuid(),
  kind: z.literal('deployment'),
  createdAt: IsoUtcDateTimeSchema,
  input: FinishDeploymentAttemptCommandSchema,
});
export const PendingControlPlaneOutcomeSchema = z.discriminatedUnion('kind', [
  PendingRepairOutcomeSchema,
  PendingDeploymentOutcomeSchema,
]);
export type PendingControlPlaneOutcome = z.infer<
  typeof PendingControlPlaneOutcomeSchema
>;

const CollaborativeFinishCommandSchema = z.discriminatedUnion('kind', [
  CollaborativeCommandSchema.options.find(
    (schema) => schema.shape.kind.value === 'repair_task.finish',
  )!,
  CollaborativeCommandSchema.options.find(
    (schema) => schema.shape.kind.value === 'update_task.finish',
  )!,
  CollaborativeCommandSchema.options.find(
    (schema) => schema.shape.kind.value === 'cleanup_task.finish',
  )!,
]);
const PendingCollaborativeOutcomeSchema = z.object({
  id: z.uuid(),
  createdAt: IsoUtcDateTimeSchema,
  command: CollaborativeFinishCommandSchema,
});
export type PendingCollaborativeOutcome = z.infer<
  typeof PendingCollaborativeOutcomeSchema
>;

const RunnerStateV1Schema = z.object({
  schemaVersion: z.literal(1),
  runnerId: RunnerIdSchema,
  runnerName: z.string().trim().min(1).max(80),
  bindings: z.array(ProjectBindingSchema),
});
const RunnerStateV2Schema = z.object({
  schemaVersion: z.literal(2),
  runnerId: RunnerIdSchema,
  runnerName: z.string().trim().min(1).max(80),
  bindings: z.array(ProjectBindingSchema),
  pendingOutcomes: z.array(PendingControlPlaneOutcomeSchema),
  cleanedSessionIds: z.array(z.string().trim().min(1).max(200)),
});
const RunnerStateV3Schema = z.object({
  schemaVersion: z.literal(3),
  runnerId: RunnerIdSchema,
  runnerName: z.string().trim().min(1).max(80),
  bindings: z.array(ProjectBindingSchema),
  engineeringBindings: z.array(LocalEngineeringBindingSchema),
  pendingOutcomes: z.array(PendingControlPlaneOutcomeSchema),
  cleanedSessionIds: z.array(z.string().trim().min(1).max(200)),
});
const RunnerStateSchema = RunnerStateV3Schema.extend({
  schemaVersion: z.literal(4),
  collaborativePendingOutcomes: z.array(PendingCollaborativeOutcomeSchema),
});
type RunnerState = z.infer<typeof RunnerStateSchema>;

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export class RunnerStateStore {
  constructor(private readonly path: string) {}

  async ensureIdentity(runnerName: string) {
    return this.updateState((current) => {
      const state = current
        ? { ...current, runnerName }
        : RunnerStateSchema.parse({
            schemaVersion: 4,
            runnerId: randomUUID(),
            runnerName,
            bindings: [],
            engineeringBindings: [],
            pendingOutcomes: [],
            collaborativePendingOutcomes: [],
            cleanedSessionIds: [],
          });
      return {
        state,
        result: { runnerId: state.runnerId, runnerName: state.runnerName },
      };
    });
  }

  async identity() {
    const state = await this.requireState();
    return { runnerId: state.runnerId, runnerName: state.runnerName };
  }

  async listBindings() {
    return [...(await this.requireState()).bindings].sort((left, right) =>
      left.projectSlug.localeCompare(right.projectSlug),
    );
  }

  async saveBinding(binding: ProjectBinding) {
    const parsed = ProjectBindingSchema.parse(binding);
    return this.updateRequiredState((state) => {
      const previous = state.bindings.find(
        (item) => item.projectId === parsed.projectId,
      );
      const saved = {
        ...parsed,
        createdAt: previous?.createdAt ?? parsed.createdAt,
      };
      return {
        state: {
          ...state,
          bindings: [
            ...state.bindings.filter(
              (item) => item.projectId !== parsed.projectId,
            ),
            saved,
          ],
        },
        result: saved,
      };
    });
  }

  async listEngineeringBindings() {
    return [...(await this.requireState()).engineeringBindings].sort(
      (left, right) => left.engineeringId.localeCompare(right.engineeringId),
    );
  }

  async saveEngineeringBinding(binding: LocalEngineeringBinding) {
    const parsed = LocalEngineeringBindingSchema.parse(binding);
    return this.updateRequiredState((state) => {
      const previous = state.engineeringBindings.find(
        (item) =>
          item.engineeringId === parsed.engineeringId &&
          item.developerUserId === parsed.developerUserId,
      );
      const saved = {
        ...parsed,
        createdAt: previous?.createdAt ?? parsed.createdAt,
      };
      return {
        state: {
          ...state,
          engineeringBindings: [
            ...state.engineeringBindings.filter(
              (item) =>
                item.engineeringId !== parsed.engineeringId ||
                item.developerUserId !== parsed.developerUserId,
            ),
            saved,
          ],
        },
        result: saved,
      };
    });
  }

  async listPendingOutcomes() {
    return [...(await this.requireState()).pendingOutcomes].sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt),
    );
  }

  async savePendingOutcome(
    outcome: Omit<PendingControlPlaneOutcome, 'id' | 'createdAt'> & {
      id?: string;
      createdAt?: string;
    },
  ) {
    const parsed = PendingControlPlaneOutcomeSchema.parse({
      ...outcome,
      id: outcome.id ?? randomUUID(),
      createdAt: outcome.createdAt ?? new Date().toISOString(),
    });
    return this.updateRequiredState((state) => ({
      state: {
        ...state,
        pendingOutcomes: [
          ...state.pendingOutcomes.filter((item) => item.id !== parsed.id),
          parsed,
        ],
      },
      result: parsed,
    }));
  }

  async removePendingOutcome(id: string) {
    await this.updateRequiredState((state) => ({
      state: {
        ...state,
        pendingOutcomes: state.pendingOutcomes.filter((item) => item.id !== id),
      },
      result: undefined,
    }));
  }

  async listCollaborativePendingOutcomes() {
    return [...(await this.requireState()).collaborativePendingOutcomes].sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt),
    );
  }

  async saveCollaborativePendingOutcome(
    outcome: Omit<PendingCollaborativeOutcome, 'id' | 'createdAt'> & {
      id?: string;
      createdAt?: string;
    },
  ) {
    const parsed = PendingCollaborativeOutcomeSchema.parse({
      ...outcome,
      id: outcome.id ?? randomUUID(),
      createdAt: outcome.createdAt ?? new Date().toISOString(),
    });
    return this.updateRequiredState((state) => ({
      state: {
        ...state,
        collaborativePendingOutcomes: [
          ...state.collaborativePendingOutcomes.filter(
            (item) => item.id !== parsed.id,
          ),
          parsed,
        ],
      },
      result: parsed,
    }));
  }

  async removeCollaborativePendingOutcome(id: string) {
    await this.updateRequiredState((state) => ({
      state: {
        ...state,
        collaborativePendingOutcomes: state.collaborativePendingOutcomes.filter(
          (item) => item.id !== id,
        ),
      },
      result: undefined,
    }));
  }

  async markSessionsCleaned(sessionIds: readonly string[]) {
    await this.updateRequiredState((state) => ({
      state: {
        ...state,
        cleanedSessionIds: [
          ...new Set([
            ...state.cleanedSessionIds,
            ...sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean),
          ]),
        ],
      },
      result: undefined,
    }));
  }

  async isSessionCleaned(sessionId: string | null | undefined) {
    if (!sessionId) return false;
    return (await this.requireState()).cleanedSessionIds.includes(sessionId);
  }

  async resumableSession(sessionId: string | null | undefined) {
    return sessionId && !(await this.isSessionCleaned(sessionId))
      ? sessionId
      : null;
  }

  private async requireState() {
    const state = await this.load();
    if (!state) throw new Error('Agent 身份尚未初始化');
    return state;
  }

  private async load(): Promise<RunnerState | null> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      const version = z.object({ schemaVersion: z.number().int() }).parse(raw);
      if (version.schemaVersion === 1) {
        const previous = RunnerStateV1Schema.parse(raw);
        return RunnerStateSchema.parse({
          ...previous,
          schemaVersion: 4,
          engineeringBindings: [],
          pendingOutcomes: [],
          collaborativePendingOutcomes: [],
          cleanedSessionIds: [],
        });
      }
      if (version.schemaVersion === 2) {
        const previous = RunnerStateV2Schema.parse(raw);
        return RunnerStateSchema.parse({
          ...previous,
          schemaVersion: 4,
          engineeringBindings: [],
          collaborativePendingOutcomes: [],
        });
      }
      if (version.schemaVersion === 3) {
        const previous = RunnerStateV3Schema.parse(raw);
        return RunnerStateSchema.parse({
          ...previous,
          schemaVersion: 4,
          collaborativePendingOutcomes: [],
        });
      }
      return RunnerStateSchema.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async save(state: RunnerState) {
    const parsed = RunnerStateSchema.parse(state);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
  }

  private async updateRequiredState<T>(
    update: (state: RunnerState) => { state: RunnerState; result: T },
  ) {
    return this.updateState((state) => {
      if (!state) throw new Error('Agent 身份尚未初始化');
      return update(state);
    });
  }

  private async updateState<T>(
    update: (state: RunnerState | null) => { state: RunnerState; result: T },
  ) {
    const release = await this.acquireLock();
    try {
      const next = update(await this.load());
      await this.save(next.state);
      return next.result;
    } finally {
      await release();
    }
  }

  private async acquireLock() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        const ownership = JSON.stringify({
          nonce: randomUUID(),
          pid: process.pid,
          createdAt: Date.now(),
        });
        await handle.writeFile(ownership);
        await handle.sync();
        return async () => {
          await handle.close();
          const current = await readFile(lockPath, 'utf8').catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            },
          );
          if (current !== ownership) return;
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        };
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== 'EEXIST') throw error;
        await this.removeStaleLock(lockPath);
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS)
          throw new Error('Agent 本地状态写入锁等待超时');
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private async removeStaleLock(lockPath: string) {
    try {
      const observed = await readFile(lockPath, 'utf8');
      const parsed = z
        .object({
          nonce: z.string().uuid(),
          pid: z.number().int().positive(),
          createdAt: z.number().int().nonnegative(),
        })
        .safeParse(parseJson(observed));
      if (parsed.success && processIsAlive(parsed.data.pid)) return;
      const createdAt = parsed.success
        ? parsed.data.createdAt
        : (await stat(lockPath)).mtimeMs;
      if (Date.now() - createdAt <= STALE_LOCK_MS) return;
      const generation = parsed.success
        ? parsed.data.nonce
        : createHash('sha256').update(observed).digest('hex').slice(0, 32);
      const recoveryPath = `${lockPath}.recovery-${generation}`;
      let recovery;
      try {
        recovery = await open(recoveryPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
        throw error;
      }
      try {
        if ((await readFile(lockPath, 'utf8')) === observed)
          await unlink(lockPath);
      } finally {
        await recovery.close();
        await unlink(recoveryPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
