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

/**
 * Attempt to resolve a Tencent (TJN) captcha via the 2Captcha service.
 * Documented at https://2captcha.com/2captcha-api#tencent
 */
async function solveTencentCaptchaWith2Captcha(): Promise<CaptchaSolution> {
  const key = process.env.TWOCAPTCHA_API_KEY;
  if (!key) {
    throw new CarrierError(
      "jt",
      "J&T Express requires solving a Tencent CAPTCHA. Set TWOCAPTCHA_API_KEY (or use one of the alternative providers) to enable automatic solving.",
      { statusCode: 502, captchaRequired: true }
    );
  }

  const inUrl = new URL("https://2captcha.com/in.php");
  inUrl.searchParams.set("key", key);
  inUrl.searchParams.set("method", "tencent");
  inUrl.searchParams.set("app_id", JT_TENCENT_CAPTCHA_AID);
  inUrl.searchParams.set(
    "pageurl",
    "https://www.jtexpress.me/KSA/trajectoryQuery"
  );
  inUrl.searchParams.set("json", "1");

  const submit = await fetch(inUrl.toString(), { method: "GET" });
  const submitJson = (await submit.json()) as { status: number; request: string };
  if (submitJson.status !== 1) {
    throw new CarrierError("jt", `2Captcha submission failed: ${submitJson.request}`, {
      statusCode: 502,
      captchaRequired: true,
    });
  }
  const captchaId = submitJson.request;

  // Poll for solution (Tencent jobs typically resolve in ~20-40s).
  const resUrl = new URL("https://2captcha.com/res.php");
  resUrl.searchParams.set("key", key);
  resUrl.searchParams.set("action", "get");
  resUrl.searchParams.set("id", captchaId);
  resUrl.searchParams.set("json", "1");

  const start = Date.now();
  const maxMs = 120_000;
  // 5s initial delay, then poll every 5s.
  await sleep(5000);
  while (Date.now() - start < maxMs) {
    const r = await fetch(resUrl.toString(), { method: "GET" });
    const rj = (await r.json()) as { status: number; request: string };
    if (rj.status === 1) {
      // 2Captcha returns `ticket|randstr` for Tencent puzzles.
      const [ticket, randstr] = rj.request.split("|");
      if (!ticket || !randstr) {
        throw new CarrierError("jt", `2Captcha returned malformed solution: ${rj.request}`, {
          captchaRequired: true,
        });
      }
      return { ticket, randstr };
    }
    if (rj.request !== "CAPCHA_NOT_READY") {
      throw new CarrierError("jt", `2Captcha returned error: ${rj.request}`, {
        statusCode: 502,
        captchaRequired: true,
      });
    }
    await sleep(5000);
  }
  throw new CarrierError("jt", "2Captcha timed out solving Tencent CAPTCHA after 120s", {
    statusCode: 504,
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
  const solution = await solveTencentCaptchaWith2Captcha();

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
