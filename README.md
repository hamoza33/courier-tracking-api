# Courier Tracking Aggregator API

A small Node.js/TypeScript REST API that aggregates shipment tracking from
five Middle-East courier services:

| Code     | Carrier                     | CAPTCHA?                     |
| -------- | --------------------------- | ---------------------------- |
| `imile`  | iMile                       | No                           |
| `injaz`  | Injaz Express               | No                           |
| `jt`     | J&T Express                 | TrackingMore Turnstile; Tencent fallback |
| `jdw`    | JDW Logistics (JINGDONG)    | No                           |
| `naqel`  | Naqel Express               | No                           |

The API exposes a single unified `/track` endpoint that can either auto-detect
the carrier from the waybill number, or use a carrier you specify. Responses
are normalised across carriers (`events[]`, `latestStatus`, `latestTime`,
`normalizedStatus`).

A live OpenAPI / Swagger UI is served at **`/docs`**.

A **tracking dashboard** is available at **`/dashboard`** — paste or upload
tracking numbers in bulk, view results in a sortable/filterable table, and
refresh statuses on demand.

**Live deployment:** https://tracking.shopinzo.bond

---

## Endpoints

### `GET /track?waybill={no}[&carrier={code}][&jtProvider=auto][&lang=en][&format=text][&pretty=1][&order=desc]`

Returns the tracking events for a single waybill.

- `waybill` (required) – the tracking number.
- `carrier` (optional) – one of `imile`, `injaz`, `jt`, `jdw`, `naqel`, or
  `auto` (the default). Set to `all` to fan out to every carrier in parallel.
- `jtProvider` (optional) – `auto` (default: TrackingMore first, Tencent fallback only if the provider fails), `trackingmore` (no fallback), or `tencent` (no fallback).
- `lang` (optional) – language hint for carriers that support it
  (`en`, `ar`, `zh-CN`).
- `format` (optional) – `json` (default) or `text`. With `text`, the
  response is a human-readable timeline with one line per event.
- `pretty` (optional) – set to `1` to pretty-print JSON output.
- `order` (optional) – `desc` (default, **most recent first**) or `asc`
  (oldest first).

The carrier is auto-detected when omitted:

| Pattern                    | Carrier |
| -------------------------- | ------- |
| `^JTE\d{10,14}$`           | `jt`    |
| `^JDW\d{6,16}$`            | `jdw`   |
| `^INJAZ[A-Z0-9]{4,16}$`    | `injaz` |
| `^\d{7,9}$` (7-9 digits)   | `naqel` |
| `^\d{10,16}$` (10-16 digits)| `imile` |

If detection fails the API automatically fans out to all five carriers
and returns an array.

### `GET /track/{carrier}/{waybill}[?jtProvider=auto&lang=en&order=desc]`

Same as above but with the carrier as a path parameter. `jtProvider` applies when `carrier=jt`.

### `POST /track/bulk`

Track up to **250 waybills** in a single request. Non-J&T work runs in parallel;
J&T uses a controlled worker pool (`JT_BULK_CONCURRENCY`, default `5`, clamped
to `1..10`). Results preserve input order and failures remain isolated per item.

**Request body:**

```json
{
  "waybills": ["6050926815554", "JDW101107292775", "JTE000944462953"],
  "lang": "en",
  "jtProvider": "auto",
  "order": "desc"
}
```

Each item in `waybills` can be a plain string (carrier auto-detected) or an object. Top-level `jtProvider` is the default, and a per-item `jtProvider` overrides it. TrackingMore and auto groups are capped at 20, Tencent groups at 10, and different provider selections are never mixed in one group:

```json
{
  "waybills": [
    "6050926815554",
    { "waybill": "JTE000944462953", "carrier": "jt", "jtProvider": "trackingmore" }
  ]
}
```

**Response:**

```json
{
  "total": 3,
  "successful": 2,
  "failed": 1,
  "results": [
    { "waybill": "6050926815554", "carrier": "imile", "result": { ... } },
    { "waybill": "JDW101107292775", "carrier": "jdw", "result": { ... } },
    { "waybill": "JTE000944462953", "carrier": "jt", "error": { "message": "..." } }
  ]
}
```

### `POST /track/benchmark`

Benchmarks processing time for **50 vs all** tracking numbers. Provide up to 250
waybills; the endpoint runs the first 50, then all provided waybills, and
returns timing comparisons.

**Request body:** Same as `/track/bulk`.

**Response:**

```json
{
  "benchmark": {
    "batch50": { "count": 50, "durationMs": 2340, "successful": 48, "failed": 2, "avgPerItem": 47 },
    "batch100": { "count": 100, "durationMs": 4120, "successful": 95, "failed": 5, "avgPerItem": 41 },
    "comparison": {
      "speedupRatio": 1.76,
      "note": "speedupRatio shows how much longer 100 takes compared to 50. Values close to 1.0 mean good parallelism."
    }
  },
  "results": [ ... ]
}
```

### `GET /carriers`

Lists supported carriers and whether each one requires a CAPTCHA.

### `GET /health`

Liveness probe.

### `GET /docs`

