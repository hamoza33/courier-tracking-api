import * as cheerio from "cheerio";
import { CarrierError, type TrackEvent, type TrackResult } from "../types.js";

/**
 * Injaz Express simply renders an HTML page in response to a form POST.
 * No authentication or CAPTCHA is required.
 */
export async function trackInjaz(waybillNo: string): Promise<TrackResult> {
  const wb = waybillNo.trim();
  const body = new URLSearchParams({ order: wb }).toString();

  let resp: Response;
  try {
    resp = await fetch("https://injaz-express.com/track_order.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://injaz-express.com/index.php",
        // The Injaz Apache server occasionally truncates chunked gzip responses
        // mid-stream, which makes undici abort the request with `terminated`.
        // Asking for an uncompressed response avoids that path entirely.
        "Accept-Encoding": "identity",
      },
      body,
    });
  } catch (err) {
    throw new CarrierError("injaz", `Network error contacting Injaz Express: ${(err as Error).message}`);
  }

  if (!resp.ok) {
    throw new CarrierError("injaz", `Injaz Express responded HTTP ${resp.status}`);
  }

  const html = await resp.text();
  const $ = cheerio.load(html);

  const events: TrackEvent[] = [];
  $(".ant-timeline-item").each((_, el) => {
    const status = $(el).find(".orderTravel_status").first().text().trim();
    const time = $(el).find(".orderTravel_time").first().text().trim();
    if (!status && !time) return;
    events.push({
      time: time || null,
      status: status || null,
      description: status,
      location: null,
    });
  });

  // The Injaz timeline is rendered oldest -> newest in DOM order; reverse so newest is first.
  events.reverse();

  return {
    carrier: "injaz",
    carrierName: "Injaz Express",
    waybillNo: wb,
    found: events.length > 0,
    latestStatus: events[0]?.status ?? null,
    latestTime: events[0]?.time ?? null,
    events,
  };
}
