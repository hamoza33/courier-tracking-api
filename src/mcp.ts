/**
 * MCP (Model Context Protocol) server for the courier-tracking-api.
 *
 * Exposes the existing tracking functionality as MCP tools so that
 * MCP-compatible clients (Claude Desktop, Cursor, n8n, ChatGPT custom
 * connectors that support Bearer auth, etc.) can call them.
 *
 * Tools:
 *   - track_waybill   — track a single waybill (auto-detect carrier or override)
 *   - track_bulk      — track up to 250 waybills in a single call
 *   - list_carriers   — list supported carriers
 *   - detect_carrier  — preview which carrier the auto-detector would pick
 *
 * The HTTP route (`POST /mcp`) is wired up in `server.ts` and uses the
 * Streamable HTTP transport in stateless mode (one transport + server per
 * request).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { chunkItems, getJtBulkConcurrency, mapConcurrent } from "./bulk.js";
import { ALL_CARRIERS, CARRIER_NAMES, detectCarrier } from "./detect.js";
import { trackImile } from "./carriers/imile.js";
import { trackInjaz } from "./carriers/injaz.js";
import { trackJt, trackJtBatch } from "./carriers/jt.js";
import { trackJdw } from "./carriers/jdw.js";
import { trackNaqel } from "./carriers/naqel.js";
import { normalizeForJson, summarizeForJson } from "./format.js";
import { CarrierError, type Carrier, type TrackResult } from "./types.js";

const CARRIER_VALUES = ["imile", "injaz", "jt", "jdw", "naqel", "auto"] as const;
const ORDER_VALUES = ["desc", "asc"] as const;

type Order = (typeof ORDER_VALUES)[number];

type RunResult =
  | { ok: true; result: TrackResult }
  | { ok: false; error: { message: string; carrier?: Carrier; captchaRequired?: boolean } };

async function runOne(carrier: Carrier, waybill: string, lang?: string): Promise<RunResult> {
  try {
    let result: TrackResult;
    switch (carrier) {
      case "imile":
        result = await trackImile(waybill, lang);
        break;
      case "injaz":
        result = await trackInjaz(waybill);
        break;
      case "jt":
        result = await trackJt(waybill, { lang });
        break;
      case "jdw":
        result = await trackJdw(waybill, lang);
        break;
      case "naqel":
        result = await trackNaqel(waybill);
        break;
    }
    return { ok: true, result };
  } catch (err) {
    if (err instanceof CarrierError) {
      return {
        ok: false,
        error: { message: err.message, carrier: err.carrier, captchaRequired: err.captchaRequired },
      };
    }
    return { ok: false, error: { message: (err as Error).message, carrier } };
  }
}

function applyOrder(result: TrackResult, order: Order): TrackResult {
  if (order === "asc") {
    return { ...result, events: [...result.events].reverse() };
  }
  return result;
}

function asTextContent(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function asErrorContent(message: string, extra?: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, ...extra }, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * Build a fresh `McpServer` instance with all tools registered.
 *
 * For stateless Streamable HTTP we build a new server per request so that
 * concurrent requests do not share state.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "courier-tracking-mcp",
      version: "1.0.0",
    },
    {
      instructions:
        "Aggregator MCP server for five Middle-East courier services (iMile, Injaz Express, J&T Express, JDW Logistics, Naqel Express). Tools: `get_shipment_status` for quick status/reason lookup (no events), `get_shipment_summary` for batch status of up to 50 waybills, `track_waybill` for full event timeline of a single shipment, `track_bulk` for full timelines of up to 250 waybills, `list_carriers` to discover supported carriers, `detect_carrier` to preview auto-detection. All tracking responses include: normalizedStatus, latestStatus, latestStatusDetail, latestTime, undeliveryReason, carrier-specific extra data (origin/destination cities, country). Backed by https://tracking.shopinzo.bond.",
    },
  );

  server.registerTool(
    "list_carriers",
    {
      title: "List supported carriers",
      description: "Return the list of supported couriers and whether each requires CAPTCHA solving.",
      inputSchema: {},
    },
    async () =>
      asTextContent(
        ALL_CARRIERS.map((c) => ({
          code: c,
          name: CARRIER_NAMES[c],
          captchaRequired: c === "jt",
        })),
      ),
  );

  server.registerTool(
    "detect_carrier",
    {
      title: "Detect carrier from waybill",
      description:
        "Preview which carrier the auto-detector would pick for a given waybill, without actually calling the carrier. Returns null if no confident match.",
      inputSchema: {
        waybill: z.string().min(1).describe("Tracking / waybill number"),
      },
    },
    async ({ waybill }) => {
      const carrier = detectCarrier(waybill.trim());
      return asTextContent({
        waybill: waybill.trim(),
        carrier,
        carrierName: carrier ? CARRIER_NAMES[carrier] : null,
      });
    },
  );

  server.registerTool(
    "get_shipment_status",
    {
      title: "Quick shipment status",
      description:
        "Quick status lookup — returns normalizedStatus, latestStatus, latestStatusDetail, latestTime, undeliveryReason, origin/destination cities, and carrier-specific extra data WITHOUT the full event timeline. Much faster for status checks.",
      inputSchema: {
        waybill: z.string().min(1).describe("Tracking / waybill number"),
        carrier: z
          .enum(CARRIER_VALUES)
          .optional()
          .describe("Carrier code, or 'auto' (default). Omit to auto-detect."),
        lang: z
          .string()
          .optional()
          .describe("Language hint for carriers that support it (e.g. 'en', 'ar', 'zh-CN')."),
      },
    },
    async ({ waybill, carrier, lang }) => {
      const trimmed = waybill.trim();
      const carrierHint = carrier ?? "auto";

      let resolved: Carrier | null = null;
      if (carrierHint !== "auto") {
        resolved = carrierHint as Carrier;
      } else {
        resolved = detectCarrier(trimmed);
      }

      if (resolved) {
        const r = await runOne(resolved, trimmed, lang);
        if (!r.ok) {
          return asErrorContent(r.error.message, {
            carrier: r.error.carrier,
            captchaRequired: r.error.captchaRequired ?? false,
          });
        }
        return asTextContent(summarizeForJson(r.result));
      }

      // Fan out to all carriers
      const fanout = await Promise.all(
        ALL_CARRIERS.map(async (c) => {
          const r = await runOne(c, trimmed, lang);
          if (r.ok && r.result.found) return summarizeForJson(r.result);
          return null;
        }),
      );
      const found = fanout.filter(Boolean);
      if (found.length > 0) return asTextContent(found[0]);
      return asErrorContent("No carrier found tracking data for this waybill");
    },
  );

  server.registerTool(
    "get_shipment_summary",
    {
      title: "Shipment summary with key events",
      description:
        `Returns all shipment metadata plus first/last events for up to 50 waybills. Non-J&T work runs in parallel; J&T uses batches of up to 10 waybills per CAPTCHA (${getJtBulkConcurrency()} concurrent groups, configured by JT_BULK_CONCURRENCY).`,
      inputSchema: {
        waybills: z
          .array(z.string().min(1))
          .min(1)
          .max(50)
          .describe("Array of waybill numbers to summarize (up to 50)."),
        lang: z.string().optional().describe("Language hint for carriers that support it."),
      },
    },
    async ({ waybills, lang }) => {
      const work = waybills.map((wb, index) => ({ index, waybill: wb.trim(), carrier: detectCarrier(wb.trim()) }));
      const results = new Array<unknown>(work.length);
      const nonJtPromise = Promise.all(work.filter((item) => item.carrier !== "jt").map(async ({ index, waybill: trimmed, carrier }) => {
        if (!carrier) { results[index] = { waybill: trimmed, error: "Could not detect carrier" }; return; }
        const r = await runOne(carrier, trimmed, lang);
        results[index] = r.ok ? summarizeForJson(r.result) : { waybill: trimmed, carrier, error: r.error.message };
      }));
      const jtWork = work.filter((item) => item.carrier === "jt");
      const jtGroups = chunkItems(jtWork, 10);
      const jtPromise = mapConcurrent(jtGroups, getJtBulkConcurrency(), async (group) => {
        const batch = await trackJtBatch(group.map((item) => item.waybill), { lang });
        return group.map((item, index) => ({ item, result: summarizeForJson(batch[index]) }));
      });
      const [, jtOutcomes] = await Promise.all([nonJtPromise, jtPromise]);
      jtOutcomes.forEach((outcome, groupIndex) => {
        const group = jtGroups[groupIndex];
        if (outcome instanceof Error) group.forEach((item) => { results[item.index] = { waybill: item.waybill, carrier: "jt", error: outcome.message }; });
        else outcome.forEach(({ item, result }) => { results[item.index] = result; });
      });
      return asTextContent(results);
    },
  );

  server.registerTool(
    "track_waybill",
    {
      title: "Track a single waybill (full events)",
      description:
        "Track a single shipment by waybill number with the FULL event timeline. Returns: carrier, carrierName, waybillNo, found, normalizedStatus (Delivered/In Transit/Out for Delivery/Returned), latestStatus, latestStatusDetail, latestTime, undeliveryReason, events[] (each with step, time, status, description, location, timezone), and extra carrier-specific data (origin city, destination city, country, etc.). Carrier is auto-detected unless explicitly provided.",
      inputSchema: {
        waybill: z.string().min(1).describe("Tracking / waybill number"),
        carrier: z
          .enum(CARRIER_VALUES)
          .optional()
          .describe("Carrier code, or 'auto' (default). Omit to auto-detect."),
        lang: z
          .string()
          .optional()
          .describe("Language hint for carriers that support it (e.g. 'en', 'ar', 'zh-CN')."),
        order: z
          .enum(ORDER_VALUES)
          .optional()
          .describe("Event sort order — 'desc' (default, newest first) or 'asc' (oldest first)."),
      },
    },
    async ({ waybill, carrier, lang, order }) => {
      const trimmed = waybill.trim();
      const sortOrder: Order = order ?? "desc";
      const carrierHint = carrier ?? "auto";

      let resolved: Carrier | null = null;
      if (carrierHint !== "auto") {
        resolved = carrierHint as Carrier;
      } else {
        resolved = detectCarrier(trimmed);
      }

      if (resolved) {
        const r = await runOne(resolved, trimmed, lang);
        if (!r.ok) {
          return asErrorContent(r.error.message, {
            carrier: r.error.carrier,
            captchaRequired: r.error.captchaRequired ?? false,
          });
        }
        return asTextContent(normalizeForJson(applyOrder(r.result, sortOrder), { order: sortOrder }));
      }

      // Detection failed and caller did not pin a carrier -> fan out.
      const fanout = await Promise.all(
        ALL_CARRIERS.map(async (c) => {
          const r = await runOne(c, trimmed, lang);
          if (r.ok) {
            return { carrier: c, result: normalizeForJson(applyOrder(r.result, sortOrder), { order: sortOrder }) };
          }
          return {
            carrier: c,
            error: { message: r.error.message, captchaRequired: r.error.captchaRequired ?? false },
          };
        }),
      );
      return asTextContent(fanout);
    },
  );

  server.registerTool(
    "track_bulk",
    {
      title: "Track multiple waybills (full events)",
      description:
        `Track up to 250 waybills in one call while preserving input order and per-item failures. Non-J&T calls run in parallel; J&T uses batches of up to 10 waybills per CAPTCHA (${getJtBulkConcurrency()} concurrent groups, configured by JT_BULK_CONCURRENCY). Returns full event timelines.`,
      inputSchema: {
        waybills: z
          .array(
            z.union([
              z.string().min(1),
              z.object({
                waybill: z.string().min(1),
                carrier: z.enum(CARRIER_VALUES).optional(),
                lang: z.string().optional(),
              }),
            ]),
          )
          .min(1)
          .max(250)
          .describe(
            "Array of waybill numbers (strings) or { waybill, carrier?, lang? } objects. Up to 250 items.",
          ),
        lang: z.string().optional().describe("Default language for all waybills."),
        order: z.enum(ORDER_VALUES).optional().describe("Event sort order. Default 'desc'."),
      },
    },
    async ({ waybills, lang: defaultLang, order }) => {
      const sortOrder: Order = order ?? "desc";

      const items = waybills.map((w) =>
        typeof w === "string"
          ? { waybill: w, carrier: "auto" as const, lang: defaultLang }
          : { waybill: w.waybill, carrier: w.carrier ?? "auto", lang: w.lang ?? defaultLang },
      );

      // Resolve carrier for each item; split J&T vs non-J&T.
      type ResolvedItem = { waybill: string; carrier: Carrier | null; lang?: string };
      const resolvedItems: ResolvedItem[] = items.map((i) => {
        const trimmed = i.waybill.trim();
        const hint = i.carrier;
        let carrier: Carrier | null = null;
        if (hint !== "auto") {
          carrier = hint as Carrier;
        } else {
          carrier = detectCarrier(trimmed);
        }
        return { waybill: trimmed, carrier, lang: i.lang };
      });

      const jtItems = resolvedItems.filter((i) => i.carrier === "jt");
      const otherItems = resolvedItems.filter((i) => i.carrier !== "jt");

      type Out = {
        waybill: string;
        carrier: string;
        result?: TrackResult;
        error?: { message: string; captchaRequired?: boolean };
      };

      async function runItem(item: ResolvedItem): Promise<Out> {
        if (!item.carrier) {
          return {
            waybill: item.waybill,
            carrier: "unknown",
            error: { message: "Could not detect carrier for this waybill" },
          };
        }
        const r = await runOne(item.carrier, item.waybill, item.lang);
        if (!r.ok) {
          return {
            waybill: item.waybill,
            carrier: item.carrier,
            error: { message: r.error.message, captchaRequired: r.error.captchaRequired ?? false },
          };
        }
        return {
          waybill: item.waybill,
          carrier: item.carrier,
          result: applyOrder(r.result, sortOrder),
        };
      }

      const nonJtResults = await Promise.all(otherItems.map((i) => runItem(i)));
      const jtGroups = chunkItems(jtItems, 10);
      const jtOutcomes = await mapConcurrent(jtGroups, getJtBulkConcurrency(), async (group) => {
        const batch = await trackJtBatch(group.map((item) => item.waybill), { lang: group[0]?.lang });
        return group.map((item, index): Out => ({
          waybill: item.waybill, carrier: "jt", result: applyOrder(batch[index], sortOrder),
        }));
      });
      const jtResults: Out[] = jtOutcomes.flatMap((outcome, groupIndex) => outcome instanceof Error
        ? jtGroups[groupIndex].map((item) => ({ waybill: item.waybill, carrier: "jt", error: { message: outcome.message } }))
        : outcome);

      const merged = [...nonJtResults, ...jtResults];

      // Preserve original input order, including duplicate waybills.
      const queues = new Map<string, Out[]>();
      for (const item of merged) {
        const key = `${item.carrier}\0${item.waybill}`;
        const queue = queues.get(key) ?? [];
        queue.push(item);
        queues.set(key, queue);
      }
      const ordered: Out[] = resolvedItems.map((i) => {
        const key = `${i.carrier ?? "unknown"}\0${i.waybill}`;
        return queues.get(key)?.shift() ?? { waybill: i.waybill, carrier: i.carrier ?? "unknown", error: { message: "Not processed" } };
      });

      // Normalize results for JSON output.
      const finalResults = ordered.map((o) =>
        o.result
          ? { waybill: o.waybill, carrier: o.carrier, result: normalizeForJson(o.result, { order: sortOrder }) }
          : { waybill: o.waybill, carrier: o.carrier, error: o.error },
      );

      return asTextContent({
        total: finalResults.length,
        successful: finalResults.filter((r) => "result" in r && r.result).length,
        failed: finalResults.filter((r) => "error" in r).length,
        results: finalResults,
      });
    },
  );

  return server;
}
