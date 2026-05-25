import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { IncomingMessage, ServerResponse } from "node:http";

import { ALL_CARRIERS, CARRIER_NAMES, detectCarrier } from "./detect.js";
import { trackImile } from "./carriers/imile.js";
import { trackInjaz } from "./carriers/injaz.js";
import { trackJt } from "./carriers/jt.js";
import { trackJdw } from "./carriers/jdw.js";
import { trackNaqel } from "./carriers/naqel.js";
import { CarrierError, type Carrier, type TrackResult } from "./types.js";
import { normalizeForJson, type FormatOptions } from "./format.js";

async function trackCarrier(
  carrier: Carrier,
  waybill: string,
  lang?: string,
): Promise<TrackResult> {
  switch (carrier) {
    case "imile":
      return trackImile(waybill, lang);
    case "injaz":
      return trackInjaz(waybill);
    case "jt":
      return trackJt(waybill, { lang });
    case "jdw":
      return trackJdw(waybill, lang);
    case "naqel":
      return trackNaqel(waybill);
  }
}

function createMcpServer(): McpServer {
  const mcp = new McpServer(
    { name: "courier-tracking", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  mcp.tool(
    "track_shipment",
    "Track a courier shipment by waybill number. Auto-detects the carrier if not specified.",
    {
      waybill: z.string().describe("Tracking / waybill number"),
      carrier: z
        .enum(["imile", "injaz", "jt", "jdw", "naqel", "auto"])
        .optional()
        .default("auto")
        .describe("Carrier code, or 'auto' to detect from the waybill"),
      lang: z
        .string()
        .optional()
        .describe("Language hint (e.g. en, ar)"),
    },
    async ({ waybill, carrier, lang }) => {
      try {
        let resolved: Carrier | null = null;
        if (carrier && carrier !== "auto") {
          resolved = carrier as Carrier;
        } else {
          resolved = detectCarrier(waybill);
        }

        if (!resolved) {
          const results = await Promise.all(
            ALL_CARRIERS.map(async (c) => {
              try {
                const r = await trackCarrier(c, waybill, lang);
                return { carrier: c, result: r };
              } catch {
                return { carrier: c, result: null };
              }
            }),
          );
          const found = results.filter((r) => r.result?.found);
          if (found.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Could not find tracking info for waybill "${waybill}" across any carrier.`,
                },
              ],
            };
          }
          const payload = found.map((f) => normalizeForJson(f.result!, { order: "desc" }));
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          };
        }

        const result = await trackCarrier(resolved, waybill, lang);
        const json = normalizeForJson(result, { order: "desc" });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(json, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof CarrierError ? err.message : (err as Error).message;
        return {
          content: [{ type: "text" as const, text: `Error tracking ${waybill}: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  mcp.tool(
    "track_bulk",
    "Track multiple waybills at once (up to 100). Auto-detects carriers.",
    {
      waybills: z
        .array(z.string())
        .min(1)
        .max(100)
        .describe("Array of waybill numbers to track"),
      lang: z.string().optional().describe("Default language hint for all waybills"),
    },
    async ({ waybills, lang }) => {
      const results: Array<{
        waybill: string;
        carrier: string;
        result?: ReturnType<typeof normalizeForJson>;
        error?: string;
      }> = [];

      for (const waybill of waybills) {
        const carrier = detectCarrier(waybill);
        if (!carrier) {
          results.push({ waybill, carrier: "unknown", error: "Could not detect carrier" });
          continue;
        }
        try {
          const r = await trackCarrier(carrier, waybill, lang);
          results.push({
            waybill,
            carrier,
            result: normalizeForJson(r, { order: "desc" }),
          });
        } catch (err) {
          const msg = err instanceof CarrierError ? err.message : (err as Error).message;
          results.push({ waybill, carrier, error: msg });
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                total: results.length,
                successful: results.filter((r) => r.result?.found).length,
                failed: results.filter((r) => r.error).length,
                results,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  mcp.tool(
    "list_carriers",
    "List all supported courier carriers",
    {},
    async () => {
      const carriers = ALL_CARRIERS.map((c) => ({
        code: c,
        name: CARRIER_NAMES[c],
        captchaRequired: c === "jt",
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(carriers, null, 2) }],
      };
    },
  );

  mcp.tool(
    "detect_carrier",
    "Detect which courier carrier a waybill number belongs to",
    {
      waybill: z.string().describe("Waybill / tracking number to identify"),
    },
    async ({ waybill }) => {
      const carrier = detectCarrier(waybill);
      if (!carrier) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not auto-detect carrier for "${waybill}". Supported patterns:\n` +
                "  JTE + 10-14 digits → J&T Express\n" +
                "  JDW + 6-16 digits → JDW Logistics\n" +
                "  INJAZ + 4-16 alphanumeric → Injaz Express\n" +
                "  7-9 digits → Naqel Express\n" +
                "  10-16 digits → iMile",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ carrier, name: CARRIER_NAMES[carrier] }),
          },
        ],
      };
    },
  );

  return mcp;
}

const transports = new Map<string, StreamableHTTPServerTransport>();

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  if (req.method === "POST") {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };

    const mcp = createMcpServer();
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}
