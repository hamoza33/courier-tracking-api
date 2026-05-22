import * as cheerio from "cheerio";
import { CarrierError, type TrackEvent, type TrackResult } from "../types.js";

const NAQEL_BASE = "https://www.naqelexpress.com";
const NAQEL_GET_URL = `${NAQEL_BASE}/en/tracking/`;
const NAQEL_POST_URL = `${NAQEL_BASE}/en/sa/tracking/`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/** Convert "March 14, 2026" + "7:54 AM" -> "2026-03-14 07:54" (best-effort). */
function combineDateTime(dateText: string, timeText: string): string {
  const date = dateText.trim();
  const time = timeText.trim();

  const m = date.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  let iso = date;
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month) {
      const day = m[2].padStart(2, "0");
      iso = `${m[3]}-${month}-${day}`;
    }
  }

  const tm = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (tm) {
    let hour = Number(tm[1]);
    const minute = tm[2];
    const ampm = tm[3]?.toUpperCase();
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
    return `${iso} ${String(hour).padStart(2, "0")}:${minute}`;
  }
  return iso + (time ? ` ${time}` : "");
}

/** Pull text out of a "<i class='fa ...'></i> CONTENT" cell, stripping the icon. */
function pillText($el: cheerio.Cheerio<any>): string {
  return $el.clone().find("i").remove().end().text().trim();
}

/** Parse cookies from Set-Cookie headers (handles fetch headers.getSetCookie / .raw / iteration). */
function parseSetCookies(resp: Response): string[] {
  // Node fetch (undici) exposes getSetCookie() per WHATWG.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyHeaders = resp.headers as any;
  if (typeof anyHeaders.getSetCookie === "function") {
    const arr = anyHeaders.getSetCookie() as string[];
    if (arr && arr.length > 0) return arr;
  }
  // Fallback: combined Set-Cookie header (may have multiple cookies joined by ", ")
  const single = resp.headers.get("set-cookie");
  if (!single) return [];
  // Split safely: each cookie pair starts after "; ", and individual cookies
  // are separated by ", " but commas may also appear inside Expires=... values.
  return single.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
}

/** Turn an array of Set-Cookie strings into a single Cookie header value. */
function cookieHeaderFrom(setCookies: string[]): string {
  const pairs: string[] = [];
  for (const c of setCookies) {
    const first = c.split(";")[0]?.trim();
    if (first) pairs.push(first);
  }
  return pairs.join("; ");
}

