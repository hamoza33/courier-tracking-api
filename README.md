# Courier Tracking Aggregator API

A small Node.js/TypeScript REST API that aggregates shipment tracking from
five Middle-East / global courier services:

| Code     | Carrier                     | CAPTCHA?                     |
| -------- | --------------------------- | ---------------------------- |
| `imile`  | iMile                       | No                           |
| `injaz`  | Injaz Express               | No                           |
| `jdw`    | JDW Logistics (JINGDONG)    | No                           |
| `naqel`  | Naqel Express               | No                           |
| `jt`     | J&T Express                 | **Yes – Tencent TJN Captcha**|

The API exposes a single unified `/track` endpoint that can either auto-detect
the carrier from the waybill number or use a carrier you specify. Responses
are normalised across carriers (`events[]`, `latestStatus`, `latestTime`) with
each event already split into a discrete object (step + timestamp + status +
description + location + carrier name).

A live OpenAPI / Swagger UI is served at **`/docs`**.

**Live deployment:** https://courier-tracking-api.fly.dev

---

## Endpoints

### `GET /track?waybill={no}[&carrier={code}][&lang=en][&format=text][&pretty=1][&order=asc]`

Returns the tracking events for a single waybill.

- `waybill` (required) – the tracking number.
- `carrier` (optional) – one of `imile`, `injaz`, `jdw`, `naqel`, `jt`, or
  `auto` (the default). Set to `all` to fan out to every carrier in parallel.
- `lang` (optional) – language hint for carriers that support it
  (`en`, `ar`, `zh-CN`).
- `format` (optional) – `json` (default) or `text`. With `text`, the
  response is a human-readable timeline with one line per event
  (just like the courier websites show). You can also send
  `Accept: text/plain` to get the same effect.
- `order` (optional) – `asc` (default, earliest → most recent) or `desc`
  to reverse.
- `pretty` (optional) – set to `1` to pretty-print JSON output.

The carrier is auto-detected when omitted:

| Pattern                    | Carrier |
| -------------------------- | ------- |
| `^JTE\d{10,14}$`           | `jt`    |
| `^JDW\d{6,16}$`            | `jdw`   |
| `^INJAZ[A-Z0-9]{4,16}$`    | `injaz` |
| `^\d{10,16}$` (digits)     | `imile` |
| `^\d{7,10}$` (short digits)| `naqel` |

If detection fails the API automatically fans out to every carrier and
returns an array.

### `GET /track/{carrier}/{waybill}[?lang=en&format=text&order=asc]`

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

Every event is returned as its own object — easy to iterate over from
JavaScript (`results.events.map(...)`), Python, etc. Each event carries the
carrier name so individual rows can be displayed standalone.

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
      "step": 1,
      "time": "2026-05-09 19:07:51",
      "status": "Pick Up",
      "description": "Your order has been picked up.",
      "location": "Riyadh Collection Station",
      "timezone": null,
      "carrier": "imile",
      "carrierName": "iMile"
    },
    {
      "step": 2,
      "time": "2026-05-10 08:43:26",
      "status": "Delivery",
      "description": "Our delivery associate is out for delivery.",
      "location": "Buraidah Station",
      "timezone": null,
      "carrier": "imile",
      "carrierName": "iMile"
    }
    /* ... more events, oldest -> newest ... */
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

## Using the API from your website

CORS is enabled (`Access-Control-Allow-Origin: *`), so you can call this API
directly from a browser without a proxy.

### Plain JavaScript (`fetch`)

```html
<script>
async function track(waybill) {
  const res = await fetch(
    `https://courier-tracking-api.fly.dev/track?waybill=${encodeURIComponent(waybill)}`
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json(); // -> { carrier, carrierName, waybillNo, events: [...], ... }
}

track("6050926815554").then((data) => {
  // Render step-by-step:
  for (const e of data.events) {
    console.log(
      `[${e.time}] ${e.status} @ ${e.location ?? "-"}  — ${e.carrierName}`
    );
  }
});
</script>
```

### React

```jsx
import { useEffect, useState } from "react";

function Tracking({ waybill }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch(`https://courier-tracking-api.fly.dev/track?waybill=${waybill}`)
      .then((r) => r.json())
      .then(setData)
      .catch(setErr);
  }, [waybill]);

  if (err) return <p>Error: {err.message}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <ol>
      {data.events.map((e) => (
        <li key={e.step}>
          <strong>{e.time}</strong> — {e.status}
          {e.location ? ` @ ${e.location}` : ""}{" "}
          <em>({e.carrierName})</em>
        </li>
      ))}
    </ol>
  );
}
```

### axios

```js
import axios from "axios";

