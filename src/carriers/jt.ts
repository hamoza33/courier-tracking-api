import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { cv } from "opencv-wasm";
import { CarrierError, type TrackEvent, type TrackResult } from "../types.js";
import { normalizeStatus, extractUndeliveryReason } from "../normalize.js";

const JT_URL = "https://www.jtexpress.me/KSA/trajectoryQuery";

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

interface JtV2Response {
  code?: number;
  msg?: string;
  succ?: boolean;
  data?: Array<{
    keyword?: string;
    details?: JtV2Detail[];
  }>;
}

interface JtOptions {
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
  waybillNo: string
): Promise<JtV2Response> {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const captchaImages: Record<string, Buffer> = {};
  let trackingData: JtV2Response | null = null;

  const trackingPromise = new Promise<JtV2Response | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 25000);
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
    await page.goto(`${JT_URL}?waybillNo=${waybillNo}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
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

// ---------- Main export ----------

export async function trackJt(
  waybillNo: string,
  opts: JtOptions = {}
): Promise<TrackResult> {
  const wb = waybillNo.trim();

  const maxAttempts = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const browser = await getBrowser();
      const response = await solveAndTrack(browser, wb);

      if (!response.succ && response.code !== 1) {
        throw new CarrierError(
          "jt",
          `J&T Express returned error code ${response.code}: ${response.msg ?? ""}`,
          { statusCode: 502 }
        );
      }

      const record = response.data?.[0];
      const events: TrackEvent[] = (record?.details ?? []).map((d) => ({
        time: d.scanTime ?? null,
        status: deriveJtStatus(d),
        description: (d.customerTracking || d.scanTypeName || "").trim(),
        location:
          [d.scanNetworkName, d.scanNetworkCity]
            .filter(Boolean)
            .join(", ") || null,
      }));

      const latestEvent = events[0];
      const ns = latestEvent
        ? normalizeStatus(latestEvent.status, latestEvent.description, "jt")
        : null;

      return {
        carrier: "jt",
        carrierName: "J&T Express",
        waybillNo: record?.keyword ?? wb,
        found: events.length > 0,
        latestStatus: ns ?? latestEvent?.status ?? null,
        latestStatusDetail: latestEvent?.status ?? null,
        latestTime: latestEvent?.time ?? null,
        normalizedStatus: ns,
        undeliveryReason: extractUndeliveryReason(events, ns, "jt"),
        events,
      };
    } catch (err) {
      lastError = err as Error;
      if (err instanceof CarrierError) throw err;
      // Retry on captcha solve failures
    }
  }

  throw new CarrierError(
    "jt",
    `J&T Express slider captcha failed after ${maxAttempts} attempts: ${lastError?.message ?? "unknown"}`,
    { statusCode: 502, captchaRequired: true }
  );
}
