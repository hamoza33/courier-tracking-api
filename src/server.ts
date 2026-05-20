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
import { CarrierError, type Carrier, type TrackResult } from "./types.js";

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
      { code: "jt", name: "J&T Express", captchaRequired: true },
      { code: "jdw", name: "JDW Logistics (JINGDONG)", captchaRequired: false },
    ]
  );

  // ----- tracking endpoints -----

  const trackResultSchema = {
    type: "object",
    properties: {
      carrier: { type: "string" },
      carrierName: { type: "string" },
      waybillNo: { type: "string" },
      found: { type: "boolean" },
      latestStatus: { type: ["string", "null"] },
      latestTime: { type: ["string", "null"] },
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            time: { type: ["string", "null"] },
            status: { type: ["string", "null"] },
            description: { type: "string" },
            location: { type: ["string", "null"] },
            timezone: { type: ["string", "null"] },
          },
        },
      },
      extra: { type: "object", additionalProperties: true },
      warnings: { type: "array", items: { type: "string" } },
    },
  } as const;

  // GET /track?waybill=...&lang=en[&carrier=imile]
  fastify.get<{ Querystring: { waybill?: string; lang?: string; carrier?: string } }>(
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
              enum: ["imile", "injaz", "jt", "jdw", "auto", "all"],
              description: "Force a specific carrier, or 'all' to query every carrier in parallel",
            },
          },
        },
        response: { 200: { oneOf: [trackResultSchema, { type: "array", items: trackResultSchema }] } },
      },
    },
    async (req, reply) => {
      const { waybill, lang } = req.query;
      if (!waybill) {
        return reply.code(400).send({ error: "waybill is required" });
      }
      const carrier = req.query.carrier ?? "auto";

      if (carrier === "all") {
        return runAll(waybill, lang);
      }
      if (carrier !== "auto") {
        return runOne(carrier as Carrier, waybill, lang, reply);
      }
      const detected = detectCarrier(waybill);
      if (!detected) {
        // Fall back to querying every carrier in parallel.
        return runAll(waybill, lang);
      }
      return runOne(detected, waybill, lang, reply);
    }
  );

  // GET /track/:carrier/:waybill
  fastify.get<{ Params: { carrier: string; waybill: string }; Querystring: { lang?: string } }>(
    "/track/:carrier/:waybill",
    {
      schema: {
        tags: ["tracking"],
        summary: "Track via a specific carrier",
        params: {
          type: "object",
          properties: {
            carrier: { type: "string", enum: ["imile", "injaz", "jt", "jdw"] },
            waybill: { type: "string" },
          },
          required: ["carrier", "waybill"],
        },
        querystring: {
          type: "object",
          properties: { lang: { type: "string" } },
        },
        response: { 200: trackResultSchema },
      },
    },
    async (req, reply) => {
      const { carrier, waybill } = req.params;
      const lang = req.query.lang;
      return runOne(carrier as Carrier, waybill, lang, reply);
    }
  );

  async function runOne(
    carrier: Carrier,
    waybill: string,
    lang: string | undefined,
    reply: import("fastify").FastifyReply
  ): Promise<TrackResult | undefined> {
    if (!ALL_CARRIERS.includes(carrier)) {
      return reply.code(400).send({ error: `Unknown carrier ${carrier}` });
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
      }
    } catch (err) {
      if (err instanceof CarrierError) {
        const code = err.captchaRequired ? 402 : err.statusCode;
        return reply.code(code).send({
          error: err.message,
          carrier: err.carrier,
          captchaRequired: err.captchaRequired,
        });
      }
      fastify.log.error(err);
      return reply.code(500).send({ error: (err as Error).message });
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
