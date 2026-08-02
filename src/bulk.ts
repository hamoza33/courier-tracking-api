import { detectCarrier, ALL_CARRIERS } from "./detect.js";
import type { Carrier } from "./types.js";
import { getJtBulkConcurrencyRaw } from "./runtime-config.js";

export function getJtBulkConcurrency(envValue = getJtBulkConcurrencyRaw()): number {
  const parsed = Number.parseInt(envValue ?? "5", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(10, parsed)) : 5;
}

export function resolveBulkCarrier(waybill: string, hint?: string): Carrier | null {
  const normalized = hint?.toLowerCase() ?? "auto";
  if (normalized !== "auto" && ALL_CARRIERS.includes(normalized as Carrier)) return normalized as Carrier;
  return detectCarrier(waybill.trim());
}

export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("Chunk size must be a positive integer");
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/** Map with a fixed worker pool. Results retain input order and worker errors are values. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<R | Error>> {
  const results = new Array<R | Error>(items.length);
  let cursor = 0;
  const count = Math.min(Math.max(1, Math.floor(concurrency)), Math.max(1, items.length));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = error instanceof Error ? error : new Error(String(error));
      }
    }
  }));
  return results;
}
