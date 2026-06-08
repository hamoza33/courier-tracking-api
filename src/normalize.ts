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
      // "Return Handling Process" or "Returned to Client" marks an iMile
      // shipment as returned.
      return (
        t.includes("return handling process") ||
        t.includes("returned to client")
      );
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
        t.includes("returned to client") ||
        t.includes("rto")
      );
  }
}

// ─── Undelivery-reason extraction ───────────────────────────────────────────

/**
 * Scan tracking events (assumed newest-first) and return the most recent
 * description that explains why a shipment was not delivered.
 *
 * Each carrier has a specific pattern for embedding the failure reason:
 *   - **JDW**: "returned to the station for the reason: 【reason】"
 *   - **Naqel**: "Delivery attempted – reason"
 *   - **iMile**: After an "out for delivery" event, the next event with a
 *     failure description (e.g. "Uncontactable", "Cancel without reason",
 *     "Invalid Number", "NoAnswer").
 *
 * Returns `null` when:
 *  - the shipment is delivered
 *  - no event matches any known undelivery keyword
 */
export function extractUndeliveryReason(
  events: TrackEvent[],
  normalizedStatus: NormalizedStatus | null,
  carrier?: Carrier,
): string | null {
  if (!normalizedStatus || normalizedStatus === "Delivered") return null;

  // Try carrier-specific extraction first.
  const specific = carrier ? extractCarrierSpecificReason(events, carrier) : null;
  if (specific) return specific;

  // Generic fallback: scan for any event matching a known pattern.
  for (const ev of events) {
    const text = `${ev.status ?? ""} ${ev.description ?? ""}`.trim();
    if (!text) continue;
    for (const re of GENERIC_UNDELIVERY_PATTERNS) {
      if (re.test(text)) {
        return (ev.description && ev.description.trim()) || (ev.status ?? text);
      }
    }
  }
  return null;
}

const GENERIC_UNDELIVERY_PATTERNS: RegExp[] = [
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
];

// ─── Carrier-specific reason extractors ─────────────────────────────────────

function extractCarrierSpecificReason(
  events: TrackEvent[],
  carrier: Carrier,
): string | null {
  switch (carrier) {
    case "jdw":
      return extractJdwReason(events);
    case "naqel":
      return extractNaqelReason(events);
    case "imile":
      return extractImileReason(events);
    case "injaz":
      return extractInjazReason(events);
    default:
      return null;
  }
}

/**
 * JDW embeds the failure reason in "Return to Station" events:
 *   "Your package has been returned to the station for the reason: 【reason】"
 * Extract the text inside the first 【…】 bracket pair.
 */
function extractJdwReason(events: TrackEvent[]): string | null {
  for (const ev of events) {
    const desc = ev.description ?? "";
    if (/returned to the station for the reason/i.test(desc)) {
      const m = desc.match(/[\u3010]([^\u3011]+)[\u3011]/);
      if (m) return m[1].trim();
    }
  }
  return null;
}

/**
 * Naqel embeds the reason right after "Delivery attempted – ":
 *   "Delivery attempted – Consignee does not respond - Please contact Naqel ."
 * Strip the trailing " - Please contact Naqel ." boilerplate when present.
 */
function extractNaqelReason(events: TrackEvent[]): string | null {
  for (const ev of events) {
    const text = ev.status ?? ev.description ?? "";
    const m = text.match(/Delivery attempted\s*[–\-]\s*(.+)/i);
    if (m) {
      let reason = m[1].trim();
      reason = reason.replace(/\s*-\s*Please contact Naqel\s*\.?\s*$/i, "").trim();
      if (reason) return reason;
    }
  }
  return null;
}

/**
 * iMile: events are newest-first. The failure reason is the event that
 * immediately follows an "out for delivery" event in chronological order.
 * In newest-first order, that means we look for an "out for delivery" event
 * and then the event BEFORE it in the array is the reason.
 *
 * Examples (newest first):
 *   "Cancel without reason"   ← this is the reason
 *   "Our delivery associate is out for delivery..."
 *   "Shipment is scheduled..."
 *
 * We skip generic boilerplate messages ("We failed to deliver", "Delivery
 * attempt finished", return-handling events) and only pick concise failure
 * descriptions like "Invalid Number", "Uncontactable", "NoAnswer", "Cancel".
 */
function extractImileReason(events: TrackEvent[]): string | null {
  // Scan events array (newest-first). When we find an "out for delivery"
  // event, the event at index i-1 (which is newer / came after) is the reason.
  for (let i = 0; i < events.length; i++) {
    const desc = (events[i].description ?? "").trim();
    if (!/out for delivery/i.test(desc)) continue;

    // Walk backwards (toward newer events) to find the failure reason.
    for (let j = i - 1; j >= 0; j--) {
      const candidate = (events[j].description ?? "").trim();
      if (!candidate) continue;
      // Skip boilerplate / non-reason events
      if (/out for delivery/i.test(candidate)) continue;
      if (/shipment is scheduled/i.test(candidate)) continue;
      if (/we failed to deliver/i.test(candidate)) continue;
      if (/delivery attempt finished/i.test(candidate)) continue;
      if (/shipment return/i.test(candidate)) continue;
      if (/shipment received/i.test(candidate)) continue;
      if (/return handling/i.test(candidate)) continue;
      if (/returned to (?:client|origin)/i.test(candidate)) continue;
      if (/has assigned delivery/i.test(candidate)) continue;
      // "Failed to schedule due to [Reason]" — extract bracket content
      const bracketMatch = candidate.match(/failed to schedule.*\[([^\]]+)\]/);
      if (bracketMatch) return bracketMatch[1].trim();
      // This is the concise failure reason ("Invalid Number", "Uncontactable", etc.)
      return candidate;
    }
    // Found an "out for delivery" but no valid reason before it — stop
    break;
  }
  return null;
}

/**
 * Injaz: status text is formatted as "Not Delivered/Reason".
 * Extract the part after "Not Delivered/" as the reason.
 * Skip the generic "Returned to logistics" wrapper.
 */
function extractInjazReason(events: TrackEvent[]): string | null {
  for (const ev of events) {
    const text = ev.status ?? ev.description ?? "";
    const m = text.match(/Not Delivered\/(\S.*)/i);
    if (m) {
      const reason = m[1].trim();
      if (reason) return reason;
    }
  }
  return null;
}
