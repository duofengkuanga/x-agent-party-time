const POLL_INTERVAL_MS = 50;

export function sleepUntilNextPoll(deadline: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
    ),
  );
}
