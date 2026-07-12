import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyExpress from "@fastify/express";
import express from "express";
import type { Request as ExpressRequest } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { ALL_CARRIERS, CARRIER_NAMES, detectCarrier } from "./detect.js";
import { buildMcpServer } from "./mcp.js";
import { CourierMcpOAuthProvider } from "./oauth.js";
import { trackImile } from "./carriers/imile.js";
import { trackInjaz } from "./carriers/injaz.js";
import { trackJt, trackJtBatch } from "./carriers/jt.js";
import { trackJdw } from "./carriers/jdw.js";
import { trackNaqel } from "./carriers/naqel.js";
import { CarrierError, type Carrier, type TrackResult } from "./types.js";
import {
  formatMultipleAsText,
  formatTrackResultAsText,
  normalizeForJson,
  type FormatOptions,
} from "./format.js";
import { chunkItems, getJtBulkConcurrency, mapConcurrent, resolveBulkCarrier } from "./bulk.js";
import { DASHBOARD_HTML } from "./dashboard.js";

type MultiTrackResult = { carrier: string; result?: TrackResult; error?: { message: string; captchaRequired?: boolean } };

function wantsText(req: import("fastify").FastifyRequest): boolean {
  const q = req.query as Record<string, string | undefined> | undefined;
  const fmt = (q?.format ?? "").toLowerCase();
  if (fmt === "text" || fmt === "txt" || fmt === "plain") return true;
  const accept = (req.headers.accept ?? "").toLowerCase();
  if (accept.startsWith("text/plain")) return true;
  return false;
}

function wantsPretty(req: import("fastify").FastifyRequest): boolean {
  const q = req.query as Record<string, string | undefined> | undefined;
  const v = (q?.pretty ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function getOrder(req: import("fastify").FastifyRequest): "asc" | "desc" {
  const q = req.query as Record<string, string | undefined> | undefined;
  const v = (q?.order ?? "").toLowerCase();
  return v === "asc" ? "asc" : "desc";
}

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
  },
  trustProxy: true,
});

