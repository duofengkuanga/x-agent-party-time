interface QueuedJob {
  bindingId: string;
  priority: number;
  execute: () => Promise<void>;
}

export interface BindingExecutionSlot {
  /** Release the Codex execution slot while an App Server request waits for UI. */
  waitFor<T>(pending: Promise<T>): Promise<T>;
}

interface JobState {
  bindingId: string;
  active: boolean;
  settled: boolean;
}

/**
 * Schedules non-preemptive turns. Waiting App Server interactions release the
 * normal execution slot; their answered continuation is queued at priority 0.
 */
export class BindingExecutionCoordinator {
  readonly #queue: QueuedJob[] = [];
  readonly #activeBindings = new Set<string>();
  #activeCount = 0;

  constructor(readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
      throw new Error('maxConcurrent 必须是正整数');
  }

  get availableSlots() {
    return this.maxConcurrent - this.#activeCount;
  }

  run<T>(
    bindingId: string,
    task: (slot: BindingExecutionSlot) => Promise<T>,
    priority = 2,
  ): Promise<T> {
    if (!bindingId) return Promise.reject(new Error('bindingId 不能为空'));
    return new Promise<T>((resolve, reject) => {
      const state: JobState = { bindingId, active: false, settled: false };
      const slot: BindingExecutionSlot = {
        waitFor: <TResult>(pending: Promise<TResult>) =>
          this.#suspend(state, pending),
      };
      this.#enqueue(bindingId, priority, async () => {
        state.active = true;
        try {
          resolve(await task(slot));
        } catch (error) {
          reject(error);
        } finally {
          state.settled = true;
          if (state.active) this.#release(state);
        }
      });
    });
  }

  #suspend<T>(state: JobState, pending: Promise<T>): Promise<T> {
    if (!state.active || state.settled)
      return Promise.reject(new Error('当前任务没有可释放的执行槽'));
    state.active = false;
    this.#releaseResources(state.bindingId);
    return new Promise<T>((resolve, reject) => {
      void pending.then(
        (value) =>
          this.#enqueue(state.bindingId, 0, async () => {
            state.active = true;
            resolve(value);
          }),
        (error) =>
          this.#enqueue(state.bindingId, 0, async () => {
            state.active = true;
            reject(error);
          }),
      );
    });
  }

  #release(state: JobState) {
    state.active = false;
    this.#releaseResources(state.bindingId);
  }

  #releaseResources(bindingId: string) {
    this.#activeCount -= 1;
    this.#activeBindings.delete(bindingId);
    this.#drain();
  }

  #enqueue(bindingId: string, priority: number, execute: () => Promise<void>) {
    const job = { bindingId, priority, execute };
    const index = this.#queue.findIndex((queued) => queued.priority > priority);
    if (index < 0) this.#queue.push(job);
    else this.#queue.splice(index, 0, job);
    this.#drain();
  }

  #drain() {
    while (this.#activeCount < this.maxConcurrent) {
      const index = this.#queue.findIndex(
        (job) => !this.#activeBindings.has(job.bindingId),
      );
      if (index < 0) return;
      const [job] = this.#queue.splice(index, 1);
      if (!job) return;
      this.#activeCount += 1;
      this.#activeBindings.add(job.bindingId);
      void job.execute().catch(() => undefined);
    }
  }
}
