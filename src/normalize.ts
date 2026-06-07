import type { Carrier, NormalizedStatus, TrackEvent } from "./types.js";

/**
 * Maps the latest tracking event text to one of four canonical statuses.
 *
 * Matching is case-insensitive and considers both the event `status` and its
 * `description` together. The optional `carrier` argument enables
 * carrier-specific rules — several carriers emit intermediate "return"-like
 * events that do NOT mean the shipment is finally returned (another delivery
 * attempt is still expected), so those are kept as "In Transit".
 *
 * Rules (checked in order):
 *   Out for Delivery  – when the latest event is an out-for-delivery scan
 *   Delivered         – "delivered", "تم التسليم", "signed" (excluding
 *                       "not delivered" / "failed" / "cancel" / "attempted")
 *   Returned          – carrier-specific final-return phrases (see isReturned)
 *   In Transit        – everything else that isn't empty
 */
export function normalizeStatus(
  status: string | null | undefined,
  description?: string | null,
  carrier?: Carrier
): NormalizedStatus | null {
  const statusText = (status ?? "").toLowerCase().trim();
  const descText = (description ?? "").toLowerCase().trim();
  const combined = `${statusText} ${descText}`.trim();
  if (!combined) return null;

  // Out for Delivery — per requirement, if the latest event is an
  // out-for-delivery scan it is always categorised as "Out for Delivery".
  if (isOutForDelivery(combined)) return "Out for Delivery";

  // Returned — checked before Delivered because some final-return events also
  // contain words like "signed" (e.g. J&T "Returned signed").
  if (isReturned(combined, carrier)) return "Returned";

  // Delivered
  if (isDelivered(combined)) return "Delivered";

  // Everything else with content → In Transit
  return "In Transit";
}

function isOutForDelivery(t: string): boolean {
  return (
    t.includes("out for delivery") ||
    t.includes("on the way") ||
    (t.includes("courier") && !t.includes("return")) ||
    t.includes("delivering") ||
    t.includes("delivery scan") ||
    t === "delivery"
  );
}

function isDelivered(t: string): boolean {
  // Negative guards — these are NOT a delivery even though they contain
  // "deliver"/"signed" substrings.
  if (
    t.includes("not delivered") ||
    t.includes("undelivered") ||
    t.includes("un-delivered") ||
    t.includes("delivery failed") ||
    t.includes("failed delivery") ||
    t.includes("failed") ||
    t.includes("attempt") ||
    t.includes("cancel") ||
    t.includes("unable to deliver") ||
    t.includes("could not be delivered") ||
    t.includes("couldn't be delivered")
  ) {
    return false;
  }
  return (
    t.includes("delivered") ||
    t.includes("تم التسليم") ||
    t.includes("signed") ||
    t === "sign scan"
  );
}

/**
 * Carrier-specific detection of a *final* return.
 *
 * Several carriers emit intermediate return-like events that simply mean the
 * parcel went back to a facility/station and will be re-attempted; those must
 * stay "In Transit". Only the phrases below indicate a true, final return.
 */
function isReturned(t: string, carrier?: Carrier): boolean {
  switch (carrier) {
    case "imile":
      // Only "Return Handling Process" marks an iMile shipment as returned.
      return t.includes("return handling process");
    case "jdw":
      // "Return to Station" / "returned to the station" => another attempt,
      // keep in transit. Final return is "is ready to return to senders address".
      return (
        t.includes("ready to return to sender") || t.includes("returned to sender")
      );
    case "naqel":
      // "Returned to Naqel Facility" => another attempt, keep in transit.
      // Final return is "Shipment Returned to Origin".
      return t.includes("returned to origin");
    case "injaz":
      // "Not Delivered/Cancel" => keep in transit. Final return is
      // "Returned to logistics".
      return t.includes("returned to logistics");
    case "jt":
      return (
        t.includes("returned to the sender") ||
        t.includes("returned to sender") ||
        t.includes("return to sender") ||
        t.includes("returned signed") ||
        t.includes("returned to logistics")
      );
    default:
      // Generic fallback for unknown carriers / direct callers.
      return (
        t.includes("return to sender") ||
        t.includes("returned to sender") ||
        t.includes("returned to the sender") ||
        t.includes("returned to origin") ||
        t.includes("returned to logistics") ||
        t.includes("return handling process") ||
        t.includes("rto")
      );
  }
}

// ─── Undelivery-reason extraction ───────────────────────────────────────────

const UNDELIVERY_PATTERNS: RegExp[] = [
  /not delivered/i,
  /undelivered/i,
  /un-delivered/i,
  /delivery failed/i,
  /failed delivery/i,
  /delivery attempt/i,
  /attempted/i,
  /unable to deliver/i,
  /could not be delivered/i,
  /couldn't be delivered/i,
  /cannot be delivered/i,
  /customer.*(?:not available|unavailable|absent|not at home|not reachable|unreachable|didn't respond|did not respond|no response|refused|rejected|cancel)/i,
  /wrong address/i,
  /incorrect address/i,
  /incomplete address/i,
  /address.*(?:issue|problem|incorrect|wrong|incomplete)/i,
  /refused/i,
  /rejected/i,
  /cancel/i,
  /no money/i,
  /insufficient fund/i,
  /lack of fund/i,
  /not paid/i,
  /no.*(?:answer|response|reply)/i,
  /closed/i,
  /return.*(?:handling|process|sender|origin|logistics)/i,
  /rescheduled/i,
  /out of.*(?:area|zone|coverage)/i,
  /damaged/i,
  /lost/i,
  /shipment on hold/i,
  /on hold/i,
  /held at/i,
  /待取件|拒收|拒签|取消/,
];

/**
 * Scan tracking events (assumed newest-first) and return the most recent
 * description that explains why a shipment was not delivered.
 *
 * Returns `null` when:
 *  - the shipment is delivered
 *  - no event matches any known undelivery keyword
 */
export function extractUndeliveryReason(
  events: TrackEvent[],
  normalizedStatus: NormalizedStatus | null,
): string | null {
  // Nothing to extract for delivered shipments or missing status.
  if (!normalizedStatus || normalizedStatus === "Delivered") return null;

  for (const ev of events) {
    const text = `${ev.status ?? ""} ${ev.description ?? ""}`.trim();
    if (!text) continue;
    for (const re of UNDELIVERY_PATTERNS) {
      if (re.test(text)) {
        // Prefer the description over the bare status label when available.
        return (ev.description && ev.description.trim()) || (ev.status ?? text);
      }
    }
  }
  return null;
}
