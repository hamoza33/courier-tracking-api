# Courier Tracking Aggregator API

A small Node.js/TypeScript REST API that aggregates shipment tracking from
five Middle-East courier services:

| Code     | Carrier                     | CAPTCHA?                     |
| -------- | --------------------------- | ---------------------------- |
| `imile`  | iMile                       | No                           |
| `injaz`  | Injaz Express               | No                           |
| `jt`     | J&T Express                 | **Yes – solved automatically via Playwright** |
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

### `GET /track?waybill={no}[&carrier={code}][&lang=en][&format=text][&pretty=1][&order=desc]`

Returns the tracking events for a single waybill.

- `waybill` (required) – the tracking number.
- `carrier` (optional) – one of `imile`, `injaz`, `jt`, `jdw`, `naqel`, or
  `auto` (the default). Set to `all` to fan out to every carrier in parallel.
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

### `GET /track/{carrier}/{waybill}[?lang=en&order=desc]`

Same as above but with the carrier as a path parameter.

### `POST /track/bulk`

Track up to **250 waybills** in a single request. All carriers except J&T Express
are processed in parallel. J&T waybills are processed **one-by-one** (sequentially)
to handle the CAPTCHA requirement.

**Request body:**

```json
{
  "waybills": ["6050926815554", "JDW101107292775", "JTE000944462953"],
  "lang": "en",
  "order": "desc"
}
```

Each item in `waybills` can be a plain string (carrier auto-detected) or an object:

```json
{
  "waybills": [
    "6050926815554",
    { "waybill": "JTE000944462953", "carrier": "jt" }
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

## CAPTCHA handling (J&T Express)

J&T Express's KSA website (`jtexpress.me`) protects its tracking API with
**Tencent Cloud (TJN) Captcha** – a slider puzzle captcha.

This project **automatically solves the captcha** using:

1. **Playwright** – headless Chromium loads the J&T tracking page.
2. **Template matching with Sobel edge detection** – the slider background
   and puzzle piece images are captured from the page's network requests,
   processed locally using Sharp, and the correct X-offset is found via
   normalized cross-correlation on Sobel edge maps.
3. **Humanlike drag** – a natural mouse movement with easing, jitter, and
   overshoot drags the slider to the correct position.
4. The page's own tracking API call is intercepted to capture the response.

No external captcha-solving service is needed. The solver retries up to
3 times if the drag fails.

J&T now uses a v2 API endpoint:
`POST https://ofmg.jtjms-sa.com/official/logisticsTracking/v2/getDetailByWaybillNo`

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

Playwright-based automatic captcha solving. Loads the tracking page, solves
the Tencent TJN slider captcha via local template matching (Sobel edge
detection + NCC), and intercepts the v2 tracking API response.

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
