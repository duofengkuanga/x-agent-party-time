import v8 from 'node:v8';

const sampled = Symbol.for('agentPartyTime.devHeapStatistics');
const SAMPLE_INTERVAL_MS = 1_000;

/** Keep complete statistics, but avoid Bun's full JSC heap walk per HTTP request. */
export function installDevHeapStatisticsSampling(
  statistics: Pick<typeof v8, 'getHeapStatistics'> = v8,
  now: () => number = () => performance.now(),
): void {
  if (sampled in statistics.getHeapStatistics) return;
  const read = statistics.getHeapStatistics.bind(statistics);
  let snapshot: ReturnType<typeof v8.getHeapStatistics> | undefined;
  let sampledAt = Number.NEGATIVE_INFINITY;
  function getHeapStatistics() {
    const time = now();
    if (!snapshot || time - sampledAt >= SAMPLE_INTERVAL_MS) {
      snapshot = read();
      sampledAt = now();
    }
    // Preserve the API's fresh-object semantics for callers that annotate a result.
    return { ...snapshot };
  }
  Object.defineProperty(getHeapStatistics, sampled, { value: true });
  statistics.getHeapStatistics = getHeapStatistics;
}
