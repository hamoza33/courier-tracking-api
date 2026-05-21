import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import { ALL_CARRIERS, CARRIER_NAMES, detectCarrier } from "./detect.js";
import { trackImile } from "./carriers/imile.js";
import { trackInjaz } from "./carriers/injaz.js";
import { trackJt } from "./carriers/jt.js";
import { trackJdw } from "./carriers/jdw.js";
import { trackNaqel } from "./carriers/naqel.js";
import { CarrierError, type Carrier, type TrackResult } from "./types.js";
import {
  formatMultipleAsText,
  formatTrackResultAsText,
  normalizeForJson,
  type FormatOptions,
} from "./format.js";

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

/**
 * Determine ordering preference. Default is "asc" (earliest → most recent),
 * which matches how courier websites typically render their timelines and
 * what users requested. Pass `?order=desc` to flip it.
 */
function orderOf(req: import("fastify").FastifyRequest): "asc" | "desc" {
  const q = req.query as Record<string, string | undefined> | undefined;
  const v = (q?.order ?? "").toLowerCase();
  if (v === "desc" || v === "newest" || v === "reverse") return "desc";
  return "asc";
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
          "Unified tracking API across iMile, Injaz Express, J&T Express, and JDW (JINGDONG) Logistics.",
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
      },
      queryParams: {
        format: "'json' (default) or 'text' — text returns a step-by-step plain-text timeline.",
        order: "'asc' (default, earliest → most recent) or 'desc' to reverse.",
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
      { code: "jt", name: "J&T Express", captchaRequired: true },
    ]
  );

  // ----- tracking endpoints -----

  // GET /track?waybill=...&lang=en[&carrier=imile][&format=text][&pretty=1][&order=asc]
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
            format: {
              type: "string",
              enum: ["json", "text"],
              description: "Response format. 'text' returns a plain-text timeline (one event per line).",
            },
            pretty: {
              type: "string",
              description: "Set to '1' to pretty-print JSON output.",
            },
            order: {
              type: "string",
              enum: ["asc", "desc"],
              description: "Event order. Default 'asc' (earliest → most recent).",
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

      if (carrier === "all") {
        const results = await runAll(waybill, lang);
        return sendResult(req, reply, results, true);
      }
      if (carrier !== "auto") {
        const single = await runOneOrError(carrier as Carrier, waybill, lang);
        return sendResult(req, reply, single, false);
      }
      const detected = detectCarrier(waybill);
      if (!detected) {
        // Fall back to querying every carrier in parallel.
        const results = await runAll(waybill, lang);
        return sendResult(req, reply, results, true);
      }
      const single = await runOneOrError(detected, waybill, lang);
      return sendResult(req, reply, single, false);
    }
  );

  // GET /track/:carrier/:waybill[?format=text&pretty=1&order=asc]
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
            order: { type: "string", enum: ["asc", "desc"] },
          },
        },
      },
    },
    async (req, reply) => {
      const { carrier, waybill } = req.params;
      const lang = req.query.lang;
      const single = await runOneOrError(carrier as Carrier, waybill, lang);
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
    const order = orderOf(req);
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

  // ----- startup -----
  try {
    await fastify.listen({ port: PORT, host: HOST });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
