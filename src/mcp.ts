/**
 * MCP (Model Context Protocol) server for the courier-tracking-api.
 *
 * Exposes the existing tracking functionality as MCP tools so that
 * MCP-compatible clients (Claude Desktop, Cursor, n8n, ChatGPT custom
 * connectors that support Bearer auth, etc.) can call them.
 *
 * Tools:
 *   - track_waybill   — track a single waybill (auto-detect carrier or override)
 *   - track_bulk      — track up to 100 waybills in a single call
 *   - list_carriers   — list supported carriers
 *   - detect_carrier  — preview which carrier the auto-detector would pick
 *
 * The HTTP route (`POST /mcp`) is wired up in `server.ts` and uses the
 * Streamable HTTP transport in stateless mode (one transport + server per
 * request).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ALL_CARRIERS, CARRIER_NAMES, detectCarrier } from "./detect.js";
import { trackImile } from "./carriers/imile.js";
import { trackInjaz } from "./carriers/injaz.js";
import { trackJt } from "./carriers/jt.js";
import { trackJdw } from "./carriers/jdw.js";
import { trackNaqel } from "./carriers/naqel.js";
import { normalizeForJson } from "./format.js";
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
        "Aggregator MCP server for five Middle-East courier services (iMile, Injaz Express, J&T Express, JDW Logistics, Naqel Express). Use `track_waybill` for a single shipment, `track_bulk` for up to 100 at once, `list_carriers` to discover supported carriers, and `detect_carrier` to preview auto-detection. Backed by https://courier-tracking-api.fly.dev.",
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
    "track_waybill",
    {
      title: "Track a single waybill",
      description:
        "Track a single shipment by waybill number. Carrier is auto-detected from the waybill format unless explicitly provided. If detection fails and no carrier is given, all carriers are queried in parallel.",
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
      title: "Track multiple waybills",
      description:
        "Track up to 100 waybills in a single call. Non-J&T waybills are processed in parallel; J&T waybills are processed sequentially because of CAPTCHA.",
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
          .max(100)
          .describe(
            "Array of waybill numbers (strings) or { waybill, carrier?, lang? } objects. Up to 100 items.",
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
      const jtResults: Out[] = [];
      for (const item of jtItems) {
        jtResults.push(await runItem(item));
      }

      const merged = [...nonJtResults, ...jtResults];

      // Preserve original input order.
      const byKey = new Map(merged.map((m) => [m.waybill, m]));
      const ordered: Out[] = resolvedItems.map(
        (i) =>
          byKey.get(i.waybill) ?? {
            waybill: i.waybill,
            carrier: i.carrier ?? "unknown",
            error: { message: "Not processed" },
          },
      );

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
