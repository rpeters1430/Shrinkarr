/**
 * Runs `worker` over `items` with at most `concurrency` calls in flight.
 * Rejections from `worker` propagate; callers that want per-item error
 * handling should catch inside `worker`.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  let next = 0;
  const lanes = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
}
