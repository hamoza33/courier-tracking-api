import type { NormalizedStatus } from "./types.js";

/**
 * Maps the latest tracking event text to one of four canonical statuses.
 *
 * Matching is case-insensitive. The function checks `status` first, then
 * `description` if status is empty/null.
 *
 * Rules (checked in order):
 *   Delivered         – "delivered", "تم التسليم", "signed"
 *   Out for Delivery  – "out for delivery", "on the way", "courier"
 *   Returned          – "return", "returned", "rto"
 *   In Transit        – everything else that isn't empty
 */
export function normalizeStatus(
  status: string | null | undefined,
  description?: string | null
): NormalizedStatus | null {
  const text = ((status || description) ?? "").toLowerCase().trim();
  if (!text) return null;

  // Delivered
  if (
    text.includes("delivered") ||
    text.includes("تم التسليم") ||
    text.includes("signed") ||
    text === "sign scan"
  ) {
    // Exclude "delivery attempted" — that's not delivered
    if (!text.includes("attempted") && !text.includes("failed") && !text.includes("return")) {
      return "Delivered";
    }
  }

  // Returned — check before Out for Delivery since "returned" might contain "delivery"
  if (
    text.includes("return") ||
    text.includes("rto") ||
    text.includes("returned to") ||
    text.includes("shipment returned") ||
    text.includes("returned signed")
  ) {
    return "Returned";
  }

  // Out for Delivery
  if (
    text.includes("out for delivery") ||
    text.includes("on the way") ||
    (text.includes("courier") && !text.includes("return")) ||
    text === "delivering" ||
    text === "delivery scan" ||
    text === "delivery"
  ) {
    return "Out for Delivery";
  }

  // Everything else with content → In Transit
  return "In Transit";
}