const { data } = await axios.get(
  "https://courier-tracking-api.fly.dev/track/naqel/397965386"
);
for (const e of data.events) {
  console.log(`${e.step}. [${e.time}] ${e.status} @ ${e.location} — ${e.carrierName}`);
}
```

### Force a specific carrier

```js
await fetch("https://courier-tracking-api.fly.dev/track/imile/6050926815554");
await fetch("https://courier-tracking-api.fly.dev/track/injaz/INJAZ78226736");
await fetch("https://courier-tracking-api.fly.dev/track/jdw/JDW101107292775");
await fetch("https://courier-tracking-api.fly.dev/track/naqel/397965386");
```

### Fan-out across every carrier

When you don't know which courier a waybill belongs to, set `carrier=all`:

```js
const res = await fetch(
  `https://courier-tracking-api.fly.dev/track?waybill=${waybill}&carrier=all`
);
const arr = await res.json(); // -> [{ carrier, result?, error? }, ...]
const hit = arr.find((x) => x.result?.found);
```

---

## Plain-text format

For copy/paste, logs, or chat bots, pass `?format=text` to get a
step-by-step timeline (one line per event, earliest → most recent):

```bash
curl -s "https://courier-tracking-api.fly.dev/track/imile/6050926815554?format=text"
```

Sample output:

```
Carrier:       iMile (imile)
Waybill:       6050926815554
Latest status: Delivered
Latest time:   2026-05-10 11:51:47

Timeline (step-by-step, earliest → most recent) — iMile:
────────────────────────────────────────────────────────────────────────
1.  [2026-05-09 19:07:51] Pick Up @ Riyadh Collection Station  — iMile
    Your order has been picked up.

2.  [2026-05-10 08:43:26] Delivery @ Buraidah Station  — iMile
    Our delivery associate is out for delivery.

3.  [2026-05-10 11:51:47] Delivered @ Buraidah Station  — iMile
    Your order has been delivered successfully.
```

---

## CAPTCHA handling (J&T Express only)

J&T Express's KSA / Middle-East site (`jtexpress.me`) protects its tracking
API with **Tencent Cloud (TJN) Captcha** – the Turing variant served from
`turing.captcha.qcloud.com`. The captcha must be solved before the tracking
call; without a valid ticket the API responds with
`{"code":135010037,"msg":"token不能为空"}`.

### Recommended tools

| Provider     | Method / task name              | Notes                                                              |
| ------------ | ------------------------------- | ------------------------------------------------------------------ |
| **CapSolver**| `AntiTencentCaptchaTaskProxyLess` (image-based, where supported) | Fastest when their TJN solver is available.        |
| **2Captcha** | `method=tencent`                | Cheap (~$1 / 1000), but their workers struggle with the Turing variant (often returns `ERROR_CAPTCHA_UNSOLVABLE`). |
| **Anti-Captcha** | `TencentTask`               | Reliable for classic Tencent; for Turing, check their docs.         |
| **NopeCHA**  | `tencent`                       | Browser-extension friendly.                                         |

To enable real J&T tracking, set one (or both):

```bash
export CAPSOLVER_API_KEY=your_capsolver_key
export TWOCAPTCHA_API_KEY=your_2captcha_key
# Optional – override the Tencent "aid" if J&T rotates it:
# export JT_TENCENT_CAPTCHA_AID=189943813
```

If neither key is set, the J&T endpoint returns `402 Payment Required` with
`{"captchaRequired": true}` – every other carrier keeps working.

> **Status:** As of late 2025 the public TJN (Turing) variant J&T uses is
> hard to automate reliably with off-the-shelf solvers. For consistent
> tracking we recommend using the API for the other four carriers and
> falling back to the J&T website manually for the rare J&T waybill.

### Manual / interactive option

For occasional testing, open
`https://www.jtexpress.me/KSA/trajectoryQuery?waybillNo=...` in a real
browser, solve the captcha yourself, and copy the network response. The
endpoint in DevTools is
`POST https://ofmg.jtjms-sa.com/official/express/getDetailByWaybillNo`.

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
| `CAPSOLVER_API_KEY`          | _(unset)_                     | Enables J&T captcha solving via CapSolver     |
| `TWOCAPTCHA_API_KEY`         | _(unset)_                     | Enables J&T captcha solving via 2Captcha      |
| `JT_TENCENT_CAPTCHA_AID`     | `189943813`                   | Override Tencent captcha tenant ID            |

---

## Deployment

The repo ships with a `Dockerfile` and a `fly.toml`. To deploy on
[fly.io](https://fly.io):

```bash
fly launch --no-deploy   # only the first time
fly deploy
# (optional) enable J&T captcha solving:
fly secrets set CAPSOLVER_API_KEY=...
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

### JDW Logistics (JINGDONG)

We POST to the public LOP proxy
`https://lop-proxy.ochama.com/WayBillApi/queryOrderTraceBatchV1`
with the `LOP-DN: intl-cms-interface.jdl.com` header and a body of the form
`[{"magicNoList":["JDW..."],"lang":"en","timeZone":"UTC+00:00",...}]`.

### Naqel Express

Django form-based site. We:

1. `GET https://www.naqelexpress.com/en/tracking/` and extract the
   `csrfmiddlewaretoken` from the HTML form.
2. `POST https://www.naqelexpress.com/en/sa/tracking/` with
   `csrfmiddlewaretoken` and `waybills` form fields.
3. Parse the resulting page, walking each "date pill" header and the
   following `.col-md-12` event rows (status / location / time) into our
   normalised event list.

### J&T Express

Tencent CAPTCHA gated. Once a captcha ticket is obtained, we POST to
`https://ofmg.jtjms-sa.com/official/express/getDetailByWaybillNo` with the
ticket in the `token` header and `ticket`/`randstr` in the body.

---

## License

MIT
