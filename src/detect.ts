import type { Carrier } from "./types.js";

/**
 * Attempt to detect the carrier from a waybill number alone.
 *
 *  - iMile waybills are all-digit, 11-13 chars (samples: 6050926815554, 6051226645152).
 *  - J&T Express waybills are "JTE" + 12 digits.
 *  - Injaz Express waybills are "INJAZ" + digits.
 *  - JDW Logistics waybills are "JDW" + digits.
 *  - Naqel Express waybills are typically 9-10 plain digits (sample: 397965386).
 *
 * Returns `null` if we cannot make a confident guess; callers should then
 * either ask the user to pick a carrier, or fan out across all of them.
 */
export function detectCarrier(waybillNo: string): Carrier | null {
  const w = waybillNo.trim().toUpperCase();

  if (/^JTE\d{10,14}$/.test(w)) return "jt";
  if (/^JDW\d{6,16}$/.test(w)) return "jdw";
  if (/^INJAZ[A-Z0-9]{4,16}$/.test(w)) return "injaz";
  // Naqel waybills: 9-digit all-numeric (shorter than iMile's 11-16 digits)
  if (/^\d{7,9}$/.test(w)) return "naqel";
  if (/^\d{10,16}$/.test(w)) return "imile";
  // Naqel uses short all-digit waybills (typically 8-10 chars, e.g. 397965386).
  if (/^\d{7,10}$/.test(w)) return "naqel";

  return null;
}

export const ALL_CARRIERS: Carrier[] = ["imile", "injaz", "jt", "jdw", "naqel"];

export const CARRIER_NAMES: Record<Carrier, string> = {
  imile: "iMile",
  injaz: "Injaz Express",
  jt: "J&T Express",
  jdw: "JDW Logistics (Jingdong)",
  naqel: "Naqel Express",
};
