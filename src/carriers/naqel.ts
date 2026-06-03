import * as cheerio from "cheerio";
import { CarrierError, type TrackEvent, type TrackResult } from "../types.js";
import { normalizeStatus } from "../normalize.js";

/**
 * Naqel Express tracking via the public website (HTML scraping).
 * No authentication or CAPTCHA is required.
 */
export async function trackNaqel(waybillNo: string): Promise<TrackResult> {
  const wb = waybillNo.trim();
  const url = `https://www.naqelexpress.com/en/Track/TrackShipment/${encodeURIComponent(wb)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
    });
  } catch (err) {
    throw new CarrierError("naqel", `Network error contacting Naqel Express: ${(err as Error).message}`);
  }

  if (!resp.ok) {
    throw new CarrierError("naqel", `Naqel Express responded HTTP ${resp.status}`);
  }

  const html = await resp.text();
  const $ = cheerio.load(html);

  const events: TrackEvent[] = [];

  const rows = $(".border-dangerTrack").closest(".row");

  rows.each((_, groupEl) => {
    const dateText = $(groupEl).find(".border-dangerTrack .text-light.font-weight-bold").first().text().trim();

    const eventDivs = $(groupEl).find("> .col-md-12");
    eventDivs.each((__, eventEl) => {
      const statusEl = $(eventEl).find(".trackMobile.font-weight-bold");
      const status = statusEl.text().trim();
      if (!status) return;

      const locationEl = $(eventEl).find(".fa-map-marker").parent();
      const location = locationEl.text().trim() || null;

      const timeEl = $(eventEl).find(".fa-clock-o").parent();
      const timeText = timeEl.text().trim() || null;

      let dateTime: string | null = null;
      if (dateText && timeText) {
        dateTime = `${dateText} ${timeText}`;
      } else if (dateText) {
        dateTime = dateText;
      }

      events.push({
        time: dateTime,
        status,
        description: status,
        location,
      });
    });
  });

  const latestEvent = events[0];
  const ns = latestEvent
    ? normalizeStatus(latestEvent.status, latestEvent.description, "naqel")
    : null;

  return {
    carrier: "naqel",
    carrierName: "Naqel Express",
    waybillNo: wb,
    found: events.length > 0,
    latestStatus: latestEvent?.status ?? null,
    latestTime: latestEvent?.time ?? null,
    normalizedStatus: ns,
    events,
  };
}
