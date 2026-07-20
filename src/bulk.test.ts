import { getJtBulkConcurrency, mapConcurrent } from "./bulk.js";

let passed = 0;
function assert(name: string, value: boolean): void {
  if (!value) throw new Error(`FAIL: ${name}`);
  passed++;
}

assert("default concurrency", getJtBulkConcurrency(undefined) === 5);
assert("lower clamp", getJtBulkConcurrency("0") === 1);
assert("upper clamp", getJtBulkConcurrency("99") === 10);
assert("invalid defaults", getJtBulkConcurrency("wat") === 5);

let active = 0;
let peak = 0;
const values = await mapConcurrent([30, 5, 20, 1, 10], 2, async (delay, index) => {
  active++; peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, delay));
  active--;
  if (index === 3) throw new Error("item failure");
  return index;
});
assert("concurrency limited", peak === 2);
assert("input order preserved", values[0] === 0 && values[1] === 1 && values[2] === 2 && values[4] === 4);
assert("per-item error retained", values[3] instanceof Error && values[3].message === "item failure");
import { CarrierError, type TrackResult } from "./types.js";
import {
  createJtProviderTracker,
  getJtProviderBatchSize,
  parseJtProvider,
} from "./carriers/jt-provider.js";

const sample = (waybillNo: string): TrackResult => ({
  carrier: "jt", carrierName: "J&T Express", waybillNo, found: true,
  latestStatus: "In Transit", latestStatusDetail: "Moving", latestTime: null,
  normalizedStatus: "In Transit", undeliveryReason: null,
  events: [{ time: null, status: "Moving", description: "Moving" }],
  extra: { retained: true }, warnings: ["existing"],
});
assert("provider parser defaults", parseJtProvider(undefined) === "auto" && parseJtProvider(" AUTO ") === "auto");
assert("provider parser accepts explicit values", parseJtProvider("trackingmore") === "trackingmore" && parseJtProvider("TENCENT") === "tencent");
let invalidProvider = false;
try { parseJtProvider("other"); } catch (error) { invalidProvider = error instanceof CarrierError && error.statusCode === 400; }
assert("provider parser rejects invalid values", invalidProvider);

assert("provider batch sizes", getJtProviderBatchSize("auto") === 20 && getJtProviderBatchSize("trackingmore") === 20 && getJtProviderBatchSize("tencent") === 10);

const original = sample("JTE1");
let tmCalls = 0;
let tencentCalls = 0;
const tracker = createJtProviderTracker({
  trackingmore: async () => { tmCalls++; throw new Error("upstream unavailable"); },
  trackingmoreBatch: async () => { tmCalls++; throw new Error("upstream unavailable"); },
  tencent: async (wb) => { tencentCalls++; return wb === "JTE1" ? original : sample(wb); },
  tencentBatch: async (wbs) => { tencentCalls++; return wbs.map(sample); },
});
const fallback = await tracker.trackJt("JTE1");
assert("auto falls back on provider failure", tmCalls === 1 && tencentCalls === 1 && fallback.extra?.source === "tencent" && fallback.extra?.provider === "tencent" && fallback.extra?.requestedProvider === "auto" && fallback.extra?.fallback === true);
assert("fallback adds transparent warning", fallback.warnings?.some((w) => w.includes("upstream unavailable")) === true);
assert("orchestrator does not mutate shared result", original.extra?.source === undefined && original.warnings?.length === 1 && fallback.events !== original.events);
let explicitFailed = false;
try { await tracker.trackJt("JTE1", { provider: "trackingmore" }); } catch { explicitFailed = true; }
assert("explicit TrackingMore does not fallback", explicitFailed && tencentCalls === 1);
const explicitTencent = await tracker.trackJt("JTE2", { provider: "tencent" });
assert("explicit Tencent bypasses TrackingMore", explicitTencent.extra?.source === "tencent" && explicitTencent.extra?.fallback === false && tmCalls === 2);

const fallbackSizes: number[] = [];
const batchTracker = createJtProviderTracker({
  trackingmore: async (wb) => sample(wb),
  trackingmoreBatch: async () => { throw new Error("TrackingMore outage"); },
  tencent: async (wb) => sample(wb),
  tencentBatch: async (waybills) => { fallbackSizes.push(waybills.length); return waybills.map(sample); },
});
const twenty = Array.from({ length: 20 }, (_, index) => `JTE${index}`);
const fallbackBatch = await batchTracker.trackJtBatch(twenty, { provider: "auto" });
assert("failed auto group splits fallback into Tencent groups of ten", fallbackSizes.join(",") === "10,10");
assert("split fallback preserves order", fallbackBatch.map((result) => result.waybillNo).join(",") === twenty.join(","));
let tencentOversizeRejected = false;
try { await batchTracker.trackJtBatch(twenty, { provider: "tencent" }); } catch (error) { tencentOversizeRejected = error instanceof CarrierError && error.statusCode === 400; }
assert("Tencent batches reject more than ten", tencentOversizeRejected);

console.log(`Bulk/provider tests: ${passed} passed`);
