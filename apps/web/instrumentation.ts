export async function register() {
  if (
    process.env.NODE_ENV === 'development' &&
    process.env.NEXT_RUNTIME === 'nodejs' &&
    typeof Bun !== 'undefined'
  ) {
    // Next dev reads heap statistics twice after every request. Bun scans the JSC
    // heap for these values, so sample them instead of blocking every static chunk.
    const { installDevHeapStatisticsSampling } =
      await import('./server/runtime/devHeapStatistics');
    installDevHeapStatisticsSampling();
  }
}
