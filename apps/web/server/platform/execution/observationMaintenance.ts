import type { AppDatabase } from '@/server/database/index';
import { ExecutionObservations } from './observations';

let timer: ReturnType<typeof setInterval> | undefined;
/** Starts lazily from the production request boundary, never a build or test database. */
export function startObservationMaintenance(db: AppDatabase): void {
  if (timer) return;
  let warned = false;
  const sweep = () => {
    try {
      new ExecutionObservations(db, () => {}).prune();
    } catch {
      if (!warned) {
        warned = true;
        console.warn('耗时归因保留期清理暂不可用；业务执行照常。');
      }
    }
  };
  sweep();
  timer = setInterval(sweep, 60 * 60 * 1000);
  timer.unref();
}
