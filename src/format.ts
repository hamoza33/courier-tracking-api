import type { TrackResult } from "./types.js";

/**
 * Render a TrackResult as a plain-text timeline, with one line per event
 * (status / time / location / description), similar to how the carrier
 * websites display their tracking history.
 */
export function formatTrackResultAsText(r: TrackResult): string {
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
    lines.push("");
    lines.push("Timeline (most recent first):");
    lines.push("─".repeat(72));
    for (let i = 0; i < r.events.length; i++) {
      const e = r.events[i];
      const time = e.time ?? "(no time)";
      const status = e.status ?? "—";
      const loc = e.location ? ` @ ${e.location}` : "";
      const tz = e.timezone ? ` ${e.timezone}` : "";
      lines.push(`${i + 1}. [${time}${tz}] ${status}${loc}`);
      if (e.description && e.description !== status) {
        for (const dline of wrap(e.description, 68)) {
          lines.push(`   ${dline}`);
        }
      }
      if (i < r.events.length - 1) lines.push("");
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
  results: { carrier: string; result?: TrackResult; error?: { message: string; captchaRequired?: boolean } }[]
): string {
  const parts: string[] = [];
  for (const item of results) {
    if (item.result) {
      parts.push(formatTrackResultAsText(item.result));
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
