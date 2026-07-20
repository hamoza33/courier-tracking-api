import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright";
import { CarrierError, type TrackEvent, type TrackResult } from "../types.js";
import { extractUndeliveryReason, normalizeStatus } from "../normalize.js";

const TRACKINGMORE_ORIGIN = "https://www.trackingmore.com";
const TRACKINGMORE_CARRIER = "jtexpress-ae";
const DEFAULT_TURNSTILE_KEY = "0x4AAAAAAAgo2PH-EZFDzaTA";
const CAPSOLVER_URL = "https://api.capsolver.com";
const TWO_CAPTCHA_URL = "https://api.2captcha.com";
const NAVIGATION_TIMEOUT_MS = 60_000;
const RESULT_TIMEOUT_MS = 180_000;
const CAPTCHA_TIMEOUT_MS = 150_000;
const POLL_MS = 1_500;

export interface TrackingMoreOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TrackingMoreTrackEnd {
  loading?: boolean;
  tracking_number?: unknown;
  trackingNumber?: unknown;
  track_number?: unknown;
  number?: unknown;
  status?: unknown;
  substatus?: unknown;
  substatusDesc?: unknown;
  lastEvent?: unknown;
  last_info?: unknown;
  last_time?: unknown;
  origin_info?: unknown;
  origin_data?: unknown;
  destination_info?: unknown;
  destination_data?: unknown;
  [key: string]: unknown;
}

export interface TurnstileParameters {
  sitekey: string;
  action?: string;
  cData?: string;
  chlPageData?: string;
}

interface CaptchaResponse {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: string | number;
  status?: "idle" | "processing" | "ready" | "failed";
  solution?: { token?: string };
}

export type TurnstileSolverName = "capsolver" | "2captcha";

export interface TurnstileSolverKeys {
  capsolver?: string;
  twoCaptcha?: string;
}

export interface TurnstileSolveResult {
  token: string;
  provider: TurnstileSolverName;
  fallback: boolean;
}

export type TurnstileSolver = (provider: TurnstileSolverName) => Promise<string>;


let browser: Browser | null = null;
let browserPromise: Promise<Browser> | null = null;
let browserProxySignature = "";

