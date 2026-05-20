# Courier Tracking Aggregator API

A small Node.js/TypeScript REST API that aggregates shipment tracking from
four Middle-East courier services:

| Code     | Carrier                     | CAPTCHA?                     |
| -------- | --------------------------- | ---------------------------- |
| `imile`  | iMile                       | No                           |
| `injaz`  | Injaz Express               | No                           |
| `jt`     | J&T Express                 | **Yes – Tencent TJN Captcha**|
| `jdw`    | JDW Logistics (JINGDONG)    | No                           |

The API exposes a single unified `/track` endpoint that can either auto-detect
the carrier from the waybill number, or use a carrier you specify. Responses
are normalised across carriers (`events[]`, `latestStatus`, `latestTime`).

A live OpenAPI / Swagger UI is served at **`/docs`**.

---

## Endpoints

### `GET /track?waybill={no}[&carrier={code}][&lang=en][&format=text][&pretty=1]`

Returns the tracking events for a single waybill.

- `waybill` (required) – the tracking number.
- `carrier` (optional) – one of `imile`, `injaz`, `jt`, `jdw`, or `auto`
  (the default). Set to `all` to fan out to every carrier in parallel.
- `lang` (optional) – language hint for carriers that support it
  (`en`, `ar`, `zh-CN`).
- `format` (optional) – `json` (default) or `text`. With `text`, the
  response is a human-readable timeline with one line per event
  (just like the courier websites show). You can also send
  `Accept: text/plain` to get the same effect.
- `pretty` (optional) – set to `1` to pretty-print JSON output.

The carrier is auto-detected when omitted:

| Pattern                    | Carrier |
| -------------------------- | ------- |
| `^JTE\d{10,14}$`           | `jt`    |
| `^JDW\d{6,16}$`            | `jdw`   |
| `^INJAZ[A-Z0-9]{4,16}$`    | `injaz` |
| `^\d{10,16}$` (digits)     | `imile` |

If detection fails the API automatically fans out to all four carriers
and returns an array.

### `GET /track/{carrier}/{waybill}[?lang=en]`

Same as above but with the carrier as a path parameter. Useful when you
already know which courier the shipment belongs to.

### `GET /carriers`

Lists supported carriers and whether each one requires a CAPTCHA.

### `GET /health`

Liveness probe.

### `GET /docs`

Interactive Swagger UI.

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
  "events": [
    {
      "time": "2026-05-10 11:51:47",
      "status": "Delivered",
      "description": "Your order has been delivered successfully.",
      "location": "Buraidah Station",
      "timezone": null
    }
    /* ... oldest events follow, most recent first ... */
  ],
  "extra": {
    "sendSite": "Riyadh Collection Station",
    "dispatchStation": "Buraidah Station",
    "country": "KSA"
  }
}
```

For carrier-specific errors (network failure, carrier returned an error code,
CAPTCHA needed) the API responds with HTTP `4xx` / `5xx` and a JSON body of
the form `{ "error": "...", "carrier": "jt", "captchaRequired": true }`.

When `captchaRequired` is `true`, the response status is **`402 Payment
Required`** – this gives you a single status code to detect "courier wants me
to solve a captcha".

---

## CAPTCHA handling (J&T Express)

J&T Express's KSA / Middle-East website (`jtexpress.me`) protects its tracking
API with **Tencent Cloud (TJN) Captcha** – the same widget Tencent uses for
QQ logins. The captcha runs *before* the tracking call, and the returned
`ticket` is sent back in the `token` HTTP header (and `ticket` / `randstr`
fields in the body). Without a valid ticket the API responds with
`{"code":135010037,"msg":"token不能为空"}`.

### Recommended tools

For automation, the cleanest options for solving Tencent TJN captchas are:

| Provider     | Method name                | Notes                                                             |
| ------------ | -------------------------- | ----------------------------------------------------------------- |
| **2Captcha** | `method=tencent`           | Cheapest (~$1 / 1000 solves). Used by this project by default.    |
| **CapSolver**| `TencentCaptchaTaskProxyless` | Generally fastest. SDKs for Node / Python.                     |
| **Anti-Captcha** | `TencentTask`          | Reliable, supports proxy.                                         |
| **NopeCHA**  | `tencent`                  | Browser-extension friendly.                                       |

This project ships with a **2Captcha integration**. To enable real J&T
tracking, export:

```bash
export TWOCAPTCHA_API_KEY=your_2captcha_key
# Optional – override the Tencent "aid" if J&T rotates it:
# export JT_TENCENT_CAPTCHA_AID=2032099822
```

With `TWOCAPTCHA_API_KEY` set, the `/track/jt/...` endpoint will:

1. Submit a Tencent puzzle job to 2Captcha (`method=tencent`).
2. Poll until a `ticket|randstr` pair comes back (~20-40 s typically).
3. Call `https://ofmg.jtjms-sa.com/official/express/getDetailByWaybillNo`
   with the ticket in both the body and the `token` header.