export async function trackNaqel(waybillNo: string): Promise<TrackResult> {
  const wb = waybillNo.trim();

  // Step 1: GET the tracking page to pick up CSRF token + session cookie.
  let getResp: Response;
  try {
    getResp = await fetch(NAQEL_GET_URL, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
      },
      redirect: "follow",
    });
  } catch (err) {
    throw new CarrierError("naqel", `Network error contacting Naqel Express: ${(err as Error).message}`);
  }
  if (!getResp.ok) {
    throw new CarrierError("naqel", `Naqel Express tracking page responded HTTP ${getResp.status}`);
  }

  const setCookies = parseSetCookies(getResp);
  const cookie = cookieHeaderFrom(setCookies);
  const getHtml = await getResp.text();
  const csrfMatch =
    getHtml.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/) ||
    /* Some Django templates use single quotes */ getHtml.match(
      /name='csrfmiddlewaretoken'\s+value='([^']+)'/
    );
  const csrf = csrfMatch?.[1];
  if (!csrf) {
    throw new CarrierError(
      "naqel",
      "Could not obtain CSRF token from Naqel Express tracking page"
    );
  }

  // Step 2: POST the waybill.
  const form = new URLSearchParams({
    csrfmiddlewaretoken: csrf,
    waybills: wb,
  }).toString();

  let postResp: Response;
  try {
    postResp = await fetch(NAQEL_POST_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        Origin: NAQEL_BASE,
        Referer: NAQEL_GET_URL,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: form,
      redirect: "follow",
    });
  } catch (err) {
    throw new CarrierError("naqel", `Network error contacting Naqel Express: ${(err as Error).message}`);
  }
  if (!postResp.ok) {
    throw new CarrierError("naqel", `Naqel Express tracking POST responded HTTP ${postResp.status}`);
  }

  const html = await postResp.text();
  const $ = cheerio.load(html);

  // Parse summary table (SHIPMENT NO / DESTINATION / EXPECTED DELIVERY / PICKUP / CURRENT STATUS)
  const extra: Record<string, unknown> = {};
  let currentStatus: string | null = null;
  $("table.table.table-striped tr.trborder").each((_, el) => {
    const th = $(el).find("th").first().text().trim();
    const td = $(el).find("td").first().text().trim();
    const th2 = $(el).find("th").eq(1).text().trim();
    if (!th) return;
    const key = th.replace(/:\s*$/, "").trim();
    if (/current\s*status/i.test(key)) {
      currentStatus = (th2 || td || "").trim() || null;
      return;
    }
    if (td) extra[key] = td;
  });

  // Parse timeline events. The "Shipment Details" panel groups events under
  // date headers. Each group is a <div class="row"> containing first a
  // "<div class=\"col-md-12 rounded-pill border-dangerTrack ...\">" with the
  // date label, then 1..N event <div class="col-md-12"><div class="row">…</div></div>
  // entries with [status, location, time] columns.
  const events: TrackEvent[] = [];
  // Find every date "pill" header in the document. Each pill marks the start
  // of an event group; events for that date are the .col-md-12 siblings that
  // follow until the next date pill.
  $(".rounded-pill.border-dangerTrack").each((_, dateEl) => {
    // The date header row is followed by event rows up until the next date header.
    const dateText = $(dateEl).find("p").first().text().trim();
    let $node = $(dateEl).parent().nextAll().first(); // start scanning siblings after the date pill's container

    // The actual document structure puts each event as a sibling
    // .col-md-12 that follows the .rounded-pill column.
    while ($node.length && !$node.find(".rounded-pill.border-dangerTrack").length) {
      if ($node.hasClass("col-md-12")) {
        const status = pillText($node.find(".trackMobile").first()).trim() ||
          pillText($node.find("p.text-white").first()).trim();
        const location = pillText($node.find("p:has(i.fa-map-marker)").first());
        const time = pillText($node.find("p:has(i.fa-clock-o)").first());
        if (status || location || time) {
          events.push({
            time: combineDateTime(dateText, time),
            status,
            description: status,
            location: location || null,
          });
        }
      }
      $node = $node.nextAll().first();
    }
  });

  // Fallback walk: scan every .col-md-12 in document order, treating date
  // pills as group markers and other .col-md-12s as event rows.
  if (events.length === 0) {
    let currentDate = "";
    $("div.col-md-12").each((_, el) => {
      const $el = $(el);
      if ($el.hasClass("rounded-pill")) {
        currentDate = $el.find("p").first().text().trim();
        return;
      }
      const status = pillText($el.find(".trackMobile").first()).trim() ||
        pillText($el.find("p.text-white").first()).trim();
      const location = pillText($el.find("p:has(i.fa-map-marker)").first());
      const time = pillText($el.find("p:has(i.fa-clock-o)").first());
      if (status || location || time) {
        events.push({
          time: combineDateTime(currentDate, time),
          status,
          description: status,
          location: location || null,
        });
      }
    });
  }

  // Naqel renders newest first within each date group; keep that order so
  // events[0] is the most recent (consistent with other carriers).
  return {
    carrier: "naqel",
    carrierName: "Naqel Express",
    waybillNo: wb,
    found: events.length > 0,
    latestStatus: events[0]?.status ?? currentStatus,
    latestTime: events[0]?.time ?? null,
    events,
    extra,
  };
}