function text(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim();
  return result || null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstText(source: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return null;
}

/** Validate without rewriting the caller's values; URL construction preserves them byte-for-byte. */
export function validateTrackingMoreWaybills(values: readonly string[]): string[] {
  if (values.length === 0) throw new CarrierError("jt", "At least one J&T waybill is required", { statusCode: 400 });
  if (values.length > 20) throw new CarrierError("jt", "Maximum 20 J&T waybills per TrackingMore batch", { statusCode: 400 });
  if (values.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new CarrierError("jt", "J&T waybills must not be empty", { statusCode: 400 });
  }
  return [...values];
}

/** Navigate straight to `/track`; never touch the carrier page's editable input. */
export function buildTrackingMoreUrl(values: readonly string[]): string {
  const waybills = validateTrackingMoreWaybills(values);
  const encodedNumbers = waybills.map((value) => encodeURIComponent(value)).join(",");
  return `${TRACKINGMORE_ORIGIN}/track?number=${encodedNumbers}&express=${encodeURIComponent(TRACKINGMORE_CARRIER)}&lang=en`;
}

function normalizeTime(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  // TrackingMore commonly returns carrier-local `YYYY-MM-DD HH:mm:ss`. This is
  // ISO 8601 after replacing the separator; do not falsely assign UTC.
  const local = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/);
  if (local) return `${local[1]}T${local[2]}`;
  const epoch = typeof value === "number" ? value : Number.NaN;
  if (Number.isFinite(epoch)) {
    const milliseconds = epoch < 10_000_000_000 ? epoch * 1000 : epoch;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? raw : date.toISOString();
}

function eventFromUnknown(value: unknown): TrackEvent | null {
  const item = record(value);
  if (!item) return null;
  const status = firstText(item, [
    "RawStatus", "rawStatus", "checkpoint_status", "checkpointStatus", "substatus",
    "status", "Status", "substatusDesc", "StatusDescription", "statusDescription",
  ]);
  const statusDescription = firstText(item, ["StatusDescription", "statusDescription"]);
  const details = firstText(item, ["Details", "details"]);
  const description = firstText(item, [
    "description", "Description", "tracking_detail", "info", "Info", "message", "event", "lastEvent",
  ]) ?? (statusDescription && !/^(?:exception|transit|delivered|delivery|pickup)$/i.test(statusDescription)
    ? statusDescription
    : details) ?? statusDescription ?? status ?? "";
  const time = normalizeTime(
    item.Date ?? item.date ?? item.time ?? item.datetime ?? item.checkpoint_time ?? item.checkpoint_date ?? item.createTime,
  );
  const explicitLocation = firstText(item, ["location", "Location", "checkpoint_location", "city", "address"]);
  const location = explicitLocation ?? (statusDescription && description === statusDescription && details && details !== description ? details : null);
  const timezone = firstText(item, ["timezone", "time_zone"]);
  if (!status && !description && !time && !location) return null;
  return { time, status, description, location, timezone };
}

function eventArrays(item: TrackingMoreTrackEnd): unknown[][] {
  const arrays: unknown[][] = [];
  const add = (candidate: unknown): void => { if (Array.isArray(candidate)) arrays.push(candidate); };
  add(item.trackinfo);
  add(item.events);
  add(item.checkpoints);
  for (const info of [record(item.origin_info), record(item.origin_data), record(item.destination_info), record(item.destination_data)]) {
    add(info?.trackinfo);
    add(info?.events);
  }
  return arrays;
}

function timestampRank(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const rank = Date.parse(value);
  return Number.isNaN(rank) ? Number.NEGATIVE_INFINITY : rank;
}

/** Convert one public-page `app.trackEnd` item to the API's existing shape. */
export function mapTrackingMoreTrackEnd(inputWaybill: string, item?: TrackingMoreTrackEnd): TrackResult {
  const events: TrackEvent[] = [];
  if (item) {
    for (const array of eventArrays(item)) {
      for (const rawEvent of array) {
        const event = eventFromUnknown(rawEvent);
        if (event) events.push(event);
      }
    }
    const latestRecord = eventFromUnknown(item.last_info);
    if (latestRecord) events.push(latestRecord);
    if (!latestRecord && text(item.last_info)) {
      const latestDescription = text(item.last_info) ?? "";
      events.push({
        time: normalizeTime(item.last_time),
        status: firstText(item, ["substatusDesc", "substatus", "status"]),
        description: latestDescription,
        location: null,
        timezone: null,
      });
    }
  }

  const seen = new Set<string>();
  const deduplicated = events.filter((event) => {
    const key = JSON.stringify([event.time, event.status, event.description, event.location, event.timezone]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduplicated.sort((a, b) => timestampRank(b.time) - timestampRank(a.time));

  const rawStatus = firstText(item ?? null, ["substatusDesc", "substatus", "status"]);
  const notFound = /^(?:not[ _-]?found|unknown)$/i.test(rawStatus ?? "");
  const latest = deduplicated[0];
  // The page's substatus is the shipment headline. Include the newest carrier
  // scan in normalization so an "Exception" headline with a final return scan
  // correctly becomes Returned, while a real Out-for-Delivery headline wins
  // over an older/ambiguous carrier scan.
  const statusDetail = rawStatus ?? latest?.status ?? null;
  const description = [latest?.status, latest?.description, firstText(item ?? null, ["lastEvent"])]
    .filter(Boolean).join(" ");
  const normalized = !notFound ? normalizeStatus(statusDetail, description, "jt") : null;
  const suppliedNumber = firstText(item ?? null, ["tracking_number", "trackingNumber", "track_number", "number"]);
  const found = Boolean(item) && !notFound && (deduplicated.length > 0 || Boolean(rawStatus && !/^(?:pending|notfound)$/i.test(rawStatus)));

  return {
    carrier: "jt",
    carrierName: "J&T Express",
    waybillNo: suppliedNumber ?? inputWaybill,
    found,
    latestStatus: normalized ?? statusDetail,
    latestStatusDetail: statusDetail,
    latestTime: latest?.time ?? null,
    normalizedStatus: normalized,
    undeliveryReason: extractUndeliveryReason(deduplicated, normalized, "jt"),
    events: deduplicated,
    extra: {
      provider: "TrackingMore",
      trackingMoreStatus: rawStatus,
      trackingMoreSubstatus: text(item?.substatus),
    },
  };
}

/** Match records by exact tracking number when available, otherwise by page order. */
export function mapTrackingMoreBatch(values: readonly string[], trackEnd: readonly TrackingMoreTrackEnd[]): TrackResult[] {
  const used = new Set<number>();
  return values.map((waybill, requestedIndex) => {
    let index = trackEnd.findIndex((item, candidateIndex) => {
      if (used.has(candidateIndex)) return false;
      const number = firstText(item, ["tracking_number", "trackingNumber", "track_number", "number"]);
      return number === waybill;
    });
    if (index < 0 && requestedIndex < trackEnd.length && !used.has(requestedIndex)) index = requestedIndex;
    if (index >= 0) used.add(index);
    return mapTrackingMoreTrackEnd(waybill, index >= 0 ? trackEnd[index] : undefined);
  });
}

function proxyFromEnvironment(): LaunchOptions["proxy"] | undefined {
  const candidates = [process.env.TRACKINGMORE_PROXY_URL, process.env.JT_PROXY_URL];
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    try {
      const url = new URL(candidate.trim());
      if (!/^(?:https?|socks5):$/.test(url.protocol)) continue;
      // Chromium/Playwright cannot authenticate to SOCKS5; allow an unauthenticated one.
      if (url.protocol === "socks5:" && (url.username || url.password)) continue;
      return {
        server: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`,
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function getBrowser(): Promise<Browser> {
  const proxy = proxyFromEnvironment();
  const signature = JSON.stringify(proxy ?? null);
  if (browser?.isConnected() && browserProxySignature === signature) return browser;
  if (browserPromise && browserProxySignature === signature) return browserPromise;
  if (browser?.isConnected()) await browser.close().catch(() => undefined);
  browserProxySignature = signature;
  browserPromise = chromium.launch({
    headless: true,
    proxy,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  }).then((launched) => {
    browser = launched;
    launched.on("disconnected", () => { if (browser === launched) browser = null; });
    return launched;
  }).finally(() => { browserPromise = null; });
  return browserPromise;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

async function captchaRequest(
  provider: TurnstileSolverName,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<CaptchaResponse> {
  const baseUrl = provider === "capsolver" ? CAPSOLVER_URL : TWO_CAPTCHA_URL;
  const label = provider === "capsolver" ? "Capsolver" : "2Captcha";
  const response = await fetch(`${baseUrl}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`${label} ${path} returned HTTP ${response.status}`);
  const result = await response.json() as CaptchaResponse;
  if (result.errorId) throw new Error(`${label} ${result.errorCode ?? "error"}: ${result.errorDescription ?? "request failed"}`);
  return result;
}

async function solveTurnstileProvider(
  provider: TurnstileSolverName,
  apiKey: string,
  pageUrl: string,
  params: TurnstileParameters,
  signal: AbortSignal,
): Promise<string> {
  const task: Record<string, unknown> = {
    type: provider === "capsolver" ? "AntiTurnstileTaskProxyLess" : "TurnstileTaskProxyless",
    websiteURL: pageUrl,
    websiteKey: params.sitekey,
  };
  if (provider === "capsolver") {
    const metadata: Record<string, string> = {};
    if (params.action) metadata.action = params.action;
    if (params.cData) metadata.cdata = params.cData;
    if (params.chlPageData) metadata.chlPageData = params.chlPageData;
    if (Object.keys(metadata).length > 0) task.metadata = metadata;
  } else {
    if (params.action) task.action = params.action;
    if (params.cData) task.data = params.cData;
    if (params.chlPageData) task.pagedata = params.chlPageData;
  }

  const created = await captchaRequest(provider, "createTask", { clientKey: apiKey, task }, signal);
  if ((typeof created.taskId !== "string" && typeof created.taskId !== "number") || !created.taskId) {
    throw new Error(`${provider === "capsolver" ? "Capsolver" : "2Captcha"} did not return a valid task ID`);
  }
  const pollMs = provider === "capsolver" ? 1_000 : 3_000;
  while (true) {
    await delay(pollMs, signal);
    const result = await captchaRequest(provider, "getTaskResult", { clientKey: apiKey, taskId: created.taskId }, signal);
    if (result.status === "idle" || result.status === "processing") continue;
    const token = text(result.solution?.token);
    if (result.status !== "ready" || !token) {
      throw new Error(`${provider === "capsolver" ? "Capsolver" : "2Captcha"} returned an invalid Turnstile solution`);
    }
    return token;
  }
}

/** Select Capsolver first and use 2Captcha only when Capsolver is unavailable or fails. */
export async function solveTurnstileWithFallback(
  keys: TurnstileSolverKeys,
  solve: TurnstileSolver,
  signal?: AbortSignal,
): Promise<TurnstileSolveResult> {
  if (keys.capsolver) {
    try {
      return { token: await solve("capsolver"), provider: "capsolver", fallback: false };
    } catch (error) {
      if (signal?.aborted || !keys.twoCaptcha) throw error;
      return { token: await solve("2captcha"), provider: "2captcha", fallback: true };
    }
  }
  if (keys.twoCaptcha) {
    return { token: await solve("2captcha"), provider: "2captcha", fallback: false };
  }
  throw new Error("TrackingMore requires CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY");
}

async function prepareContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const captured: Array<Record<string, string>> = [];
    (window as unknown as { __trackingMoreTurnstile: Array<Record<string, string>> }).__trackingMoreTurnstile = captured;
    let current: unknown;
    Object.defineProperty(window, "turnstile", {
      configurable: true,
      get: () => current,
      set(value: unknown) {
        current = value;
        const api = value as { render?: (element: unknown, options?: Record<string, unknown>) => unknown; __tmWrapped?: boolean };
        if (!api?.render || api.__tmWrapped) return;
        const original = api.render.bind(api);
        api.render = (element, options = {}) => {
          captured.push({
            sitekey: String(options.sitekey ?? ""),
            action: String(options.action ?? ""),
            cData: String(options.cData ?? ""),
            chlPageData: String(options.chlPageData ?? ""),
          });
          return original(element, options);
        };
        api.__tmWrapped = true;
      },
    });
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const type = request.resourceType();
    const host = (() => { try { return new URL(request.url()).hostname; } catch { return ""; } })();
    const analytics = /(?:google-analytics|googletagmanager|doubleclick|clarity\.ms|hotjar|hubspot|facebook\.net|linkedin\.com|sentry)/i.test(host);
    if (analytics || type === "image" || type === "media" || type === "font") await route.abort();
    else await route.continue();
  });
}

async function readTurnstile(page: Page): Promise<TurnstileParameters | null> {
  return page.evaluate((fallback) => {
    const win = window as unknown as {
      app?: { showCaptcha?: boolean };
      __trackingMoreTurnstile?: Array<Record<string, string>>;
    };
    const captured = win.__trackingMoreTurnstile?.at(-1);
    const element = document.querySelector<HTMLElement>("[data-sitekey]");
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"]');
    let iframeKey = "";
    try { iframeKey = iframe ? new URL(iframe.src).searchParams.get("k") ?? "" : ""; } catch { /* ignore */ }
    if (!win.app?.showCaptcha && !captured && !element && !iframe) return null;
    return {
      sitekey: captured?.sitekey || element?.dataset.sitekey || iframeKey || fallback,
      action: captured?.action || element?.dataset.action || undefined,
      cData: captured?.cData || element?.dataset.cdata || undefined,
      chlPageData: captured?.chlPageData || element?.dataset.chlPageData || undefined,
    };
  }, DEFAULT_TURNSTILE_KEY);
}

async function readSettledTrackEnd(page: Page, expected: number): Promise<TrackingMoreTrackEnd[] | null> {
  return page.evaluate((count) => {
    const app = (window as unknown as { app?: { trackEnd?: TrackingMoreTrackEnd[] } }).app;
    const items = app?.trackEnd;
    return Array.isArray(items) && items.length >= count && items.slice(0, count).every((item) => item.loading === false)
      ? items.slice(0, count)
      : null;
  }, expected);
}

export async function runBrowserFlow(values: readonly string[], opts: TrackingMoreOptions): Promise<TrackingMoreTrackEnd[]> {
  const solverKeys: TurnstileSolverKeys = {
    capsolver: process.env.CAPSOLVER_API_KEY?.trim(),
    twoCaptcha: process.env.TWOCAPTCHA_API_KEY?.trim(),
  };
  if (!solverKeys.capsolver && !solverKeys.twoCaptcha) {
    throw new CarrierError("jt", "TrackingMore requires CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY", { statusCode: 503, captchaRequired: true });
  }

  const timeoutController = new AbortController();
  const timeoutMs = opts.timeoutMs ?? RESULT_TIMEOUT_MS;
  const timeout = setTimeout(() => timeoutController.abort(new Error(`TrackingMore timed out after ${timeoutMs}ms`)), timeoutMs);
  const externalAbort = (): void => timeoutController.abort(opts.signal?.reason ?? new Error("TrackingMore request aborted"));
  opts.signal?.addEventListener("abort", externalAbort, { once: true });
  let context: BrowserContext | null = null;
  try {
    context = await (await getBrowser()).newContext({
      viewport: { width: 1365, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    await prepareContext(context);
    const page = await context.newPage();
    await page.goto(buildTrackingMoreUrl(values), { waitUntil: "domcontentloaded", timeout: Math.min(NAVIGATION_TIMEOUT_MS, timeoutMs) });

    let captchaSolved = false;
    while (!timeoutController.signal.aborted) {
      const complete = await readSettledTrackEnd(page, values.length);
      if (complete) return complete;
      if (!captchaSolved) {
        const challenge = await readTurnstile(page);
        if (challenge) {
          const captchaController = new AbortController();
          const abortCaptcha = (): void => captchaController.abort(timeoutController.signal.reason);
          timeoutController.signal.addEventListener("abort", abortCaptcha, { once: true });
          const captchaTimer = setTimeout(() => captchaController.abort(new Error(`Turnstile solve timed out after ${CAPTCHA_TIMEOUT_MS}ms`)), CAPTCHA_TIMEOUT_MS);
          try {
            const solved = await solveTurnstileWithFallback(
              solverKeys,
              (provider) => solveTurnstileProvider(
                provider,
                provider === "capsolver" ? solverKeys.capsolver! : solverKeys.twoCaptcha!,
                page.url(),
                challenge,
                captchaController.signal,
              ),
              captchaController.signal,
            );
            await page.waitForFunction(() => typeof (window as unknown as { app?: { verifyCallback?: unknown } }).app?.verifyCallback === "function", undefined, { timeout: 15_000 });
            await page.evaluate((solution) => {
              (window as unknown as { app: { verifyCallback(token: string): void } }).app.verifyCallback(solution);
            }, solved.token);
            captchaSolved = true;
          } finally {
            clearTimeout(captchaTimer);
            timeoutController.signal.removeEventListener("abort", abortCaptcha);
          }
        }
      }
      await delay(POLL_MS, timeoutController.signal);
    }
    throw timeoutController.signal.reason;
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", externalAbort);
    await context?.close().catch(() => undefined);
  }
}

export async function trackJtTrackingMoreBatch(
  waybillNos: readonly string[],
  opts: TrackingMoreOptions = {},
): Promise<TrackResult[]> {
  const values = validateTrackingMoreWaybills(waybillNos);
  try {
    return mapTrackingMoreBatch(values, await runBrowserFlow(values, opts));
  } catch (error) {
    if (error instanceof CarrierError) throw error;
    const message = error instanceof Error ? error.message : "unknown provider error";
    throw new CarrierError("jt", `TrackingMore J&T tracking failed: ${message}`, {
      statusCode: 502,
      captchaRequired: /captcha|turnstile|capsolver|2captcha/i.test(message),
    });
  }
}

export async function trackJtTrackingMore(
  waybillNo: string,
  opts: TrackingMoreOptions = {},
): Promise<TrackResult> {
  return (await trackJtTrackingMoreBatch([waybillNo], opts))[0];
}