If `TWOCAPTCHA_API_KEY` is **not** set, the J&T endpoint returns
`402 Payment Required` with `{"captchaRequired": true}` – every other carrier
keeps working.

### Manual / interactive option

If you only need to test occasionally, opening
`https://www.jtexpress.me/KSA/trajectoryQuery?waybillNo=...` in a real
browser, solving the captcha yourself, and copying the network response is
fine. The endpoint to look at in DevTools is
`POST https://ofmg.jtjms-sa.com/official/express/getDetailByWaybillNo`.

---

## Examples

### Auto-detect (JSON)

```bash
curl -s https://courier-tracking-api.fly.dev/track?waybill=6050926815554 | jq
curl -s https://courier-tracking-api.fly.dev/track?waybill=JDW101107292775 | jq
curl -s https://courier-tracking-api.fly.dev/track?waybill=INJAZ78226736 | jq
```

### Plain-text timeline

Same endpoint, `?format=text` gives a human-readable timeline (one line per
event, like the courier websites):

```bash
curl -s "https://courier-tracking-api.fly.dev/track/imile/6050926815554?format=text"
```

Sample output:

```
Carrier:       iMile (imile)
Waybill:       6050926815554
Latest status: Delivered
Latest time:   2026-05-10 11:51:47

Timeline (most recent first):
────────────────────────────────────────────────────────────────────────
1. [2026-05-10 11:51:47] Delivered @ Buraidah Station
   Your order has been delivered successfully.

2. [2026-05-10 08:43:26] Delivery @ Buraidah Station
   Our delivery associate is out for delivery.

3. [2026-05-09 19:07:51] Pick Up @ Riyadh Collection Station
   Your order has been picked up.

...
```

### Force carrier

```bash
curl -s https://courier-tracking-api.fly.dev/track/imile/6050926815554 | jq
curl -s https://courier-tracking-api.fly.dev/track/jdw/JDW101107292775 | jq
curl -s https://courier-tracking-api.fly.dev/track/injaz/INJAZ78226736 | jq
curl -s https://courier-tracking-api.fly.dev/track/jt/JTE000944462953 | jq
```

### Fan-out

```bash
curl -s "https://courier-tracking-api.fly.dev/track?waybill=6050926815554&carrier=all" | jq
curl -s "https://courier-tracking-api.fly.dev/track?waybill=6050926815554&carrier=all&format=text"
```

---

## Local development

```bash
npm install
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
| `TWOCAPTCHA_API_KEY`         | _(unset)_                     | Enables J&T captcha solving via 2Captcha      |
| `JT_TENCENT_CAPTCHA_AID`     | `2032099822`                  | Override Tencent captcha tenant ID            |

---

## Deployment

The repo ships with a `Dockerfile` and a `fly.toml`. To deploy on
[fly.io](https://fly.io):

```bash
fly launch --no-deploy   # only the first time
fly deploy
# enable J&T captcha solving:
fly secrets set TWOCAPTCHA_API_KEY=...
```

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

Both are reconstructed by `src/carriers/imile.ts`.

### Injaz Express

Plain HTML site. We POST `order=<waybill>` to
`https://injaz-express.com/track_order.php` and parse the
`<li class="ant-timeline-item">` blocks. The Apache server in front of Injaz
occasionally truncates chunked gzip responses mid-stream, so we explicitly
request `Accept-Encoding: identity`.

### J&T Express

Tencent CAPTCHA gated. Once a captcha ticket is obtained, we POST to
`https://ofmg.jtjms-sa.com/official/express/getDetailByWaybillNo` with the
ticket in the `token` header and `ticket`/`randstr` in the body.

### JDW Logistics (JINGDONG)

We POST to the public LOP proxy
`https://lop-proxy.ochama.com/WayBillApi/queryOrderTraceBatchV1`
with the `LOP-DN: intl-cms-interface.jdl.com` header and a body of the form
`[{"magicNoList":["JDW..."],"lang":"en","timeZone":"UTC+00:00",...}]`.

---

## License

MIT