Interactive Swagger UI.

### `GET /dashboard`

Bulk tracking dashboard UI. Features:

- **Paste or upload** tracking numbers (one per line, comma/space separated, or CSV/TXT file)
- **Sortable table** with columns: #, Tracking Number, Carrier, Status, Last Update, Details
- **Search** across tracking number, carrier, and status in real time
- **Filter** by status (Delivered, In Transit, Out for Delivery, Returned, Error) and carrier
- **Summary bar** showing counts per status category
- **Bulk refresh** — re-track all numbers with one click
- **Event timeline** — expand any row to see the full tracking history

**Live:** [https://tracking.shopinzo.bond/dashboard](https://tracking.shopinzo.bond/dashboard)

---

## Normalized Status

Every tracking response includes a top-level `normalizedStatus` field that
maps the carrier's raw status text to one of exactly **four canonical values**:

| Canonical Value      | Matching keywords (case-insensitive)                                     |
| -------------------- | ------------------------------------------------------------------------ |
| `"Delivered"`        | delivered, تم التسليم, signed, sign scan                                 |
| `"Out for Delivery"` | out for delivery, on the way, courier, delivering, delivery scan, delivery |
| `"Returned"`         | return, returned, rto, shipment returned, returned signed                 |
| `"In Transit"`       | Everything else (arrived, departed, picked up, in transit, etc.)          |

Exclusions: "delivery attempted" and "delivery failed" are mapped to
**In Transit**, not Delivered. "Returned signed" is mapped to **Returned**,
not Delivered.

The mapping works across all 5 carriers by matching the latest event's
`status` (or `description` if status is empty) against these keywords.

---

## Timeline Order

The default sort order for `events[]` is **`desc` (most recent first)**.
This applies to both the JSON response and `?format=text` output.

To get the old behavior (oldest first), append `?order=asc`:

```bash
curl -s "https://tracking.shopinzo.bond/track/imile/6050926815554?order=asc" | jq '.events[0].time'
```

---

## Response shape

```jsonc
{
  "carrier": "imile",
  "carrierName": "iMile",
  "waybillNo": "6050926815554",
  "found": true,
  "latestStatus": "Delivered",
  "latestTime": "2026-05-10 11:51:47",
  "normalizedStatus": "Delivered",
  "events": [
    {
      "time": "2026-05-10 11:51:47",
      "status": "Delivered",
      "description": "Your order has been delivered successfully.",
      "location": "Buraidah Station",
      "timezone": null
    }
    /* ... most recent first (default) ... */
  ],
  "extra": { ... }
}
```

---

## J&T provider and CAPTCHA fallback chains

J&T has two separate fallback layers:

### Tracking provider selection

1. **TrackingMore** is primary. The adapter navigates directly to
   `https://www.trackingmore.com/track?number=<encoded-comma-separated-numbers>&express=jtexpress-ae&lang=en`.
2. **Tencent/J&T native tracking** is the provider fallback.

With `jtProvider=auto` (the default), TrackingMore is attempted first. Tencent is called only if the TrackingMore request throws or fails; a valid TrackingMore “not found” result does not trigger fallback. A failed TrackingMore group of up to 20 is split into Tencent groups of at most 10. Input order and duplicate waybills are preserved.

Explicit `jtProvider=trackingmore` and `jtProvider=tencent` modes never switch tracking providers. Results are annotated in `extra` with `source`, `provider`, `requestedProvider`, and `fallback`; provider fallback also adds a warning.

### TrackingMore Turnstile solver selection

For a TrackingMore challenge, CAPTCHA solvers are attempted in this order:

1. **Capsolver** — `AntiTurnstileTaskProxyLess`, configured with `CAPSOLVER_API_KEY`.
2. **2Captcha** — `TurnstileTaskProxyless`, configured with `TWOCAPTCHA_API_KEY`, called only if Capsolver is absent or fails.

A successful Capsolver solve never creates a duplicate paid 2Captcha task. Both services return a Turnstile token; the Playwright page submits it through TrackingMore's existing callback and waits until every corresponding `app.trackEnd` entry has `loading: false`. A warm reusable Chromium process and resource blocking reduce latency, while each request uses an isolated browser context.

The Tencent implementation separately uses **2Captcha `TencentTaskProxyless`** when configured, then retains its local Playwright slider solver as an internal fallback.

Bulk REST, benchmark, dashboard, and MCP paths all use the same provider rules: TrackingMore/auto groups contain up to 20 numbers, Tencent groups up to 10. The TrackingMore browser runs directly from the server by default; an optional browser proxy can be configured as described below.

---

## Examples

### Auto-detect (JSON)

```bash
curl -s https://tracking.shopinzo.bond/track?waybill=6050926815554 | jq
curl -s https://tracking.shopinzo.bond/track?waybill=JDW101107292775 | jq
curl -s https://tracking.shopinzo.bond/track?waybill=INJAZ78226736 | jq
curl -s https://tracking.shopinzo.bond/track?waybill=397965386 | jq
```

### Plain-text timeline

```bash
curl -s "https://tracking.shopinzo.bond/track/imile/6050926815554?format=text"
```

### Force carrier

```bash
curl -s https://tracking.shopinzo.bond/track/imile/6050926815554 | jq
curl -s https://tracking.shopinzo.bond/track/jdw/JDW101107292775 | jq
curl -s https://tracking.shopinzo.bond/track/injaz/INJAZ78226736 | jq
curl -s https://tracking.shopinzo.bond/track/jt/JTE000944462953 | jq
curl -s https://tracking.shopinzo.bond/track/naqel/397965386 | jq
```

### Fan-out

```bash
curl -s "https://tracking.shopinzo.bond/track?waybill=6050926815554&carrier=all" | jq
```

### Oldest-first ordering

```bash
curl -s "https://tracking.shopinzo.bond/track/imile/6050926815554?order=asc" | jq
```

---

## Local development

```bash
npm install
npx playwright install chromium   # required for J&T tracking
npm run dev          # tsx hot reload on http://localhost:8080
npm run lint         # tsc --noEmit
npm run build && npm start
```

### Environment variables

| Var                          | Default                       | Description                                   |
| ---------------------------- | ----------------------------- | --------------------------------------------- |
| `PORT`                       | `8080`                        | HTTP port                                     |
| `HOST`                       | `0.0.0.0`                     | Bind address                                  |
| `LOG_LEVEL`                  | `info`                        | Pino log level                                |
| `RATE_LIMIT_MAX`             | `60`                          | Requests per window per IP                    |
| `RATE_LIMIT_WINDOW`          | `1 minute`                    | Rate-limit window                             |
| `CAPSOLVER_API_KEY`          | unset                         | Primary TrackingMore Turnstile solver key; 2Captcha is used only if Capsolver fails |
| `TWOCAPTCHA_API_KEY`         | unset                         | Secondary TrackingMore Turnstile solver and TencentTaskProxyless key (never expose these values) |
| `TRACKINGMORE_PROXY_URL`      | unset                         | Optional proxy URL for TrackingMore's Playwright browser; direct server IP is used when unset |
| `JT_PROXY_URL`                | unset                         | Backward-compatible TrackingMore proxy fallback when `TRACKINGMORE_PROXY_URL` is unset |
| `JT_BULK_CONCURRENCY`        | `5`                           | Concurrent J&T groups (up to 20 for TrackingMore/auto; 10 for Tencent) for REST, benchmark, and MCP bulk/summary paths; clamped to 1..10. Consider 2–5 on memory-constrained hosts |
| `MCP_AUTH_TOKEN`             | unset                         | MCP OAuth/admin bearer token                  |
| `MCP_PUBLIC_URL`             | production URL                | Public base URL used by MCP OAuth metadata    |

---

## Deployment

The production instance runs on a VPS behind https://tracking.shopinzo.bond,
managed by `systemd` (`courier-tracking-api.service`, `ExecStart=node dist/server.js`).
To ship an update:

```bash
git pull
npm install
npm run build
sudo systemctl restart courier-tracking-api.service
```

The repo also ships with a `Dockerfile` and a `fly.toml` for container-based
deploys. The Docker image includes Playwright Chromium for J&T captcha solving,
so allow ~1024 MB memory to accommodate headless Chromium.

---

## How each adapter works (technical notes)

### iMile

iMile's mobile site calls
`https://www.imile.com/saastms/mobileWeb/track/query` with two pieces of
signing:

1. **`code` query parameter** – `MD5(waybillNo + "imileTrackQuery2024")` in
   lowercase hex.
2. **`sign` header** – RSA-PKCS#1 v1.5 encryption of the raw waybill number
   using the public key embedded in their JS bundle, then base-64 encoded.

### Injaz Express

Plain HTML site. We POST `order=<waybill>` to
`https://injaz-express.com/track_order.php` and parse the
`<li class="ant-timeline-item">` blocks.

### J&T Express

The provider orchestrator defaults to TrackingMore, with groups of up to 20, and falls back to Tencent groups of up to 10 only on TrackingMore provider failure. Explicit provider modes do not switch providers.

TrackingMore uses direct query-URL navigation in a reusable Playwright Chromium process. Its Cloudflare Turnstile token comes from Capsolver first and 2Captcha only after Capsolver failure. The page's native verification callback receives the token, and extraction waits for all requested `app.trackEnd` records to settle before mapping statuses and events.

For Tencent, Playwright loads the native J&T page and 2Captcha's `TencentTaskProxyless` returns `ticket` and `randstr` to the page callback. Robust polling is timeout-bounded and validates provider responses. The local slider solver (Sobel edge detection + NCC + humanlike drag) remains an internal Tencent fallback.

### JDW Logistics (JINGDONG)

We POST to the public LOP proxy
`https://lop-proxy.ochama.com/WayBillApi/queryOrderTraceBatchV1`
with the `LOP-DN: intl-cms-interface.jdl.com` header.

### Naqel Express

We scrape the public tracking page at
`https://www.naqelexpress.com/en/Track/TrackShipment/{waybillNo}` and parse
the HTML timeline (date headers + status/location/time rows).

---

## License

MIT
