/** Run `fn` over `items` in fixed-size waves, rather than one unbounded Promise.all over
 *  everything at once. Callers that care about output order must write into a pre-sized array
 *  by index — completion order within a wave is not the input order. */
export async function processInBatches<T>(
  items: T[], batchSize: number, fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(fn));
  }
}
