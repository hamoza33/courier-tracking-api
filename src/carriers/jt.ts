import { CarrierError, type TrackEvent, type TrackResult } from "../types.js";

const JT_BASE = "https://ofmg.jtjms-sa.com";
const JT_REFERER = "https://www.jtexpress.me/";
/**
 * Tencent Captcha appKey / "aid" used by J&T's KSA website. Captured from the
 * live captcha widget URL:
 *   `https://ca.turing.captcha.qcloud.com/cap_union_prehandle?aid=189943813&...`
 *
 * If J&T ever rotates it, override via the `JT_TENCENT_CAPTCHA_AID` env var.
 */
const JT_TENCENT_CAPTCHA_AID = process.env.JT_TENCENT_CAPTCHA_AID || "189943813";

const JT_LANG_MAP: Record<string, string> = {
  en: "EN",
  "en-us": "EN",
  ar: "AR",
  "zh-cn": "CN",
};

interface JtTrackDetail {
  scanType?: string | null;
  scanTypeName?: string | null;
  scanTime?: string | null;
  acceptAddress?: string | null;
  problemTypeName?: string | null;
  /** Long human-readable description provided by J&T. */
  desc?: string | null;
  remark?: string | null;
}

interface JtTrackData {
  waybillNo?: string;
  details?: JtTrackDetail[];
  waybillStatusName?: string;
  /** Other fields that J&T may return (not used by us). */
  [k: string]: unknown;
}

interface JtTrackResponse {
  code?: number;
  msg?: string;
  succ?: boolean;
  fail?: boolean;
  data?: JtTrackData[] | null;
}

interface CaptchaSolution {
  ticket: string;
  randstr: string;
}

interface JtOptions {
  lang?: string;
}

/** Common error helper. */
function captchaError(msg: string, statusCode = 502): never {
  throw new CarrierError("jt", msg, { statusCode, captchaRequired: true });
}

/**
 * Solve J&T's Tencent (Turing / TJN) captcha via CapSolver.
 * Docs: https://docs.capsolver.com/guide/captcha/Tencent.html
 *
 * The Turing variant uses task type `AntiTurnstileTaskProxyless` for some
 * Tencent widgets but TJN puzzles are best targeted with
 * `AntiTencentCaptchaTaskProxyLess` (note casing). CapSolver accepts a few
 * aliases; we use the documented one.
 */
async function solveTencentWithCapSolver(): Promise<CaptchaSolution> {
  const key = process.env.CAPSOLVER_API_KEY;
  if (!key) throw new Error("CAPSOLVER_API_KEY not set");

  const createBody = {
    clientKey: key,
    task: {
      type: "AntiTencentCaptchaTaskProxyLess",
      websiteURL: "https://www.jtexpress.me/KSA/trajectoryQuery",
      appId: JT_TENCENT_CAPTCHA_AID,
    },
  };

  const create = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createBody),
  });
  const cj = (await create.json()) as {
    errorId: number;
    errorCode?: string;
    errorDescription?: string;
    taskId?: string;
  };
  if (cj.errorId !== 0 || !cj.taskId) {
    captchaError(
      `CapSolver createTask failed: ${cj.errorCode ?? ""} ${cj.errorDescription ?? JSON.stringify(cj)}`
    );
  }

  const start = Date.now();
  const maxMs = 120_000;
  await sleep(3000);
  while (Date.now() - start < maxMs) {
    const r = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: key, taskId: cj.taskId! }),
    });
    const rj = (await r.json()) as {
      errorId: number;
      errorCode?: string;
      errorDescription?: string;
      status: "idle" | "ready" | "processing" | "failed";
      solution?: { ticket?: string; randstr?: string; appid?: string };
    };
    if (rj.errorId !== 0) {
      captchaError(`CapSolver getTaskResult failed: ${rj.errorCode ?? ""} ${rj.errorDescription ?? ""}`);
    }
    if (rj.status === "ready" && rj.solution?.ticket && rj.solution.randstr) {
      return { ticket: rj.solution.ticket, randstr: rj.solution.randstr };
    }
    if (rj.status === "failed") {
      captchaError(`CapSolver reported task failed: ${rj.errorDescription ?? ""}`);
    }
    await sleep(3000);
  }
  captchaError("CapSolver timed out solving Tencent CAPTCHA after 120s", 504);
}

/**
 * Solve J&T's captcha via 2Captcha (`method=tencent`).
 * Docs: https://2captcha.com/2captcha-api#tencent
 *
 * Note: 2Captcha's tencent solver is reliable for the classic Tencent widget
 * but has poor success rates against J&T's newer Turing (TJN) variant — kept
 * here only as a fallback.
 */
