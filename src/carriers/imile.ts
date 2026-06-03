import crypto from "node:crypto";
import forge from "node-forge";
import { CarrierError, type TrackEvent, type TrackResult } from "../types.js";
import { normalizeStatus } from "../normalize.js";

const RSA_PUB_KEY_B64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3dFPiKNZwt+HoBbPAG/t7kZC2k3pBX2eCl5LeyeW8woNuEV5bA5kB9Y9KKTOQng62ERGPLwi84CdIB8s265ljQUib//iO3jVrZesJueO5Xu+s80s3Z/89jgJleT1XawN1GubgkGXOoT1a7tvX8+aItkGgR//48ELqJVVUL+yGsBtXxFjNmOEWxBJNQuwAf9yWcCIl1enD60GjZjPWrsfw8QUqam7K5e45ealcPEYGenNePwuPpCq6twdD0YYYzKdRN0dZP1uTviFpNfph90c9YgQ8kgDkRMcpjVv6KZ+bg5JZ4sK6LkV4vwOjPijisthHBvUXhu3fyhMgvoDO/j5gwIDAQAB";

const PEM = `-----BEGIN PUBLIC KEY-----\n${RSA_PUB_KEY_B64.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;

function signWaybill(waybill: string): string {
  const pub = forge.pki.publicKeyFromPem(PEM);
  // JSEncrypt default: RSAES-PKCS1-v1_5
  const encrypted = pub.encrypt(waybill, "RSAES-PKCS1-V1_5");
  return forge.util.encode64(encrypted);
}

function md5Code(waybill: string): string {
  return crypto.createHash("md5").update(`${waybill}imileTrackQuery2024`).digest("hex");
}

interface ImileTrackInfo {
  content?: string | null;
  trackStage?: number | null;
  trackStageTx?: string | null;
  time?: string | null;
  operateStationName?: string | null;
  proofs?: unknown;
}

interface ImileResponse {
  status?: string;
  resultCode?: string;
  resultMsg?: string;
  resultObject?: {
    waybillNo?: string;
    sendSite?: string;
    dispatchStation?: string;
    country?: string;
    trackInfos?: ImileTrackInfo[];
  } | null;
}

export async function trackImile(waybillNo: string, lang = "en-US"): Promise<TrackResult> {
  const wb = waybillNo.trim();
  const code = md5Code(wb);
  const sign = signWaybill(wb);
  const url = `https://www.imile.com/saastms/mobileWeb/track/query?waybillNo=${encodeURIComponent(wb)}&code=${code}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        sign,
        lang,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://www.imile.com/",
      },
    });
  } catch (err) {
    throw new CarrierError("imile", `Network error contacting iMile: ${(err as Error).message}`);
  }

  if (!resp.ok) {
    throw new CarrierError("imile", `iMile responded HTTP ${resp.status}`, { statusCode: 502 });
  }

  const body = (await resp.json()) as ImileResponse;
  if (body.status !== "success" || !body.resultObject) {
    return {
      carrier: "imile",
      carrierName: "iMile",
      waybillNo: wb,
      found: false,
      latestStatus: null,
      latestTime: null,
      normalizedStatus: null,
      events: [],
      extra: { rawStatus: body.status, resultCode: body.resultCode, resultMsg: body.resultMsg },
    };
  }

  const r = body.resultObject;
  const events: TrackEvent[] = (r.trackInfos ?? []).map((t) => ({
    time: t.time ?? null,
    status: t.trackStageTx ?? null,
    description: t.content ?? "",
    location: t.operateStationName ?? null,
  }));

  const latestEvent = events[0];
  const ns = latestEvent ? normalizeStatus(latestEvent.status, latestEvent.description, "imile") : null;

  return {
    carrier: "imile",
    carrierName: "iMile",
    waybillNo: r.waybillNo ?? wb,
    found: events.length > 0,
    latestStatus: latestEvent?.status ?? null,
    latestTime: latestEvent?.time ?? null,
    normalizedStatus: ns,
    events,
    extra: {
      sendSite: r.sendSite ?? null,
      dispatchStation: r.dispatchStation ?? null,
      country: r.country ?? null,
    },
  };
}
