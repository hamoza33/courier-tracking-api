import {
  buildTrackingMoreUrl,
  mapTrackingMoreBatch,
  mapTrackingMoreTrackEnd,
  solveTurnstileWithFallback,
  trackJtTrackingMoreBatch,
  validateTrackingMoreWaybills,
  type TrackingMoreTrackEnd,
} from "./carriers/jt-trackingmore.js";

let passed = 0;
function assert(name: string, condition: boolean): void {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed++;
}

const exact = [" JTE 001/ä? ", "JTE#2"];
assert("validation preserves exact values", validateTrackingMoreWaybills(exact).join("|") === exact.join("|"));
assert(
  "direct URL percent-encodes without trimming",
  buildTrackingMoreUrl(exact) === "https://www.trackingmore.com/track?number=%20JTE%20001%2F%C3%A4%3F%20,JTE%232&express=jtexpress-ae&lang=en",
);
const twentyExact = Array.from({ length: 20 }, (_, i) => ` JTE/${i}?# `);
const twentyUrl = buildTrackingMoreUrl(twentyExact);
assert("twenty direct numbers are retained", twentyUrl.split("number=")[1].split("&express=")[0].split(",").map(decodeURIComponent).join("|") === twentyExact.join("|"));
assert("direct URL has confirmed query shape", twentyUrl.endsWith("&express=jtexpress-ae&lang=en"));
assertThrows("empty batch rejected", () => validateTrackingMoreWaybills([]), "At least one");
assertThrows("blank item rejected", () => validateTrackingMoreWaybills(["JTE1", "   "]), "must not be empty");
assert("twenty-item batch accepted", validateTrackingMoreWaybills(Array.from({ length: 20 }, (_, i) => `JTE${i}`)).length === 20);
assertThrows("more than twenty rejected", () => validateTrackingMoreWaybills(Array.from({ length: 21 }, (_, i) => `JTE${i}`)), "Maximum 20");

const returned: TrackingMoreTrackEnd = {
  loading: false,
  tracking_number: "JTE-RETURN",
  status: "exception",
  substatusDesc: "Exception",
  origin_info: {
    trackinfo: [
      {
        Date: "2026-07-18 22:23:53",
        StatusDescription: "Exception",
        Details: "The Shipment has been returned to the sender!",
        checkpoint_location: "Riyadh, KSA",
      },
      {
        Date: "2026-07-10 10:00:00",
        StatusDescription: "In Transit",
        Details: "Departed station",
      },
    ],
  },
};
const returnedResult = mapTrackingMoreTrackEnd("input", returned);
assert("maps provider waybill", returnedResult.waybillNo === "JTE-RETURN");
assert("return description overrides exception headline", returnedResult.normalizedStatus === "Returned");
assert("canonical return is latest status", returnedResult.latestStatus === "Returned");
assert("normalizes local datetime without inventing timezone", returnedResult.latestTime === "2026-07-18T22:23:53");
assert("maps event location", returnedResult.events[0].location === "Riyadh, KSA");
assert("extracts return reason", returnedResult.undeliveryReason?.includes("returned to the sender") === true);

const unsorted = mapTrackingMoreTrackEnd("JTE-OFD", {
  loading: false,
  number: "JTE-OFD",
  status: "delivery",
  substatusDesc: "Out for Delivery",
  events: [
    { time: "2026-07-01 00:00:00", status: "In Transit", description: "old" },
    { time: "2026-07-03 00:00:00", status: "Out for Delivery", description: "Courier is out for delivery" },
    { time: "2026-07-03 00:00:00", status: "Out for Delivery", description: "Courier is out for delivery" },
  ],
});
assert("sorts events newest first", unsorted.events[0].description === "Courier is out for delivery");
assert("deduplicates events", unsorted.events.length === 2);
assert("maps out for delivery", unsorted.normalizedStatus === "Out for Delivery");

const notFound = mapTrackingMoreTrackEnd(" untouched ", {
  loading: false,
  status: "notfound",
  substatusDesc: "Not Found",
});
assert("not found record", !notFound.found && notFound.events.length === 0);
assert("not found keeps exact requested value", notFound.waybillNo === " untouched ");
assert("not found has no canonical status", notFound.normalizedStatus === null);

const mapped = mapTrackingMoreBatch(["B", "A", "A", "missing"], [
  { loading: false, tracking_number: "A", status: "delivered", substatusDesc: "Delivered" },
  { loading: false, tracking_number: "B", status: "transit", substatusDesc: "In Transit" },
  { loading: false, tracking_number: "A", status: "delivery", substatusDesc: "Out for Delivery" },
]);
assert("batch retains requested order", mapped.map((item) => item.waybillNo).join(",") === "B,A,A,missing");
assert("batch consumes duplicate records once", mapped[1].normalizedStatus === "Delivered" && mapped[2].normalizedStatus === "Out for Delivery");
assert("batch creates missing result", mapped[3].found === false);

let calls: string[] = [];
const primary = await solveTurnstileWithFallback(
  { capsolver: "cap-key", twoCaptcha: "two-key" },
  async (provider) => { calls.push(provider); return "capsolver-token"; },
);
assert("Capsolver is primary", primary.provider === "capsolver" && !primary.fallback && primary.token === "capsolver-token");
assert("2Captcha is not charged after Capsolver success", calls.join(",") === "capsolver");

calls = [];
const fallback = await solveTurnstileWithFallback(
  { capsolver: "cap-key", twoCaptcha: "two-key" },
  async (provider) => {
    calls.push(provider);
    if (provider === "capsolver") throw new Error("Capsolver failed");
    return "2captcha-token";
  },
);
assert("Capsolver failure falls back to 2Captcha", fallback.provider === "2captcha" && fallback.fallback && fallback.token === "2captcha-token");
assert("fallback order is deterministic", calls.join(",") === "capsolver,2captcha");

calls = [];
const secondaryOnly = await solveTurnstileWithFallback(
  { twoCaptcha: "two-key" },
  async (provider) => { calls.push(provider); return "2captcha-token"; },
);
assert("2Captcha works when Capsolver is unconfigured", secondaryOnly.provider === "2captcha" && !secondaryOnly.fallback);
assert("unconfigured Capsolver is skipped", calls.join(",") === "2captcha");

await assertRejects(
  "no solver key rejected",
  solveTurnstileWithFallback({}, async () => "unused"),
  "CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY",
);
await assertRejects("async export validates before browser", trackJtTrackingMoreBatch([]), "At least one");
console.log(`TrackingMore J&T tests: ${passed} passed`);

function assertThrows(name: string, fn: () => unknown, message: string): void {
  try { fn(); } catch (error) {
    assert(name, error instanceof Error && error.message.includes(message));
    return;
  }
  throw new Error(`FAIL: ${name}`);
}

async function assertRejects(name: string, promise: Promise<unknown>, message: string): Promise<void> {
  try { await promise; } catch (error) {
    assert(name, error instanceof Error && error.message.includes(message));
    return;
  }
  throw new Error(`FAIL: ${name}`);
}
