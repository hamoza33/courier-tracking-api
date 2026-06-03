import type { TrackResult } from "./types.js";

export interface FormatOptions {
  /**
   * Sort order of events. Defaults to "desc" (most recent first), but the API
   * accepts `?order=asc` to render oldest -> newest, matching how most carrier
   * websites display their step-by-step timeline.
   */
  order?: "asc" | "desc";
}

/**
 * Render a TrackResult as a plain-text timeline, with one line per event
 * (status / time / location / description), similar to how the carrier
 * websites display their tracking history.
 */
export function formatTrackResultAsText(r: TrackResult, opts: FormatOptions = {}): string {
  const order = opts.order ?? "asc";
  const lines: string[] = [];
  lines.push(`Carrier:       ${r.carrierName} (${r.carrier})`);
  lines.push(`Waybill:       ${r.waybillNo}`);
  if (r.found) {
    lines.push(`Latest status: ${r.latestStatus ?? "(unknown)"}`);
    if (r.normalizedStatus) {
      lines.push(`Normalized:    ${r.normalizedStatus}`);
    }
    lines.push(`Latest time:   ${r.latestTime ?? "(unknown)"}`);
  } else {
    lines.push("Status:        No tracking events found for this waybill.");
  }

  if (r.extra && Object.keys(r.extra).length > 0) {
    const interesting = Object.entries(r.extra).filter(
      ([, v]) => v !== null && v !== undefined && v !== ""
    );
    if (interesting.length > 0) {
      lines.push("");
      for (const [k, v] of interesting) {
        lines.push(`${pad(`${k}:`, 14)} ${String(v)}`);
      }
    }
  }

  if (r.events.length > 0) {
    const events = order === "asc" ? [...r.events].reverse() : r.events;
    lines.push("");
    lines.push(
      order === "asc"
        ? `Timeline (step-by-step, earliest → most recent) — ${r.carrierName}:`
        : `Timeline (most recent first) — ${r.carrierName}:`
    );
    lines.push("─".repeat(72));
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const time = e.time ?? "(no time)";
      const status = e.status ?? "—";
      const loc = e.location ? ` @ ${e.location}` : "";
      const tz = e.timezone ? ` ${e.timezone}` : "";
      // Include the carrier name on every event so users can copy individual
      // lines and still see which company the update came from.
      lines.push(
        `${pad(String(i + 1) + ".", 4)} [${time}${tz}] ${status}${loc}  — ${r.carrierName}`
      );
      if (e.description && e.description !== status) {
        for (const dline of wrap(e.description, 68)) {
          lines.push(`     ${dline}`);
        }
      }
      if (i < events.length - 1) lines.push("");
    }
  }

  if (r.warnings && r.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of r.warnings) lines.push(`  • ${w}`);
  }

  return lines.join("\n") + "\n";
}

export function formatMultipleAsText(
  results: { carrier: string; result?: TrackResult; error?: { message: string; captchaRequired?: boolean } }[],
  opts: FormatOptions = {}
): string {
  const parts: string[] = [];
  for (const item of results) {
    if (item.result) {
      parts.push(formatTrackResultAsText(item.result, opts));
    } else if (item.error) {
      parts.push(
        `Carrier: ${item.carrier}\nError:   ${item.error.message}${
          item.error.captchaRequired ? "\n         (CAPTCHA required)" : ""
        }\n`
      );
    }
    parts.push("═".repeat(72) + "\n");
  }
  return parts.join("\n");
}

/**
 * Produce a normalized, easy-to-iterate JSON shape for website integrations.
 * Each event becomes a standalone object with the carrier name attached, in
 * chronological order (oldest first) by default.
 */
export function normalizeForJson(r: TrackResult, opts: FormatOptions = {}): {
  carrier: string;
  carrierName: string;
  waybillNo: string;
  found: boolean;
  latestStatus: string | null;
  latestTime: string | null;
  normalizedStatus: TrackResult["normalizedStatus"];
  events: Array<{
    step: number;
    time: string | null;
    status: string | null;
    description: string;
    location: string | null;
    timezone: string | null;
    carrier: string;
    carrierName: string;
  }>;
  extra?: Record<string, unknown>;
} {
  const order = opts.order ?? "asc";
  const ordered = order === "asc" ? [...r.events].reverse() : r.events;
  const events = ordered.map((e, i) => ({
    step: i + 1,
    time: e.time,
    status: e.status,
    description: e.description,
    location: e.location ?? null,
    timezone: e.timezone ?? null,
    carrier: r.carrier,
    carrierName: r.carrierName,
  }));
  return {
    carrier: r.carrier,
    carrierName: r.carrierName,
    waybillNo: r.waybillNo,
    found: r.found,
    latestStatus: r.latestStatus,
    latestTime: r.latestTime,
    normalizedStatus: r.normalizedStatus,
    events,
    extra: r.extra,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      if (line) out.push(line);
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) out.push(line);
  return out;
}
