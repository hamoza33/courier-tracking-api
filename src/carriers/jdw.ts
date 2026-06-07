import { CarrierError, type TrackEvent, type TrackResult } from "../types.js";
import { normalizeStatus, extractUndeliveryReason } from "../normalize.js";

interface JdwTrackNode {
  hasPodUrl?: number;
  operatorDesc?: string;
  operatorTime?: string;
  timeZone?: string;
  waybillNo?: string;
}

interface JdwWayBillTrackItem {
  trackNodeList?: JdwTrackNode[];
}

interface JdwData {
  wayBillTrackItemDtoList?: JdwWayBillTrackItem[];
  waybillNo?: string;
  waybillNum?: number;
}

interface JdwResponse {
  code?: number;
  msg?: string;
  data?: JdwData[];
}

/**
 * JDW Logistics (JINGDONG Logistics) tracking via the public website's LOP proxy.
 */
export async function trackJdw(waybillNo: string, lang = "en"): Promise<TrackResult> {
  const wb = waybillNo.trim();

  let resp: Response;
  try {
    resp = await fetch("https://lop-proxy.ochama.com/WayBillApi/queryOrderTraceBatchV1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "LOP-DN": "intl-cms-interface.jdl.com",
        ClientInfo: '{"appName":"intl_cms","client":"m"}',
        AppParams: '{"appid":"intl-cms-interface-web","ticket_type":"pc"}',
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Origin: "https://www.jingdonglogistics.com",
        Referer: "https://www.jingdonglogistics.com/",
      },
      body: JSON.stringify([
        {
          magicNoList: [wb],
          clientIp: "$cooMrdGatewayIp$",
          lang,
          timeZone: "UTC+00:00",
        },
      ]),
    });
  } catch (err) {
    throw new CarrierError("jdw", `Network error contacting JDW Logistics: ${(err as Error).message}`);
  }

  if (!resp.ok) {
    throw new CarrierError("jdw", `JDW Logistics responded HTTP ${resp.status}`);
  }

  const body = (await resp.json()) as JdwResponse;
  if (body.code !== 1 || !Array.isArray(body.data)) {
    throw new CarrierError("jdw", `JDW Logistics returned error code ${body.code}: ${body.msg ?? ""}`);
  }

  const first = body.data[0];
  const item = first?.wayBillTrackItemDtoList?.[0];
  const events: TrackEvent[] = (item?.trackNodeList ?? []).map((n) => ({
    time: n.operatorTime ?? null,
    status: deriveJdwStatus(n.operatorDesc ?? ""),
    description: (n.operatorDesc ?? "").trim(),
    timezone: n.timeZone ?? null,
    location: null,
  }));

  const latestEvent = events[0];
  const ns = latestEvent ? normalizeStatus(latestEvent.status, latestEvent.description, "jdw") : null;

  return {
    carrier: "jdw",
    carrierName: "JDW Logistics",
    waybillNo: wb,
    found: events.length > 0,
    latestStatus: ns ?? latestEvent?.status ?? null,
    latestStatusDetail: latestEvent?.status ?? null,
    latestTime: latestEvent?.time ?? null,
    normalizedStatus: ns,
    undeliveryReason: extractUndeliveryReason(events, ns),
    events,
    extra: {
      waybillNum: first?.waybillNum ?? null,
    },
  };
}

function deriveJdwStatus(desc: string): string | null {
  const d = desc.toLowerCase();
  if (d.includes("delivered") || d.includes("signed")) return "Delivered";
  if (d.includes("on the way") || d.includes("courier")) return "Out for Delivery";
  if (d.includes("ready to return to sender")) return "Returned to Sender";
  if (d.includes("returned to the station") || d.includes("rescheduled")) return "Return to Station";
  if (d.includes("arrived")) return "Arrived";
  if (d.includes("picked up") || d.includes("pickup")) return "Picked Up";
  if (d.includes("shipped") || d.includes("in transit") || d.includes("transferred")) return "In Transit";
  if (d.includes("order")) return "Order Created";
  return null;
}