async function solveTencentWith2Captcha(): Promise<CaptchaSolution> {
  const key = process.env.TWOCAPTCHA_API_KEY;
  if (!key) throw new Error("TWOCAPTCHA_API_KEY not set");

  const inUrl = new URL("https://2captcha.com/in.php");
  inUrl.searchParams.set("key", key);
  inUrl.searchParams.set("method", "tencent");
  inUrl.searchParams.set("app_id", JT_TENCENT_CAPTCHA_AID);
  inUrl.searchParams.set("pageurl", "https://www.jtexpress.me/KSA/trajectoryQuery");
  inUrl.searchParams.set("json", "1");

  const submit = await fetch(inUrl.toString(), { method: "GET" });
  const submitJson = (await submit.json()) as { status: number; request: string };
  if (submitJson.status !== 1) {
    captchaError(`2Captcha submission failed: ${submitJson.request}`);
  }
  const captchaId = submitJson.request;

  const resUrl = new URL("https://2captcha.com/res.php");
  resUrl.searchParams.set("key", key);
  resUrl.searchParams.set("action", "get");
  resUrl.searchParams.set("id", captchaId);
  resUrl.searchParams.set("json", "1");

  const start = Date.now();
  const maxMs = 120_000;
  await sleep(5000);
  while (Date.now() - start < maxMs) {
    const r = await fetch(resUrl.toString(), { method: "GET" });
    const rj = (await r.json()) as { status: number; request: string };
    if (rj.status === 1) {
      const [ticket, randstr] = rj.request.split("|");
      if (!ticket || !randstr) {
        captchaError(`2Captcha returned malformed solution: ${rj.request}`);
      }
      return { ticket, randstr };
    }
    if (rj.request !== "CAPCHA_NOT_READY") {
      captchaError(`2Captcha returned error: ${rj.request}`);
    }
    await sleep(5000);
  }
  captchaError("2Captcha timed out solving Tencent CAPTCHA after 120s", 504);
}

/**
 * Try every configured captcha provider in order of reliability for Tencent
 * Turing (TJN). Returns the first success, or aggregates errors if all fail.
 */
async function solveTencentCaptcha(): Promise<CaptchaSolution> {
  const providers: Array<{ name: string; fn: () => Promise<CaptchaSolution> }> = [];
  if (process.env.CAPSOLVER_API_KEY) providers.push({ name: "CapSolver", fn: solveTencentWithCapSolver });
  if (process.env.TWOCAPTCHA_API_KEY) providers.push({ name: "2Captcha", fn: solveTencentWith2Captcha });

  if (providers.length === 0) {
    throw new CarrierError(
      "jt",
      "J&T Express requires solving a Tencent CAPTCHA. Set CAPSOLVER_API_KEY (recommended) or TWOCAPTCHA_API_KEY to enable automatic solving.",
      { statusCode: 502, captchaRequired: true }
    );
  }

  const errors: string[] = [];
  for (const p of providers) {
    try {
      return await p.fn();
    } catch (err) {
      errors.push(`${p.name}: ${(err as Error).message}`);
    }
  }
  throw new CarrierError("jt", `All captcha providers failed: ${errors.join(" | ")}`, {
    statusCode: 502,
    captchaRequired: true,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function commonHeaders(lang: string, token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "Cache-Control": "max-age=2, must-revalidate",
    countryId: "1",
    langType: lang,
    timezone: "GMT+0000",
    token,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Origin: "https://www.jtexpress.me",
    Referer: JT_REFERER,
  };
}

function deriveJtStatus(d: JtTrackDetail): string | null {
  // Prefer the J&T-supplied scanTypeName; otherwise inspect desc/scanType.
  const name = (d.scanTypeName || d.problemTypeName || "").trim();
  if (name) return name;
  const desc = (d.desc || d.remark || "").toLowerCase();
  if (!desc) return null;
  if (desc.includes("delivered") || desc.includes("signed")) return "Delivered";
  if (desc.includes("out for delivery")) return "Out for Delivery";
  if (desc.includes("transit") || desc.includes("arrived") || desc.includes("departed")) return "In Transit";
  if (desc.includes("picked up")) return "Picked Up";
  return null;
}

export async function trackJt(waybillNo: string, opts: JtOptions = {}): Promise<TrackResult> {
  const wb = waybillNo.trim();
  const langType = JT_LANG_MAP[(opts.lang ?? "en").toLowerCase()] ?? "EN";

  // Resolve captcha first (or fail fast if not configured).
  const solution = await solveTencentCaptcha();

  const body = JSON.stringify({
    waybillNo: [wb],
    langType,
    ticket: solution.ticket,
    randstr: solution.randstr,
  });

  let resp: Response;
  try {
    resp = await fetch(`${JT_BASE}/official/express/getDetailByWaybillNo`, {
      method: "POST",
      headers: commonHeaders(langType, solution.ticket),
      body,
    });
  } catch (err) {
    throw new CarrierError("jt", `Network error contacting J&T Express: ${(err as Error).message}`);
  }

  if (!resp.ok) {
    throw new CarrierError("jt", `J&T Express responded HTTP ${resp.status}`);
  }

  const j = (await resp.json()) as JtTrackResponse;
  if (j.succ !== true || !Array.isArray(j.data)) {
    throw new CarrierError(
      "jt",
      `J&T Express returned error code ${j.code}: ${j.msg ?? ""}`,
      { captchaRequired: j.code === 135010037 }
    );
  }

  const record = j.data[0];
  const events: TrackEvent[] = (record?.details ?? []).map((d) => ({
    time: d.scanTime ?? null,
    status: deriveJtStatus(d),
    description: (d.desc || d.remark || d.scanTypeName || "").trim(),
    location: d.acceptAddress ?? null,
  }));

  return {
    carrier: "jt",
    carrierName: "J&T Express",
    waybillNo: record?.waybillNo ?? wb,
    found: events.length > 0,
    latestStatus: events[0]?.status ?? record?.waybillStatusName ?? null,
    latestTime: events[0]?.time ?? null,
    events,
    extra: {
      waybillStatusName: record?.waybillStatusName ?? null,
    },
  };
}