async function start() {
  await fastify.register(cors, { origin: true });
  await fastify.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 60),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
  });

  await fastify.register(swagger, {
    openapi: {
      openapi: "3.0.0",
      info: {
        title: "Courier Tracking Aggregator API",
        description:
          "Unified tracking API across iMile, Injaz Express, J&T Express, JDW (JINGDONG) Logistics, and Naqel Express.",
        version: "1.0.0",
      },
      servers: [{ url: `http://localhost:${PORT}` }],
      tags: [
        { name: "tracking", description: "Tracking endpoints" },
        { name: "meta", description: "Service metadata" },
      ],
    },
  });
  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });

  // ----- meta endpoints -----

  fastify.get(
    "/",
    {
      schema: {
        tags: ["meta"],
        summary: "Service banner / quick reference",
        response: {
          200: {
            type: "object",
            properties: {
              name: { type: "string" },
              version: { type: "string" },
              docs: { type: "string" },
              carriers: {
                type: "array",
                items: { type: "object", properties: { code: { type: "string" }, name: { type: "string" } } },
              },
            },
          },
        },
      },
    },
    async () => ({
      name: "Courier Tracking Aggregator API",
      version: "1.0.0",
      docs: "/docs",
      carriers: ALL_CARRIERS.map((c) => ({ code: c, name: CARRIER_NAMES[c] })),
      endpoints: {
        autoDetect: "GET /track?waybill={no}",
        byCarrier: "GET /track/{carrier}/{waybill}",
        carriers: "GET /carriers",
        health: "GET /health",
        mcp: "POST /mcp",
        dashboard: "GET /dashboard",
      },
      queryParams: {
        format: "'json' (default) or 'text' — text returns a step-by-step plain-text timeline.",
        order: "'desc' (default, most recent first) or 'asc' for oldest first.",
        pretty: "'1' for pretty-printed JSON.",
        lang: "Optional language hint, e.g. en, ar.",
        carrier: "On /track: force a carrier (imile|injaz|jdw|naqel|jt) or 'all'.",
      },
    })
  );

  fastify.get(
    "/health",
    { schema: { tags: ["meta"], summary: "Liveness probe" } },
    async () => ({ status: "ok", time: new Date().toISOString() })
  );

  fastify.get(
    "/dashboard",
    { schema: { hide: true } },
    async (_req, reply) => {
      reply.type("text/html").send(DASHBOARD_HTML);
    }
  );

  fastify.get(
    "/carriers",
    {
      schema: {
        tags: ["meta"],
        summary: "List supported carriers",
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                code: { type: "string" },
                name: { type: "string" },
                captchaRequired: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    async () => [
      { code: "imile", name: "iMile", captchaRequired: false },
      { code: "injaz", name: "Injaz Express", captchaRequired: false },
      { code: "jdw", name: "JDW Logistics (JINGDONG)", captchaRequired: false },
      { code: "naqel", name: "Naqel Express", captchaRequired: false },
    ]
  );

  // ----- tracking endpoints -----

  // GET /track?waybill=...&lang=en[&carrier=imile][&format=text][&pretty=1][&order=desc]
  fastify.get<{ Querystring: { waybill?: string; lang?: string; carrier?: string; format?: string; pretty?: string; order?: string } }>(
    "/track",
    {
      schema: {
        tags: ["tracking"],
        summary: "Auto-detect carrier from waybill (or query all if ambiguous)",
        querystring: {
          type: "object",
          required: ["waybill"],
          properties: {
            waybill: { type: "string", description: "Tracking / waybill number" },
            lang: { type: "string", description: "Language preference (e.g. en, ar)" },
            carrier: {
              type: "string",
              enum: ["imile", "injaz", "jt", "jdw", "naqel", "auto", "all"],
              description: "Force a specific carrier, or 'all' to query every carrier in parallel",
            },
            order: {
              type: "string",
              enum: ["desc", "asc"],
              description: "Event sort order. 'desc' (default) = newest first, 'asc' = oldest first.",
            },
            format: {
              type: "string",
              enum: ["json", "text"],
              description: "Response format. 'text' returns a plain-text timeline (one event per line).",
            },
            pretty: {
              type: "string",
              description: "Set to '1' to pretty-print JSON output.",
            },

          },
        },
      },
    },
    async (req, reply) => {
      const { waybill, lang } = req.query;
      if (!waybill) {
        return reply.code(400).send({ error: "waybill is required" });
      }
      const carrier = req.query.carrier ?? "auto";
      const order = getOrder(req);

      if (carrier === "all") {
        const results = await runAll(waybill, lang);
        applyOrderToMulti(results, order);
        return sendResult(req, reply, results, true);
      }
      if (carrier !== "auto") {
        const single = await runOneOrError(carrier as Carrier, waybill, lang);
        applyOrder(single, order);
        return sendResult(req, reply, single, false);
      }
      const detected = detectCarrier(waybill);
      if (!detected) {
        const results = await runAll(waybill, lang);
        applyOrderToMulti(results, order);
        return sendResult(req, reply, results, true);
      }
      const single = await runOneOrError(detected, waybill, lang);
      applyOrder(single, order);
      return sendResult(req, reply, single, false);
    }
  );

  // ----- MCP (Model Context Protocol) endpoint -----

  // The MCP endpoint is gated by OAuth 2.1 + PKCE + Dynamic Client Registration
  // (required by ChatGPT custom MCP connectors). The static MCP_AUTH_TOKEN env
  // var doubles as (a) the password on the OAuth login page and (b) a Bearer
  // admin token accepted directly on /mcp for curl / Claude Desktop / Cursor.
  const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

  if (MCP_AUTH_TOKEN) {
    const publicUrl = process.env.MCP_PUBLIC_URL
      ? new URL(process.env.MCP_PUBLIC_URL)
      : new URL("https://tracking.shopinzo.bond");
    const mcpResourceUrl = new URL("/mcp", publicUrl);

    const oauth = new CourierMcpOAuthProvider(MCP_AUTH_TOKEN);

    // Register @fastify/express so we can mount the MCP SDK's OAuth router
    // (it ships as an Express router). The body parsers are scoped to the
    // specific OAuth paths so they do not interfere with Fastify's own body
    // parsing for the /track* and /mcp routes.
    await fastify.register(fastifyExpress);
    const OAUTH_PATHS = [
      "/register",
      "/token",
      "/authorize",
      "/revoke",
      "/oauth/approve",
    ];
    for (const p of OAUTH_PATHS) {
      fastify.use(p, express.json({ limit: "256kb" }));
      fastify.use(p, express.urlencoded({ extended: false, limit: "256kb" }));
    }
    fastify.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl: publicUrl,
        resourceServerUrl: mcpResourceUrl,
        scopesSupported: ["mcp:tools"],
        resourceName: "Courier Tracking MCP",
      }),
    );
    fastify.use("/oauth/approve", oauth.approveHandler);

    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpResourceUrl);

    // POST /mcp — Streamable HTTP transport, stateless (fresh server per request).
    // Accept either the admin Bearer token (== MCP_AUTH_TOKEN) or a real OAuth
    // access token issued via the authorization code flow.
    fastify.route({
      method: "POST",
      url: "/mcp",
      config: { rateLimit: false },
      schema: { hide: true },
      handler: async (request, reply) => {
        const header = request.headers.authorization ?? "";
        const m = /^Bearer\s+(.+)$/i.exec(header);
        const presented = m?.[1]?.trim();

        let auth: AuthInfo | undefined;

        if (presented && oauth.isAdminToken(presented)) {
          auth = {
            token: presented,
            clientId: "admin",
            scopes: ["mcp:tools"],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          };
        } else if (presented) {
          try {
            auth = await oauth.verifyAccessToken(presented);
          } catch {
            // fall through to 401
          }
        }

        if (!auth) {
          reply.code(401).header(
            "www-authenticate",
            `Bearer realm="Courier Tracking MCP", resource_metadata="${resourceMetadataUrl}"`,
          );
          reply.send({ error: "unauthorized" });
          return;
        }

        (request.raw as ExpressRequest & { auth?: AuthInfo }).auth = auth;

        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcp = buildMcpServer();

        reply.raw.on("close", () => {
          void transport.close().catch(() => {});
          void mcp.close().catch(() => {});
        });

        try {
          await mcp.connect(transport);
          reply.hijack();
          await transport.handleRequest(request.raw, reply.raw, request.body);
        } catch (err) {
          fastify.log.error({ err }, "MCP request failed");
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(500, { "content-type": "application/json" });
            reply.raw.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Internal MCP server error" },
                id: null,
              }),
            );
          } else if (!reply.raw.writableEnded) {
            reply.raw.end();
          }
        }
      },
    });

    // GET/DELETE /mcp — not supported in stateless Streamable HTTP mode.
    fastify.route({
      method: ["GET", "DELETE"],
      url: "/mcp",
      config: { rateLimit: false },
      schema: { hide: true },
      handler: async (_request, reply) => {
        reply.code(405).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        });
      },
    });
  } else {
    // MCP_AUTH_TOKEN not set — expose an open /mcp for local dev only.
    fastify.route({
      method: "POST",
      url: "/mcp",
      config: { rateLimit: false },
      schema: { hide: true },
      handler: async (request, reply) => {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcp = buildMcpServer();
        reply.raw.on("close", () => {
          void transport.close().catch(() => {});
          void mcp.close().catch(() => {});
        });
        try {
          await mcp.connect(transport);
          reply.hijack();
          await transport.handleRequest(request.raw, reply.raw, request.body);
        } catch (err) {
          fastify.log.error({ err }, "MCP request failed");
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(500, { "content-type": "application/json" });
            reply.raw.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Internal MCP server error" },
                id: null,
              }),
            );
          }
        }
      },
    });
    fastify.route({
      method: ["GET", "DELETE"],
      url: "/mcp",
      config: { rateLimit: false },
      schema: { hide: true },
      handler: async (_request, reply) => {
        reply.code(405).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        });
      },
    });
  }

  // GET /track/:carrier/:waybill[?format=text&pretty=1&order=desc]
  fastify.get<{ Params: { carrier: string; waybill: string }; Querystring: { lang?: string; format?: string; pretty?: string; order?: string } }>(
    "/track/:carrier/:waybill",
    {
      schema: {
        tags: ["tracking"],
        summary: "Track via a specific carrier",
        params: {
          type: "object",
          properties: {
            carrier: { type: "string", enum: ["imile", "injaz", "jt", "jdw", "naqel"] },
            waybill: { type: "string" },
          },
          required: ["carrier", "waybill"],
        },
        querystring: {
          type: "object",
          properties: {
            lang: { type: "string" },
            format: { type: "string", enum: ["json", "text"] },
            pretty: { type: "string" },
            order: { type: "string", enum: ["desc", "asc"] },
          },
        },
      },
    },
    async (req, reply) => {
      const { carrier, waybill } = req.params;
      const lang = req.query.lang;
      const order = getOrder(req);
      const single = await runOneOrError(carrier as Carrier, waybill, lang);
      applyOrder(single, order);
      return sendResult(req, reply, single, false);
    }
  );

  /** Render either JSON (default) or text depending on the request. */
  function sendResult(
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    payload: TrackResult | MultiTrackResult[] | { error: string; carrier?: string; captchaRequired?: boolean; statusCode: number },
    isArray: boolean
  ) {
    const order = getOrder(req);
    const fmtOpts: FormatOptions = { order };

    // Error envelope
    if (!Array.isArray(payload) && "error" in payload && "statusCode" in payload) {
      const { statusCode, ...rest } = payload;
      if (wantsText(req)) {
        reply.code(statusCode).type("text/plain; charset=utf-8");
        return `Error: ${rest.error}${rest.captchaRequired ? "\n(CAPTCHA required)" : ""}\n`;
      }
      reply.code(statusCode).type("application/json; charset=utf-8");
      return wantsPretty(req) ? JSON.stringify(rest, null, 2) : rest;
    }

    if (wantsText(req)) {
      reply.type("text/plain; charset=utf-8");
      if (isArray) return formatMultipleAsText(payload as MultiTrackResult[], fmtOpts);
      return formatTrackResultAsText(payload as TrackResult, fmtOpts);
    }

    // JSON: always normalize so the events array is step-by-step (with the
    // carrier name attached to each event) and in chronological order.
    let jsonPayload: unknown;
    if (isArray) {
      jsonPayload = (payload as MultiTrackResult[]).map((m) =>
        m.result
          ? { carrier: m.carrier, result: normalizeForJson(m.result, fmtOpts) }
          : { carrier: m.carrier, error: m.error }
      );
    } else {
      jsonPayload = normalizeForJson(payload as TrackResult, fmtOpts);
    }

    if (wantsPretty(req)) {
      reply.type("application/json; charset=utf-8");
      return JSON.stringify(jsonPayload, null, 2);
    }
    return jsonPayload;
  }

  /** Run one carrier and convert errors into a structured payload (no Fastify reply side-effects). */
  async function runOneOrError(
    carrier: Carrier,
    waybill: string,
    lang: string | undefined
  ): Promise<TrackResult | { error: string; carrier?: string; captchaRequired?: boolean; statusCode: number }> {
    if (!ALL_CARRIERS.includes(carrier)) {
      return { error: `Unknown carrier ${carrier}`, statusCode: 400 };
    }
    try {
      switch (carrier) {
        case "imile":
          return await trackImile(waybill, lang);
        case "injaz":
          return await trackInjaz(waybill);
        case "jt":
          return await trackJt(waybill, { lang });
        case "jdw":
          return await trackJdw(waybill, lang);
        case "naqel":
          return await trackNaqel(waybill);
      }
    } catch (err) {
      if (err instanceof CarrierError) {
        return {
          error: err.message,
          carrier: err.carrier,
          captchaRequired: err.captchaRequired,
          statusCode: err.captchaRequired ? 402 : err.statusCode,
        };
      }
      fastify.log.error(err);
      return { error: (err as Error).message, statusCode: 500 };
    }
  }

  async function runAll(waybill: string, lang?: string) {
    const tasks = ALL_CARRIERS.map((c) =>
      runOneSafe(c, waybill, lang).then((r) => ({ carrier: c, result: r.result, error: r.error }))
    );
    return Promise.all(tasks);
  }

  async function runOneSafe(
    carrier: Carrier,
    waybill: string,
    lang?: string
  ): Promise<{ result?: TrackResult; error?: { message: string; captchaRequired?: boolean } }> {
    try {
      switch (carrier) {
        case "imile":
          return { result: await trackImile(waybill, lang) };
        case "injaz":
          return { result: await trackInjaz(waybill) };
        case "jt":
          return { result: await trackJt(waybill, { lang }) };
        case "jdw":
          return { result: await trackJdw(waybill, lang) };
        case "naqel":
          return { result: await trackNaqel(waybill) };
      }
    } catch (err) {
      if (err instanceof CarrierError) {
        return { error: { message: err.message, captchaRequired: err.captchaRequired } };
      }
      return { error: { message: (err as Error).message } };
    }
  }

  /** Sort events in a single TrackResult according to the requested order. */
  function applyOrder(
    result: TrackResult | { error: string; statusCode: number },
    order: "asc" | "desc"
  ): void {
    if ("error" in result) return;
    if (order === "asc") {
      result.events.reverse();
    }
    // default (desc) = newest first — already how carriers return data
  }

  function applyOrderToMulti(results: MultiTrackResult[], order: "asc" | "desc"): void {
    for (const item of results) {
      if (item.result) applyOrder(item.result, order);
    }
  }

  // ----- bulk tracking endpoint -----

  type BulkItem = { waybill: string; carrier?: string; lang?: string };
  type BulkResultItem = {
    waybill: string;
    carrier: string;
    result?: TrackResult;
    error?: { message: string; captchaRequired?: boolean };
  };

  /**
   * Track a single waybill safely (no throw), returning a BulkResultItem.
   * Uses auto-detect if carrier is not specified.
   */
  async function trackOneBulk(item: BulkItem): Promise<BulkResultItem> {
    const waybill = item.waybill.trim();
    const carrierHint = item.carrier?.toLowerCase() ?? "auto";
    const lang = item.lang;

    let carrier: Carrier | null = null;
    if (carrierHint !== "auto" && ALL_CARRIERS.includes(carrierHint as Carrier)) {
      carrier = carrierHint as Carrier;
    } else {
      carrier = detectCarrier(waybill);
    }

    if (!carrier) {
      return { waybill, carrier: "unknown", error: { message: "Could not detect carrier for this waybill" } };
    }

    const res = await runOneSafe(carrier, waybill, lang);
    return { waybill, carrier, result: res.result, error: res.error };
  }

  // POST /track/bulk
  fastify.post<{ Body: { waybills: (string | BulkItem)[]; lang?: string; order?: string } }>(
    "/track/bulk",
    {
      schema: {
        tags: ["tracking"],
        summary: `Track up to 250 waybills at once. J&T is grouped into batches of up to 10 per CAPTCHA with ${getJtBulkConcurrency()} concurrent groups.`,
        body: {
          type: "object",
          required: ["waybills"],
          properties: {
            waybills: {
              type: "array",
              maxItems: 250,
              items: {
                oneOf: [
                  { type: "string", description: "Waybill number (carrier auto-detected)" },
                  {
                    type: "object",
                    properties: {
                      waybill: { type: "string" },
                      carrier: { type: "string", enum: ["imile", "injaz", "jt", "jdw", "naqel", "auto"] },
                      lang: { type: "string" },
                    },
                    required: ["waybill"],
                  },
                ],
              },
              description: "Array of waybill numbers or objects with waybill + optional carrier/lang. Max 250.",
            },
            lang: { type: "string", description: "Default language for all waybills" },
            order: { type: "string", enum: ["desc", "asc"], description: "Event sort order (default: desc)" },
          },
        },
      },
    },
    async (req, reply) => {
      const { waybills, lang: defaultLang, order: orderParam } = req.body;
      if (!waybills || waybills.length === 0) {
        return reply.code(400).send({ error: "waybills array is required and must not be empty" });
      }
      if (waybills.length > 250) {
        return reply.code(400).send({ error: "Maximum 250 waybills per request" });
      }

      const order = (orderParam ?? "desc") === "asc" ? "asc" as const : "desc" as const;

      // Normalize input: strings become BulkItem objects
      const items: BulkItem[] = waybills.map((w) =>
        typeof w === "string" ? { waybill: w, lang: defaultLang } : { ...w, lang: w.lang ?? defaultLang }
      );

      const jtConcurrency = getJtBulkConcurrency();
      const indexed = items.map((item, index) => ({ item, index, carrier: resolveBulkCarrier(item.waybill, item.carrier) }));
      const orderedResults = new Array<BulkResultItem>(items.length);

      const nonJtPromise = Promise.all(indexed.filter((entry) => entry.carrier !== "jt").map(async (entry) => {
        orderedResults[entry.index] = await trackOneBulk(entry.item);
      }));
      const jtEntries = indexed.filter((entry) => entry.carrier === "jt");
      const jtGroups = chunkItems(jtEntries, 10);
      const jtPromise = mapConcurrent(jtGroups, jtConcurrency, async (group) => {
        const batch = await trackJtBatch(group.map((entry) => entry.item.waybill), { lang: group[0]?.item.lang });
        return group.map((entry, index) => ({ entry, result: batch[index] }));
      });
      const [, jtOutcomes] = await Promise.all([nonJtPromise, jtPromise]);
      jtOutcomes.forEach((outcome, groupIndex) => {
        const group = jtGroups[groupIndex];
        if (outcome instanceof Error) {
          group.forEach((entry) => { orderedResults[entry.index] = { waybill: entry.item.waybill.trim(), carrier: "jt", error: { message: outcome.message } }; });
        } else {
          outcome.forEach(({ entry, result }) => { orderedResults[entry.index] = { waybill: entry.item.waybill.trim(), carrier: "jt", result }; });
        }
      });

      for (const item of orderedResults) {
        if (item.result) applyOrder(item.result, order);
      }

      return reply.send({
        total: orderedResults.length,
        successful: orderedResults.filter((r) => r.result?.found).length,
        failed: orderedResults.filter((r) => r.error).length,
        results: orderedResults,
      });
    }
  );

  // ----- benchmark endpoint -----

  // POST /track/benchmark
  fastify.post<{ Body: { waybills: (string | BulkItem)[]; lang?: string } }>(
    "/track/benchmark",
    {
      schema: {
        tags: ["tracking"],
        summary: "Benchmark: compare processing time for 50 vs 250 tracking numbers",
        body: {
          type: "object",
          required: ["waybills"],
          properties: {
            waybills: {
              type: "array",
              maxItems: 250,
              items: {
                oneOf: [
                  { type: "string" },
                  { type: "object", properties: { waybill: { type: "string" }, carrier: { type: "string" }, lang: { type: "string" } }, required: ["waybill"] },
                ],
              },
              description: "Array of up to 250 waybill numbers. The first 50 are used for the 50-batch benchmark; all are used for the full-batch benchmark.",
            },
            lang: { type: "string", description: "Default language for all waybills" },
          },
        },
      },
    },
    async (req, reply) => {
      const { waybills, lang: defaultLang } = req.body;
      if (!waybills || waybills.length === 0) {
        return reply.code(400).send({ error: "waybills array is required and must not be empty" });
      }
      if (waybills.length > 250) {
        return reply.code(400).send({ error: "Maximum 250 waybills per request" });
      }

      // Normalize input
      const items: BulkItem[] = waybills.map((w) =>
        typeof w === "string" ? { waybill: w, lang: defaultLang } : { ...w, lang: w.lang ?? defaultLang }
      );

      // Helper: run non-J&T without a limit and J&T with the configured worker pool.
      async function runBatch(batch: BulkItem[]): Promise<{ results: BulkResultItem[]; durationMs: number }> {
        const start = performance.now();
        const indexed = batch.map((item, index) => ({ item, index, carrier: resolveBulkCarrier(item.waybill, item.carrier) }));
        const results = new Array<BulkResultItem>(batch.length);
        const nonJtPromise = Promise.all(indexed.filter((entry) => entry.carrier !== "jt").map(async (entry) => {
          results[entry.index] = await trackOneBulk(entry.item);
        }));
        const jtEntries = indexed.filter((entry) => entry.carrier === "jt");
        const jtGroups = chunkItems(jtEntries, 10);
        const jtPromise = mapConcurrent(jtGroups, getJtBulkConcurrency(), async (group) => {
          const batchResults = await trackJtBatch(group.map((entry) => entry.item.waybill), { lang: group[0]?.item.lang });
          return group.map((entry, index) => ({ entry, result: batchResults[index] }));
        });
        const [, outcomes] = await Promise.all([nonJtPromise, jtPromise]);
        outcomes.forEach((outcome, groupIndex) => {
          const group = jtGroups[groupIndex];
          if (outcome instanceof Error) group.forEach((entry) => { results[entry.index] = { waybill: entry.item.waybill.trim(), carrier: "jt", error: { message: outcome.message } }; });
          else outcome.forEach(({ entry, result }) => { results[entry.index] = { waybill: entry.item.waybill.trim(), carrier: "jt", result }; });
        });
        return { results, durationMs: Math.round(performance.now() - start) };
      }

      // Batch of 50 (first 50 items or all if less than 50)
      const batch50 = items.slice(0, 50);
      const result50 = await runBatch(batch50);

      // Batch of 100 (all items)
      const batch100 = items;
      const result100 = await runBatch(batch100);

      return reply.send({
        benchmark: {
          batch50: {
            count: batch50.length,
            durationMs: result50.durationMs,
            successful: result50.results.filter((r) => r.result?.found).length,
            failed: result50.results.filter((r) => r.error).length,
            avgPerItem: Math.round(result50.durationMs / batch50.length),
          },
          batch100: {
            count: batch100.length,
            durationMs: result100.durationMs,
            successful: result100.results.filter((r) => r.result?.found).length,
            failed: result100.results.filter((r) => r.error).length,
            avgPerItem: Math.round(result100.durationMs / batch100.length),
          },
          comparison: {
            speedupRatio: result50.durationMs > 0 ? +(result100.durationMs / result50.durationMs).toFixed(2) : 0,
            note: "speedupRatio shows how much longer 100 takes compared to 50. Values close to 1.0 mean good parallelism; close to 2.0 means linear scaling.",
          },
        },
        results: result100.results,
      });
    }
  );

  // ----- startup -----
  try {
    await fastify.listen({ port: PORT, host: HOST });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
