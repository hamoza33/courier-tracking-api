export type Carrier = "imile" | "injaz" | "jt" | "jdw" | "naqel";

export type NormalizedStatus = "Delivered" | "In Transit" | "Out for Delivery" | "Returned";

export interface TrackEvent {
  /** ISO 8601 timestamp when the event occurred, or null if the source did not provide one. */
  time: string | null;
  /** Short status label, e.g. "Out for Delivery", "Delivered". */
  status: string | null;
  /** Detailed description text. */
  description: string;
  /** Optional facility / station / city. */
  location?: string | null;
  /** Optional time zone string as reported by the source. */
  timezone?: string | null;
}

export interface TrackResult {
  /** Carrier code the result is from. */
  carrier: Carrier;
  /** Friendly carrier name. */
  carrierName: string;
  /** Tracking / waybill number queried. */
  waybillNo: string;
  /** Whether the carrier was able to find the shipment. */
  found: boolean;
  /** Latest known status text (== events[0].status when present). */
  latestStatus: string | null;
  /** Latest known status time (ISO). */
  latestTime: string | null;
  /** Canonical status: Delivered | In Transit | Out for Delivery | Returned. */
  normalizedStatus: NormalizedStatus | null;
  /** Track events ordered newest -> oldest (default) or oldest -> newest (?order=asc). */
  events: TrackEvent[];
  /** Optional extra fields returned by the source. */
  extra?: Record<string, unknown>;
  /** Optional non-fatal warnings (e.g. CAPTCHA fallback). */
  warnings?: string[];
}

export class CarrierError extends Error {
  public readonly carrier: Carrier;
  public readonly statusCode: number;
  public readonly captchaRequired: boolean;

  constructor(
    carrier: Carrier,
    message: string,
    opts: { statusCode?: number; captchaRequired?: boolean } = {}
  ) {
    super(message);
    this.name = "CarrierError";
    this.carrier = carrier;
    this.statusCode = opts.statusCode ?? 502;
    this.captchaRequired = opts.captchaRequired ?? false;
  }
}
