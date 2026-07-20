import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { cv } from "opencv-wasm";
import { CarrierError, type TrackEvent, type TrackResult } from "../types.js";
import { normalizeStatus, extractUndeliveryReason } from "../normalize.js";

const JT_URL = "https://www.jtexpress.me/KSA/trajectoryQuery";
const CAPTCHA_SCRIPT = "https://ca.turing.captcha.qcloud.com/TCaptcha-global.js";
const TWOCAPTCHA_API_URL = "https://api.2captcha.com";
const TWOCAPTCHA_POLL_MS = 1000;
const TWOCAPTCHA_TIMEOUT_MS = 120000;

interface TencentSolution { ticket: string; randstr: string }
interface TwoCaptchaResponse {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
  status?: "processing" | "ready";
  solution?: { ticket?: string; randstr?: string };
}

async function twoCaptchaRequest(path: string, body: unknown, signal?: AbortSignal): Promise<TwoCaptchaResponse> {
  let response: Response;
  try {
    response = await fetch(`${TWOCAPTCHA_API_URL}/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    });
  } catch (error) {
    throw new Error(`2Captcha ${path} request failed: ${(error as Error).message}`);
  }
  if (!response.ok) throw new Error(`2Captcha ${path} returned HTTP ${response.status}`);
  let data: TwoCaptchaResponse;
  try { data = await response.json() as TwoCaptchaResponse; }
  catch { throw new Error(`2Captcha ${path} returned invalid JSON`); }
  if (data.errorId) throw new Error(`2Captcha ${data.errorCode ?? "error"}: ${data.errorDescription ?? "unknown error"}`);
  return data;
}

export async function solveTencentCaptcha(
  apiKey: string, appId: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TencentSolution> {
  if (!apiKey.trim()) throw new Error("TWOCAPTCHA_API_KEY is empty");
  if (!appId.trim()) throw new Error("Tencent captcha appId was not detected");
  const created = await twoCaptchaRequest("createTask", {
    clientKey: apiKey,
    task: { type: "TencentTaskProxyless", websiteURL: JT_URL, appId, captchaScript: CAPTCHA_SCRIPT },
  }, opts.signal);
  if (!Number.isInteger(created.taskId) || !created.taskId) throw new Error("2Captcha createTask response did not contain a valid taskId");

  const timeoutMs = opts.timeoutMs ?? TWOCAPTCHA_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, TWOCAPTCHA_POLL_MS);
      opts.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(opts.signal?.reason ?? new Error("aborted")); }, { once: true });
    });
    const result = await twoCaptchaRequest("getTaskResult", { clientKey: apiKey, taskId: created.taskId }, opts.signal);
    if (result.status === "processing") continue;
    if (result.status !== "ready") throw new Error(`2Captcha returned unexpected task status: ${String(result.status)}`);
    const ticket = result.solution?.ticket?.trim();
    const randstr = result.solution?.randstr?.trim();
    if (!ticket || !randstr) throw new Error("2Captcha ready response is missing ticket or randstr");
    return { ticket, randstr };
  }
  throw new Error(`2Captcha Tencent task timed out after ${timeoutMs}ms`);
}

const JT_LANG_MAP: Record<string, string> = {
  en: "EN",
  "en-us": "EN",
  ar: "AR",
  "zh-cn": "CN",
};

// ---------- v2 API response types ----------

interface JtV2Detail {
  scanTypeName?: string | null;
  scanTime?: string | null;
  customerTracking?: string | null;
  status?: string | null;
  scanNetworkName?: string | null;
  scanNetworkCity?: string | null;
  scanNetworkProvince?: string | null;
  [k: string]: unknown;
}

export interface JtV2Response {
  code?: number;
  msg?: string;
  succ?: boolean;
  data?: Array<{
    keyword?: string;
    details?: JtV2Detail[];
  }>;
}

export interface JtOptions {
  lang?: string;
}

// ---------- Shared browser instance ----------

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  return _browser;
}

// ---------- Template-matching slider solver ----------

async function extractPiece(
  compositeImgBuf: Buffer
): Promise<{ buf: Buffer; w: number; h: number } | null> {
  const meta = await sharp(compositeImgBuf).metadata();
  const width = meta.width!;
  const height = meta.height!;
  const buf = await sharp(compositeImgBuf).ensureAlpha().raw().toBuffer();

  let minX = width,
    minY = height,
    maxX = 0,
    maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = buf[idx],
        g = buf[idx + 1],
        b = buf[idx + 2],
        a = buf[idx + 3];
      if (a < 128) continue;
      if (r > 230 && g > 230 && b > 230) continue;
      if (b > 200 && r < 100) continue;
      if (
        Math.abs(r - g) < 5 &&
        Math.abs(g - b) < 5 &&
        r > 180 &&
        r < 220
      )
        continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX <= minX || maxY <= minY) return null;

  const pW = maxX - minX + 1;
  const pH = maxY - minY + 1;
  const pieceBuf = await sharp(compositeImgBuf)
    .extract({ left: minX, top: minY, width: pW, height: pH })
    .toBuffer();
  return { buf: pieceBuf, w: pW, h: pH };
}

async function templateMatch(
  bgBuf: Buffer,
  pieceBuf: Buffer
): Promise<number> {
  const bgMeta = await sharp(bgBuf).metadata();
  const pMeta = await sharp(pieceBuf).metadata();
  const bgRaw = await sharp(bgBuf).ensureAlpha().raw().toBuffer();
  const pRaw = await sharp(pieceBuf).ensureAlpha().raw().toBuffer();

  const bgMat = new cv.Mat(bgMeta.height!, bgMeta.width!, cv.CV_8UC4);
  bgMat.data.set(bgRaw);
  const pMat = new cv.Mat(pMeta.height!, pMeta.width!, cv.CV_8UC4);
  pMat.data.set(pRaw);

  const bgGray = new cv.Mat();
  const pGray = new cv.Mat();
  cv.cvtColor(bgMat, bgGray, cv.COLOR_RGBA2GRAY);
  cv.cvtColor(pMat, pGray, cv.COLOR_RGBA2GRAY);

  const bgEdges = new cv.Mat();
  const pEdges = new cv.Mat();
  cv.Canny(bgGray, bgEdges, 100, 200);
  cv.Canny(pGray, pEdges, 100, 200);

  const result = new cv.Mat();
  cv.matchTemplate(bgEdges, pEdges, result, cv.TM_CCOEFF_NORMED);
  const bestX = cv.minMaxLoc(result).maxLoc.x;

  bgMat.delete(); pMat.delete();
  bgGray.delete(); pGray.delete();
  bgEdges.delete(); pEdges.delete();
  result.delete();

  return bestX;
}

// ---------- Humanlike drag ----------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function humanlikeDrag(
  page: Page,
  startX: number,
  startY: number,
  endX: number
): Promise<void> {
  const totalSteps = 35 + Math.floor(Math.random() * 15);
  const dx = endX - startX;

  await page.mouse.move(startX - 20, startY + 10);
  await sleep(300 + Math.random() * 200);
  await page.mouse.move(startX, startY);
  await sleep(150 + Math.random() * 100);
  await page.mouse.down();
  await sleep(100 + Math.random() * 150);

  for (let i = 1; i <= totalSteps; i++) {
    const t = i / totalSteps;
    const eased =
      t < 0.7
        ? (t / 0.7) * 1.03
        : t < 0.85
          ? 1.03 - ((t - 0.7) / 0.15) * 0.02
          : 1.01 - ((t - 0.85) / 0.15) * 0.01;
    const x = startX + dx * eased + (Math.random() - 0.5) * 0.5;
    const y =
      startY +
      Math.sin(t * Math.PI * 3) * 1.5 +
      (Math.random() - 0.5) * 1;
    await page.mouse.move(x, y);
    await sleep(t < 0.1 || t > 0.9 ? 25 : 8 + Math.random() * 10);
  }
  await page.mouse.move(endX, startY);
  await sleep(30 + Math.random() * 50);
  await page.mouse.up();
}

// ---------- Single captcha solve attempt ----------

async function solveAndTrack(
  browser: Browser,
  waybillNos: readonly string[],
  externalSolver = true,
): Promise<JtV2Response> {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  // The public page lists multiple waybills but normally submits only the selected
  // left-side item. Rewrite that one authenticated request so the same captcha
  // ticket is used with J&T's native waybillNo array (maximum ten).
  if (waybillNos.length > 1) {
    await page.route("**/official/logisticsTracking/v2/getDetailByWaybillNo**", async (route) => {
      const request = route.request();
      try {
        const payload = request.postDataJSON() as Record<string, unknown>;
        await route.continue({ postData: JSON.stringify({ ...payload, waybillNo: [...waybillNos] }) });
      } catch {
        await route.continue();
      }
    });
  }
  await page.addInitScript(({ useExternalSolver }) => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    if (useExternalSolver) {
      Object.defineProperty(window, "TencentCaptcha", {
        configurable: true,
        set(Original: unknown) { (window as unknown as { __TencentCaptchaOriginal: unknown }).__TencentCaptchaOriginal = Original; },
        get() {
          return function (...args: unknown[]) {
            const callback = args.find((arg) => typeof arg === "function") as ((value: unknown) => void) | undefined;
            const appId = args.find((arg) => typeof arg === "string" && /^\d{6,}$/.test(arg)) as string | undefined;
            return { show() { window.dispatchEvent(new CustomEvent("jt-captcha-request", { detail: { appId } })); (window as unknown as { __jtCaptchaCallback?: typeof callback }).__jtCaptchaCallback = callback; }, destroy() {} };
          };
        },
      });
    }
  }, { useExternalSolver: externalSolver });

  if (externalSolver) {
    await page.exposeFunction("__jtSolveTencent", async (appId: string) => {
      const apiKey = process.env.TWOCAPTCHA_API_KEY;
      if (!apiKey) throw new Error("TWOCAPTCHA_API_KEY is not configured");
      return solveTencentCaptcha(apiKey, appId);
    });
    await page.addInitScript(() => {
      window.addEventListener("jt-captcha-request", async (event) => {
        const appId = (event as CustomEvent<{ appId?: string }>).detail?.appId;
        try {
          const solution = await (window as unknown as { __jtSolveTencent(id: string): Promise<TencentSolution> }).__jtSolveTencent(appId ?? "");
          (window as unknown as { __jtCaptchaCallback?: (value: unknown) => void }).__jtCaptchaCallback?.({ ret: 0, ...solution });
        } catch (error) {
          (window as unknown as { __jtCaptchaError?: string }).__jtCaptchaError = String(error);
        }
      });
    });
  }

  const captchaImages: Record<string, Buffer> = {};
  let trackingData: JtV2Response | null = null;

  const trackingPromise = new Promise<JtV2Response | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), externalSolver ? TWOCAPTCHA_TIMEOUT_MS + 15000 : 25000);
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("cap_union_new_getcapbysig")) {
        try {
          const buf = await response.body();
          const idx = new URL(url).searchParams.get("img_index");
          if (idx) captchaImages[idx] = buf;
        } catch {
          /* ignore */
        }
      }
      if (url.includes("getDetailByWaybillNo")) {
        try {
          const body = (await response.json()) as JtV2Response;
          clearTimeout(timer);
          resolve(body);
        } catch {
          /* ignore */
        }
      }
    });
  });

  try {
    const query = encodeURIComponent(waybillNos.join(","));
    await page.goto(`${JT_URL}?waybillNo=${query}&type=0`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (externalSolver) {
      trackingData = await trackingPromise;
      if (!trackingData) {
        const solverError = await page.evaluate(() => (window as unknown as { __jtCaptchaError?: string }).__jtCaptchaError);
        throw new Error(solverError || "Tracking API not called after 2Captcha solve");
      }
      return trackingData;
    }

    await page.waitForSelector(".tencent-captcha-dy__fg-item", {
      timeout: 15000,
    });
    await page.waitForTimeout(3000);

    if (!captchaImages["0"] || !captchaImages["1"]) {
      await page.waitForTimeout(3000);
    }
    if (!captchaImages["1"] || !captchaImages["0"]) {
      throw new Error("Failed to capture captcha images from network");
    }

    const piece = await extractPiece(captchaImages["0"]);
    if (!piece) throw new Error("Failed to extract puzzle piece");

    const offsetXInImage = await templateMatch(captchaImages["1"], piece.buf);

    const dims = await page.evaluate(() => {
      const slider = document.querySelector(
        ".tencent-captcha-dy__slider-block"
      );
      const imageArea = document.querySelector(
        ".tencent-captcha-dy__image-area"
      );
      const fgItem = document.querySelector(".tencent-captcha-dy__fg-item");
      if (!slider || !imageArea) return null;
      return {
        slider: slider.getBoundingClientRect(),
        imageArea: imageArea.getBoundingClientRect(),
        fgItem: fgItem?.getBoundingClientRect() ?? null,
      };
    });
    if (!dims) throw new Error("Could not find captcha slider elements");

    const bgMeta = await sharp(captchaImages["1"]).metadata();
    const scale = dims.imageArea.width / bgMeta.width!;
    const displayOffsetX = offsetXInImage * scale;
    const fgRelX = dims.fgItem
      ? dims.fgItem.x - dims.imageArea.x
      : 24;
    const dragDistance = displayOffsetX - fgRelX;

    const startX = dims.slider.x + dims.slider.width / 2;
    const startY = dims.slider.y + dims.slider.height / 2;

    await humanlikeDrag(page, startX, startY, startX + dragDistance);

    trackingData = await trackingPromise;
    if (!trackingData) throw new Error("Tracking API not called after solve");
    return trackingData;
  } finally {
    await context.close();
  }
}

// ---------- deriveJtStatus ----------

function deriveJtStatus(d: JtV2Detail): string | null {
  const name = (d.scanTypeName || d.status || "").trim();
  if (name) return name;
  const desc = (d.customerTracking || "").toLowerCase();
  if (!desc) return null;
  if (desc.includes("delivered") || desc.includes("signed")) return "Delivered";
  if (desc.includes("out for delivery")) return "Out for Delivery";
  if (desc.includes("returned")) return "Returned";
  return null;
}

// ---------- Main exports ----------

function resultFromRecord(wb: string, record?: NonNullable<JtV2Response["data"]>[number]): TrackResult {
  const events: TrackEvent[] = (record?.details ?? []).map((d) => ({
    time: d.scanTime ?? null,
    status: deriveJtStatus(d),
    description: (d.customerTracking || d.scanTypeName || "").trim(),
    location: [d.scanNetworkName, d.scanNetworkCity].filter(Boolean).join(", ") || null,
  }));
  const latestEvent = events[0];
  const ns = latestEvent ? normalizeStatus(latestEvent.status, latestEvent.description, "jt") : null;
  return {
    carrier: "jt", carrierName: "J&T Express", waybillNo: record?.keyword ?? wb,
    found: events.length > 0, latestStatus: ns ?? latestEvent?.status ?? null,
    latestStatusDetail: latestEvent?.status ?? null, latestTime: latestEvent?.time ?? null,
    normalizedStatus: ns, undeliveryReason: extractUndeliveryReason(events, ns, "jt"), events,
  };
}

/** Map API records to requested inputs, retaining request order, duplicates, and misses. */
export function mapJtBatchResponse(waybills: readonly string[], response: JtV2Response): TrackResult[] {
  const records = new Map<string, NonNullable<JtV2Response["data"]>[number]>();
  for (const record of response.data ?? []) {
    const keyword = record.keyword?.trim();
    if (keyword && !records.has(keyword)) records.set(keyword, record);
  }
  return waybills.map((waybill) => {
    const wb = waybill.trim();
    return resultFromRecord(wb, records.get(wb));
  });
}

export async function trackJtBatch(waybillNos: readonly string[], opts: JtOptions = {}): Promise<TrackResult[]> {
  void opts;
  if (waybillNos.length === 0) throw new CarrierError("jt", "At least one J&T waybill is required", { statusCode: 400 });
  if (waybillNos.length > 10) throw new CarrierError("jt", "Maximum 10 J&T waybills per batch", { statusCode: 400 });
  const waybills = waybillNos.map((value) => value.trim());
  if (waybills.some((value) => !value)) throw new CarrierError("jt", "J&T waybills must not be empty", { statusCode: 400 });

  const apiKeyConfigured = Boolean(process.env.TWOCAPTCHA_API_KEY?.trim());
  const maxAttempts = apiKeyConfigured ? 4 : 3;
  let lastError: Error | null = null;
  let externalFailure: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await solveAndTrack(await getBrowser(), waybills, apiKeyConfigured && attempt === 1);
      if (!response.succ && response.code !== 1) {
        throw new CarrierError("jt", `J&T Express returned error code ${response.code}: ${response.msg ?? ""}`, { statusCode: 502 });
      }
      return mapJtBatchResponse(waybills, response);
    } catch (err) {
      lastError = err as Error;
      if (apiKeyConfigured && attempt === 1) externalFailure = lastError.message;
      if (err instanceof CarrierError) throw err;
    }
  }
  throw new CarrierError(
    "jt",
    `J&T Express captcha failed after ${maxAttempts} attempts: ${lastError?.message ?? "unknown"}${externalFailure ? ` (2Captcha: ${externalFailure})` : ""}`,
    { statusCode: 502, captchaRequired: true },
  );
}

export async function trackJt(waybillNo: string, opts: JtOptions = {}): Promise<TrackResult> {
  return (await trackJtBatch([waybillNo], opts))[0];
}
