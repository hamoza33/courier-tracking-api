import { CarrierError, type TrackResult } from "../types.js";
import { trackJt as trackJtTencent, trackJtBatch as trackJtTencentBatch, type JtOptions } from "./jt.js";
import { trackJtTrackingMore, trackJtTrackingMoreBatch } from "./jt-trackingmore.js";

export type JtProvider = "auto" | "trackingmore" | "tencent";

export interface JtProviderOptions extends JtOptions {
  provider?: JtProvider;
}

export interface JtProviderDependencies {
  trackingmoreBatch: (waybills: readonly string[]) => Promise<TrackResult[]>;
  trackingmore: (waybill: string) => Promise<TrackResult>;
  tencentBatch: (waybills: readonly string[], opts?: JtOptions) => Promise<TrackResult[]>;
  tencent: (waybill: string, opts?: JtOptions) => Promise<TrackResult>;
}

export const JT_TRACKINGMORE_BATCH_SIZE = 20;
export const JT_TENCENT_BATCH_SIZE = 10;

export function getJtProviderBatchSize(provider: JtProvider): number {
  return provider === "tencent" ? JT_TENCENT_BATCH_SIZE : JT_TRACKINGMORE_BATCH_SIZE;
}

/** Parse an API/provider hint, defaulting omitted and blank values to auto. */
export function parseJtProvider(value: unknown): JtProvider {
  if (value === undefined || value === null || value === "") return "auto";
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "auto" || normalized === "trackingmore" || normalized === "tencent") return normalized;
  }
  throw new CarrierError("jt", "jtProvider must be one of: auto, trackingmore, tencent", { statusCode: 400 });
}

function annotate(result: TrackResult, requested: JtProvider, source: Exclude<JtProvider, "auto">, fallback: boolean, warning?: string): TrackResult {
  return {
    ...result,
    events: result.events.map((event) => ({ ...event })),
    extra: { ...(result.extra ?? {}), source, provider: source, requestedProvider: requested, fallback },
    warnings: [...(result.warnings ?? []), ...(warning ? [warning] : [])],
  };
}

function shouldFallback(error: unknown): boolean {
  return !(error instanceof CarrierError && error.statusCode >= 400 && error.statusCode < 500);
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export function createJtProviderTracker(deps: JtProviderDependencies) {
  async function batch(waybillNos: readonly string[], opts: JtProviderOptions = {}): Promise<TrackResult[]> {
    const provider = parseJtProvider(opts.provider);
    const carrierOpts: JtOptions = { lang: opts.lang };
    if (waybillNos.length === 0) throw new CarrierError("jt", "At least one J&T waybill is required", { statusCode: 400 });
    const maximum = getJtProviderBatchSize(provider);
    if (waybillNos.length > maximum) {
      throw new CarrierError("jt", `Maximum ${maximum} J&T waybills per ${provider === "tencent" ? "Tencent" : "TrackingMore"} batch`, { statusCode: 400 });
    }
    if (provider === "trackingmore") {
      return (await deps.trackingmoreBatch(waybillNos)).map((r) => annotate(r, provider, "trackingmore", false));
    }
    if (provider === "tencent") {
      return (await deps.tencentBatch(waybillNos, carrierOpts)).map((r) => annotate(r, provider, "tencent", false));
    }
    try {
      return (await deps.trackingmoreBatch(waybillNos)).map((r) => annotate(r, provider, "trackingmore", false));
    } catch (error) {
      if (!shouldFallback(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const warning = `TrackingMore provider failed (${reason}); fell back to J&T Tencent provider.`;
      const fallbackBatches = await Promise.all(
        chunks(waybillNos, JT_TENCENT_BATCH_SIZE).map((group) => deps.tencentBatch(group, carrierOpts)),
      );
      return fallbackBatches.flat().map((r) => annotate(r, provider, "tencent", true, warning));
    }
  }

  async function single(waybillNo: string, opts: JtProviderOptions = {}): Promise<TrackResult> {
    const provider = parseJtProvider(opts.provider);
    const carrierOpts: JtOptions = { lang: opts.lang };
    if (provider === "trackingmore") return annotate(await deps.trackingmore(waybillNo), provider, "trackingmore", false);
    if (provider === "tencent") return annotate(await deps.tencent(waybillNo, carrierOpts), provider, "tencent", false);
    try {
      return annotate(await deps.trackingmore(waybillNo), provider, "trackingmore", false);
    } catch (error) {
      if (!shouldFallback(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      return annotate(
        await deps.tencent(waybillNo, carrierOpts),
        provider,
        "tencent",
        true,
        `TrackingMore provider failed (${reason}); fell back to J&T Tencent provider.`,
      );
    }
  }

  return { trackJtBatch: batch, trackJt: single };
}

const tracker = createJtProviderTracker({
  trackingmoreBatch: trackJtTrackingMoreBatch,
  trackingmore: trackJtTrackingMore,
  tencentBatch: trackJtTencentBatch,
  tencent: trackJtTencent,
});

export const trackJtBatch = tracker.trackJtBatch;
export const trackJt = tracker.trackJt;
