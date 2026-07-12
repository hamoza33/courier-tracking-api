/**
 * Self-contained dashboard HTML served as an inline string.
 * Provides bulk tracking input (paste / CSV upload), a sortable &
 * filterable results table, and a one-click bulk refresh.
 *
 * Features:
 * - Auto-load waybills from URL params (?waybills=...) on page load
 * - Graceful failure handling with retry logic and timeout
 * - Full order data shape (extra fields, warnings, origin/dest)
 * - localStorage persistence for recently tracked numbers
 * - API health indicator
 */

export const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Courier Tracking Dashboard</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#f8f9fb;--card:#fff;--border:#e2e5ea;--accent:#4f46e5;--accent-hover:#4338ca;--text:#1f2937;--muted:#6b7280;--green:#16a34a;--orange:#ea580c;--red:#dc2626;--blue:#2563eb;--radius:8px}
  body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
  .container{max-width:1200px;margin:0 auto;padding:1.5rem}
  h1{font-size:1.5rem;font-weight:700;margin-bottom:.25rem}
  .subtitle{color:var(--muted);font-size:.875rem;margin-bottom:1.5rem}

  /* API Status */
  .api-status{display:inline-flex;align-items:center;gap:.375rem;font-size:.75rem;padding:2px 10px;border-radius:999px;margin-left:.75rem;vertical-align:middle}
  .api-status.online{background:#dcfce7;color:#166534}
  .api-status.offline{background:#fee2e2;color:#991b1b}
  .api-status.checking{background:#fef3c7;color:#92400e}
  .api-dot{width:6px;height:6px;border-radius:50%;display:inline-block}
  .api-status.online .api-dot{background:#16a34a}
  .api-status.offline .api-dot{background:#dc2626}
  .api-status.checking .api-dot{background:#ea580c}

  /* Input Card */
  .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;margin-bottom:1rem}
  .card h2{font-size:1rem;font-weight:600;margin-bottom:.75rem}
  textarea{width:100%;min-height:100px;padding:.625rem;border:1px solid var(--border);border-radius:var(--radius);font-family:monospace;font-size:.8125rem;resize:vertical}
  textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(79,70,229,.15)}
  .actions{display:flex;gap:.625rem;align-items:center;margin-top:.75rem;flex-wrap:wrap}
  .btn{display:inline-flex;align-items:center;gap:.375rem;padding:.5rem 1rem;border:none;border-radius:var(--radius);font-size:.8125rem;font-weight:600;cursor:pointer;transition:background .15s}
  .btn-primary{background:var(--accent);color:#fff}
  .btn-primary:hover{background:var(--accent-hover)}
  .btn-primary:disabled{opacity:.5;cursor:not-allowed}
  .btn-secondary{background:#f3f4f6;color:var(--text);border:1px solid var(--border)}
  .btn-secondary:hover{background:#e5e7eb}
  .upload-label{display:inline-flex;align-items:center;gap:.375rem;padding:.5rem 1rem;border-radius:var(--radius);font-size:.8125rem;font-weight:600;cursor:pointer;background:#f3f4f6;color:var(--text);border:1px solid var(--border);transition:background .15s}
  .upload-label:hover{background:#e5e7eb}
  .upload-label input{display:none}
  .counter{margin-left:auto;font-size:.8125rem;color:var(--muted)}

  /* Progress */
  .progress-bar{display:none;height:4px;background:#e5e7eb;border-radius:2px;margin-top:.75rem;overflow:hidden}
  .progress-bar.active{display:block}
  .progress-fill{height:100%;background:var(--accent);border-radius:2px;transition:width .3s}
  .status-msg{font-size:.8125rem;color:var(--muted);margin-top:.375rem;min-height:1.25rem}
  .status-msg.error{color:var(--red)}

  /* Error banner */
  .error-banner{display:none;background:#fef2f2;border:1px solid #fecaca;border-radius:var(--radius);padding:.75rem 1rem;margin-bottom:1rem;font-size:.8125rem;color:#991b1b}
  .error-banner.visible{display:flex;align-items:center;gap:.5rem}
  .error-banner .dismiss{margin-left:auto;cursor:pointer;font-weight:700;font-size:1rem;line-height:1;color:#991b1b;background:none;border:none}

  /* Controls Bar */
  .controls{display:flex;gap:.625rem;align-items:center;flex-wrap:wrap;margin-bottom:.75rem}
  .search-input{flex:1;min-width:200px;padding:.5rem .75rem;border:1px solid var(--border);border-radius:var(--radius);font-size:.8125rem}
  .search-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(79,70,229,.15)}
  select{padding:.5rem .75rem;border:1px solid var(--border);border-radius:var(--radius);font-size:.8125rem;background:var(--card)}

  /* Summary */
  .summary{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
  .summary .stat{padding:.5rem 1rem;border-radius:var(--radius);font-size:.8125rem;font-weight:600}
  .stat-total{background:#ede9fe;color:#5b21b6}
  .stat-delivered{background:#dcfce7;color:#166534}
  .stat-transit{background:#dbeafe;color:#1e40af}
  .stat-ofd{background:#fef3c7;color:#92400e}
  .stat-returned{background:#fee2e2;color:#991b1b}
  .stat-failed{background:#f3f4f6;color:#6b7280}

  /* Table */
  .table-wrap{overflow-x:auto;background:var(--card);border:1px solid var(--border);border-radius:var(--radius)}
  table{width:100%;border-collapse:collapse;font-size:.8125rem}
  th{position:sticky;top:0;background:#f9fafb;padding:.625rem .75rem;text-align:left;font-weight:600;border-bottom:2px solid var(--border);cursor:pointer;user-select:none;white-space:nowrap}
  th:hover{background:#f3f4f6}
  th .sort-icon{display:inline-block;width:12px;margin-left:4px;color:var(--muted);font-size:.625rem}
  td{padding:.5rem .75rem;border-bottom:1px solid var(--border);vertical-align:top}
  tr:last-child td{border-bottom:none}
  tr:hover{background:#f9fafb}

  /* Status badges */
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:600;white-space:nowrap}
  .badge-delivered{background:#dcfce7;color:#166534}
  .badge-transit{background:#dbeafe;color:#1e40af}
  .badge-ofd{background:#fef3c7;color:#92400e}
  .badge-returned{background:#fee2e2;color:#991b1b}
  .badge-error{background:#f3f4f6;color:#6b7280}
  .badge-pending{background:#f3f4f6;color:#9ca3af}

  .carrier-tag{font-size:.6875rem;padding:1px 6px;border-radius:4px;background:#f3f4f6;color:var(--muted);white-space:nowrap}
  .events-toggle{font-size:.75rem;color:var(--accent);cursor:pointer;text-decoration:underline}
  .events-detail{display:none;margin-top:.375rem;font-size:.75rem;color:var(--muted);max-height:200px;overflow-y:auto}
  .events-detail.open{display:block}
  .event-row{padding:2px 0;border-bottom:1px dashed #e5e7eb}
  .event-row:last-child{border-bottom:none}
  .empty-state{text-align:center;padding:3rem 1rem;color:var(--muted)}

  .error-cell{color:var(--red);font-size:.75rem}
  .time-cell{white-space:nowrap;font-size:.75rem;color:var(--muted)}
  .extra-info{font-size:.6875rem;color:var(--muted);margin-top:2px}
  .extra-tag{display:inline-block;padding:1px 5px;border-radius:3px;background:#f0f0f0;color:#555;font-size:.6875rem;margin-right:3px;margin-top:2px}
  .warning-tag{display:inline-block;padding:1px 5px;border-radius:3px;background:#fef3c7;color:#92400e;font-size:.6875rem;margin-right:3px;margin-top:2px}

  @media(max-width:768px){
    .controls{flex-direction:column}
    .search-input{min-width:100%}
    .counter{margin-left:0}
  }
</style>
</head>
<body>
<div class="container">
  <h1>Courier Tracking Dashboard <span class="api-status checking" id="apiStatus"><span class="api-dot"></span> Checking...</span></h1>
  <p class="subtitle">Paste or upload tracking numbers, then track them as a concurrent batch. J&amp;T requests use a controlled server-side worker pool.</p>

  <div class="error-banner" id="errorBanner">
    <span id="errorBannerMsg"></span>
    <button class="dismiss" onclick="dismissError()">&times;</button>
  </div>

  <div class="card">
    <h2>Tracking Numbers</h2>
    <textarea id="waybillInput" placeholder="Paste tracking numbers here — one per line, or comma / space separated.&#10;&#10;Examples:&#10;6050926815554&#10;JDW101107292775&#10;JTE000944462953"></textarea>
    <div class="actions">
      <button class="btn btn-primary" id="trackBtn" onclick="startTracking()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        Track All
      </button>
      <label class="upload-label">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        Upload CSV/TXT
        <input type="file" id="fileInput" accept=".csv,.txt,.tsv" onchange="handleFile(event)"/>
      </label>
      <button class="btn btn-secondary" id="clearBtn" onclick="clearAll()">Clear</button>
      <span class="counter" id="inputCounter">0 numbers</span>
    </div>
    <div class="progress-bar" id="progressBar"><div class="progress-fill" id="progressFill"></div></div>
    <div class="status-msg" id="statusMsg"></div>
  </div>

  <div id="resultsSection" style="display:none">
    <div class="summary" id="summary"></div>

    <div class="controls">
      <input type="text" class="search-input" id="searchInput" placeholder="Search by tracking number, carrier, status, or location..." oninput="applyFilters()"/>
      <select id="statusFilter" onchange="applyFilters()">
        <option value="">All Statuses</option>
        <option value="Delivered">Delivered</option>
        <option value="In Transit">In Transit</option>
        <option value="Out for Delivery">Out for Delivery</option>
        <option value="Returned">Returned</option>
        <option value="Error">Error</option>
      </select>
      <select id="carrierFilter" onchange="applyFilters()">
        <option value="">All Carriers</option>
      </select>
      <button class="btn btn-primary" id="refreshBtn" onclick="startTracking()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
        Refresh All
      </button>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th onclick="sortTable('index')"># <span class="sort-icon"></span></th>
            <th onclick="sortTable('waybill')">Tracking Number <span class="sort-icon"></span></th>
            <th onclick="sortTable('carrier')">Carrier <span class="sort-icon"></span></th>
            <th onclick="sortTable('status')">Status <span class="sort-icon"></span></th>
            <th onclick="sortTable('lastUpdate')">Last Update <span class="sort-icon"></span></th>
            <th>Origin / Dest</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody id="resultsBody"></tbody>
      </table>
    </div>
  </div>
</div>

<script>
let allResults = [];
let sortKey = 'index';
let sortDir = 'asc';
let apiOnline = null;
const STORAGE_KEY = 'courier_dashboard_waybills';
// Tracking is non-idempotent from the CAPTCHA provider's perspective: retrying a
// timed-out bulk request duplicates every solve while the original keeps running.
// Large J&T batches are processed as groups of up to ten waybills per CAPTCHA.
const MAX_RETRIES = 0;
const MIN_REQUEST_TIMEOUT_MS = 180000;
const MAX_REQUEST_TIMEOUT_MS = 1800000;

function bulkRequestTimeoutMs(count) {
  // Budget roughly 35 seconds per wave of ten-waybill groups at five concurrent groups.
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, Math.ceil(Math.ceil(count / 10) / 5) * 35000 + 60000));
}

function parseWaybills(text) {
  return text
    .split(/[\\n,;\\t]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !/^(tracking|waybill|number|#)/i.test(s));
}

function updateCounter() {
  const nums = parseWaybills(document.getElementById('waybillInput').value);
  document.getElementById('inputCounter').textContent = nums.length + ' number' + (nums.length !== 1 ? 's' : '');
}
document.getElementById('waybillInput').addEventListener('input', updateCounter);

function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    const text = ev.target.result;
    const existing = document.getElementById('waybillInput').value.trim();
    document.getElementById('waybillInput').value = existing ? existing + '\\n' + text : text;
    updateCounter();
  };
  reader.readAsText(file);
  e.target.value = '';
}

function clearAll() {
  document.getElementById('waybillInput').value = '';
  updateCounter();
  allResults = [];
  document.getElementById('resultsSection').style.display = 'none';
  document.getElementById('statusMsg').textContent = '';
  document.getElementById('statusMsg').classList.remove('error');
  dismissError();
}

function showError(msg) {
  const banner = document.getElementById('errorBanner');
  document.getElementById('errorBannerMsg').textContent = msg;
  banner.classList.add('visible');
}

function dismissError() {
  document.getElementById('errorBanner').classList.remove('visible');
}

async function checkApiHealth() {
  const el = document.getElementById('apiStatus');
  el.className = 'api-status checking';
  el.innerHTML = '<span class="api-dot"></span> Checking...';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch('/health', { signal: ctrl.signal });
    clearTimeout(timer);
    if (resp.ok) {
      el.className = 'api-status online';
      el.innerHTML = '<span class="api-dot"></span> Online';
      apiOnline = true;
    } else {
      throw new Error('Health check returned ' + resp.status);
    }
  } catch (err) {
    el.className = 'api-status offline';
    el.innerHTML = '<span class="api-dot"></span> Unreachable';
    apiOnline = false;
  }
  return apiOnline;
}

async function fetchWithRetry(url, options, retries, timeoutMs = MIN_REQUEST_TIMEOUT_MS) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const resp = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok && resp.status >= 500 && attempt < retries) {
        lastErr = new Error('Server returned ' + resp.status);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') {
        lastErr = new Error('Request timed out after ' + Math.round(timeoutMs / 1000) + 's');
      }
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr || new Error('Request failed after ' + (retries + 1) + ' attempts');
}

function saveWaybills(waybills) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(waybills.slice(0, 250)));
  } catch (e) { /* ignore quota errors */ }
}

function loadSavedWaybills() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch (e) { return []; }
}

async function startTracking() {
  const ta = document.getElementById('waybillInput');
  const waybills = parseWaybills(ta.value);
  if (waybills.length === 0) {
    document.getElementById('statusMsg').textContent = 'Please enter at least one tracking number.';
    return;
  }
  if (waybills.length > 250) {
    document.getElementById('statusMsg').textContent = 'Maximum 250 tracking numbers per request.';
    return;
  }

  dismissError();
  saveWaybills(waybills);

  const trackBtn = document.getElementById('trackBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  trackBtn.disabled = true;
  refreshBtn.disabled = true;
  const bar = document.getElementById('progressBar');
  const fill = document.getElementById('progressFill');
  const msg = document.getElementById('statusMsg');
  msg.classList.remove('error');
  bar.classList.add('active');
  fill.style.width = '10%';
  msg.textContent = 'Submitting ' + waybills.length + ' waybill(s) for concurrent batch processing...';

  let progress = 10;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    progress = Math.min(progress + Math.max(0.5, (90 - progress) * 0.04), 90);
    fill.style.width = progress + '%';
    msg.textContent = 'Batch processing in parallel on the server — ' + Math.round((Date.now() - startedAt) / 1000) + 's elapsed (J&T concurrency is controlled).';
  }, 1000);

  try {
    const resp = await fetchWithRetry('/track/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waybills, order: 'desc' }),
    }, MAX_RETRIES, bulkRequestTimeoutMs(waybills.length));

    const data = await resp.json();
    clearInterval(timer);
    fill.style.width = '100%';

    if (data.error) {
      msg.textContent = 'Error: ' + data.error;
      msg.classList.add('error');
      trackBtn.disabled = false;
      refreshBtn.disabled = false;
      return;
    }

    allResults = (data.results || []).map((r, i) => {
      const extra = r.result?.extra || {};
      const warnings = r.result?.warnings || [];
      return {
        index: i + 1,
        waybill: r.waybill,
        carrier: r.carrier || 'unknown',
        carrierName: r.result?.carrierName || r.carrier || 'Unknown',
        status: r.result?.normalizedStatus || (r.error ? 'Error' : 'Unknown'),
        latestStatus: r.result?.latestStatusDetail || r.result?.latestStatus || (r.error?.message) || '\\u2014',
        lastUpdate: r.result?.latestTime || null,
        found: r.result?.found || false,
        events: r.result?.events || [],
        error: r.error || null,
        undeliveryReason: r.result?.undeliveryReason || null,
        extra: extra,
        warnings: warnings,
        origin: extra.sendSite || extra.originCity || extra.senderCity || null,
        destination: extra.dispatchStation || extra.destCity || extra.receiverCity || null,
        country: extra.country || null,
      };
    });

    msg.textContent = 'Done \\u2014 ' + data.successful + ' found, ' + data.failed + ' failed out of ' + data.total + '.';

    checkApiHealth();
    renderResults();
  } catch (err) {
    clearInterval(timer);
    fill.style.width = '0%';
    bar.classList.remove('active');

    const isNetwork = err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('timed out');
    if (isNetwork) {
      msg.textContent = 'API unreachable \\u2014 the tracking server may be starting up. Please try again in a moment.';
      msg.classList.add('error');
      showError('Could not connect to the tracking API. The server may be cold-starting (auto_stop is enabled). Retrying automatically...');
      checkApiHealth();
      setTimeout(() => {
        dismissError();
        msg.textContent = 'Retrying...';
        trackBtn.disabled = false;
        refreshBtn.disabled = false;
        startTracking();
      }, 5000);
      return;
    }

    msg.textContent = 'Request failed: ' + err.message;
    msg.classList.add('error');
  }

  setTimeout(() => { bar.classList.remove('active'); }, 1000);
  trackBtn.disabled = false;
  refreshBtn.disabled = false;
}

function renderResults() {
  document.getElementById('resultsSection').style.display = 'block';
  renderSummary();
  populateCarrierFilter();
  applyFilters();
}

function renderSummary() {
  const total = allResults.length;
  const delivered = allResults.filter(r => r.status === 'Delivered').length;
  const transit = allResults.filter(r => r.status === 'In Transit').length;
  const ofd = allResults.filter(r => r.status === 'Out for Delivery').length;
  const returned = allResults.filter(r => r.status === 'Returned').length;
  const failed = allResults.filter(r => r.status === 'Error' || r.status === 'Unknown').length;

  document.getElementById('summary').innerHTML =
    '<span class="stat stat-total">Total: ' + total + '</span>' +
    '<span class="stat stat-delivered">Delivered: ' + delivered + '</span>' +
    '<span class="stat stat-transit">In Transit: ' + transit + '</span>' +
    '<span class="stat stat-ofd">Out for Delivery: ' + ofd + '</span>' +
    '<span class="stat stat-returned">Returned: ' + returned + '</span>' +
    '<span class="stat stat-failed">Failed/Unknown: ' + failed + '</span>';
}

function populateCarrierFilter() {
  const carriers = [...new Set(allResults.map(r => r.carrier))];
  const sel = document.getElementById('carrierFilter');
  const current = sel.value;
  sel.innerHTML = '<option value="">All Carriers</option>';
  carriers.sort().forEach(c => {
    sel.innerHTML += '<option value="' + c + '">' + c + '</option>';
  });
  sel.value = current;
}

function applyFilters() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const statusF = document.getElementById('statusFilter').value;
  const carrierF = document.getElementById('carrierFilter').value;

  let filtered = allResults.filter(r => {
    if (statusF) {
      if (statusF === 'Error' && r.status !== 'Error' && r.status !== 'Unknown') return false;
      if (statusF !== 'Error' && r.status !== statusF) return false;
    }
    if (carrierF && r.carrier !== carrierF) return false;
    if (search) {
      const hay = (r.waybill + ' ' + r.carrier + ' ' + r.carrierName + ' ' + r.status + ' ' + r.latestStatus + ' ' + (r.origin || '') + ' ' + (r.destination || '') + ' ' + (r.country || '')).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    let va, vb;
    switch (sortKey) {
      case 'index': va = a.index; vb = b.index; break;
      case 'waybill': va = a.waybill; vb = b.waybill; break;
      case 'carrier': va = a.carrier; vb = b.carrier; break;
      case 'status': va = a.status; vb = b.status; break;
      case 'lastUpdate': va = a.lastUpdate || ''; vb = b.lastUpdate || ''; break;
      default: va = a.index; vb = b.index;
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  renderTable(filtered);
}

function sortTable(key) {
  if (sortKey === key) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey = key;
    sortDir = 'asc';
  }
  document.querySelectorAll('th .sort-icon').forEach(el => el.textContent = '');
  const idx = ['index','waybill','carrier','status','lastUpdate'].indexOf(key);
  if (idx >= 0) {
    document.querySelectorAll('th .sort-icon')[idx].textContent = sortDir === 'asc' ? '\\u25B2' : '\\u25BC';
  }
  applyFilters();
}

function statusBadge(status) {
  const map = {
    'Delivered': 'badge-delivered',
    'In Transit': 'badge-transit',
    'Out for Delivery': 'badge-ofd',
    'Returned': 'badge-returned',
    'Error': 'badge-error',
    'Unknown': 'badge-pending',
  };
  return '<span class="badge ' + (map[status] || 'badge-pending') + '">' + escHtml(status) + '</span>';
}

function formatTime(iso) {
  if (!iso) return '<span class="time-cell">\\u2014</span>';
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return '<span class="time-cell">' + date + ' ' + time + '</span>';
  } catch { return '<span class="time-cell">' + escHtml(iso) + '</span>'; }
}

function escHtml(s) {
  const div = document.createElement('div');
  div.textContent = s || '';
  return div.innerHTML;
}

function renderExtraInfo(r) {
  const parts = [];
  if (r.origin) parts.push('<span class="extra-tag">From: ' + escHtml(r.origin) + '</span>');
  if (r.destination) parts.push('<span class="extra-tag">To: ' + escHtml(r.destination) + '</span>');
  if (r.country) parts.push('<span class="extra-tag">' + escHtml(r.country) + '</span>');
  if (r.warnings && r.warnings.length > 0) {
    r.warnings.forEach(w => parts.push('<span class="warning-tag">' + escHtml(w) + '</span>'));
  }
  const extraKeys = Object.keys(r.extra || {}).filter(k => !['sendSite','dispatchStation','country','originCity','destCity','senderCity','receiverCity'].includes(k));
  extraKeys.forEach(k => {
    const v = r.extra[k];
    if (v !== null && v !== undefined && v !== '') {
      parts.push('<span class="extra-tag">' + escHtml(k) + ': ' + escHtml(String(v)) + '</span>');
    }
  });
  return parts.length > 0 ? '<div class="extra-info">' + parts.join('') + '</div>' : '';
}

function renderTable(rows) {
  const tbody = document.getElementById('resultsBody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No results match your filters.</td></tr>';
    return;
  }

  let html = '';
  for (const r of rows) {
    const eventsId = 'ev-' + r.index;
    let detailHtml = '';
    if (r.error) {
      detailHtml = '<span class="error-cell">' + escHtml(r.error.message) + '</span>';
      if (r.error.captchaRequired) {
        detailHtml += '<br/><span class="warning-tag">CAPTCHA required</span>';
      }
    } else if (r.events.length > 0) {
      detailHtml = '<span class="events-toggle" onclick="toggleEvents(\\'' + eventsId + '\\')">' + r.events.length + ' event(s)</span>';
      detailHtml += '<div class="events-detail" id="' + eventsId + '">';
      for (const ev of r.events) {
        const t = ev.time ? new Date(ev.time).toLocaleString('en-GB', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '';
        const step = ev.step ? '<span class="extra-tag">#' + ev.step + '</span> ' : '';
        detailHtml += '<div class="event-row">' + step + '<b>' + escHtml(ev.status || '\\u2014') + '</b> ' + t + (ev.location ? ' @ ' + escHtml(ev.location) : '') + '<br/>' + escHtml(ev.description) + '</div>';
      }
      detailHtml += '</div>';
    } else {
      detailHtml = '<span class="time-cell">No events</span>';
    }

    const originDest = renderExtraInfo(r);

    html += '<tr>' +
      '<td>' + r.index + '</td>' +
      '<td><strong>' + escHtml(r.waybill) + '</strong></td>' +
      '<td><span class="carrier-tag">' + escHtml(r.carrierName) + '</span></td>' +
      '<td>' + statusBadge(r.status) + '<br/><span style="font-size:.7rem;color:var(--muted)">' + escHtml(r.latestStatus) + '</span>' + (r.undeliveryReason ? '<br/><span style="font-size:.675rem;color:var(--red)">Reason: ' + escHtml(r.undeliveryReason) + '</span>' : '') + '</td>' +
      '<td>' + formatTime(r.lastUpdate) + '</td>' +
      '<td>' + originDest + '</td>' +
      '<td>' + detailHtml + '</td>' +
      '</tr>';
  }
  tbody.innerHTML = html;
}

function toggleEvents(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

(async function init() {
  checkApiHealth();

  const params = new URLSearchParams(window.location.search);
  const urlWaybills = params.get('waybills') || params.get('waybill') || params.get('w');

  if (urlWaybills) {
    const nums = urlWaybills.split(/[,;\\s]+/).map(s => s.trim()).filter(Boolean);
    if (nums.length > 0) {
      document.getElementById('waybillInput').value = nums.join('\\n');
      updateCounter();
      startTracking();
      return;
    }
  }

  const saved = loadSavedWaybills();
  if (saved.length > 0) {
    document.getElementById('waybillInput').value = saved.join('\\n');
    updateCounter();
  }
})();
</script>
</body>
</html>`;
