/**
 * Self-contained dashboard HTML served as an inline string.
 * Provides bulk tracking input (paste / CSV upload), a sortable &
 * filterable results table, and a one-click bulk refresh.
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

  @media(max-width:768px){
    .controls{flex-direction:column}
    .search-input{min-width:100%}
    .counter{margin-left:0}
  }
</style>
</head>
<body>
<div class="container">
  <h1>Courier Tracking Dashboard</h1>
  <p class="subtitle">Paste or upload tracking numbers, then track them all at once.</p>

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
      <input type="text" class="search-input" id="searchInput" placeholder="Search by tracking number, carrier, or status..." oninput="applyFilters()"/>
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

  const trackBtn = document.getElementById('trackBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  trackBtn.disabled = true;
  refreshBtn.disabled = true;
  const bar = document.getElementById('progressBar');
  const fill = document.getElementById('progressFill');
  const msg = document.getElementById('statusMsg');
  bar.classList.add('active');
  fill.style.width = '10%';
  msg.textContent = 'Tracking ' + waybills.length + ' waybill(s)...';

  // Animate progress bar
  let progress = 10;
  const timer = setInterval(() => {
    progress = Math.min(progress + Math.random() * 8, 90);
    fill.style.width = progress + '%';
  }, 500);

  try {
    const resp = await fetch('/track/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waybills, order: 'desc' }),
    });
    const data = await resp.json();
    clearInterval(timer);
    fill.style.width = '100%';

    if (data.error) {
      msg.textContent = 'Error: ' + data.error;
      trackBtn.disabled = false;
      refreshBtn.disabled = false;
      return;
    }

    allResults = (data.results || []).map((r, i) => ({
      index: i + 1,
      waybill: r.waybill,
      carrier: r.carrier || 'unknown',
      carrierName: r.result?.carrierName || r.carrier || 'Unknown',
      status: r.result?.normalizedStatus || (r.error ? 'Error' : 'Unknown'),
      latestStatus: r.result?.latestStatus || (r.error?.message) || '—',
      lastUpdate: r.result?.latestTime || null,
      found: r.result?.found || false,
      events: r.result?.events || [],
      error: r.error || null,
    }));

    msg.textContent = 'Done — ' + data.successful + ' found, ' + data.failed + ' failed out of ' + data.total + '.';
    renderResults();
  } catch (err) {
    clearInterval(timer);
    msg.textContent = 'Request failed: ' + err.message;
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
      const hay = (r.waybill + ' ' + r.carrier + ' ' + r.carrierName + ' ' + r.status + ' ' + r.latestStatus).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  // Sort
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
  // Update sort icons
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
  if (!iso) return '<span class="time-cell">—</span>';
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

function renderTable(rows) {
  const tbody = document.getElementById('resultsBody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No results match your filters.</td></tr>';
    return;
  }

  let html = '';
  for (const r of rows) {
    const eventsId = 'ev-' + r.index;
    let detailHtml = '';
    if (r.error) {
      detailHtml = '<span class="error-cell">' + escHtml(r.error.message) + '</span>';
    } else if (r.events.length > 0) {
      detailHtml = '<span class="events-toggle" onclick="toggleEvents(\\'' + eventsId + '\\')">' + r.events.length + ' event(s)</span>';
      detailHtml += '<div class="events-detail" id="' + eventsId + '">';
      for (const ev of r.events) {
        const t = ev.time ? new Date(ev.time).toLocaleString('en-GB', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '';
        detailHtml += '<div class="event-row"><b>' + escHtml(ev.status || '—') + '</b> ' + t + (ev.location ? ' @ ' + escHtml(ev.location) : '') + '<br/>' + escHtml(ev.description) + '</div>';
      }
      detailHtml += '</div>';
    } else {
      detailHtml = '<span class="time-cell">No events</span>';
    }

    html += '<tr>' +
      '<td>' + r.index + '</td>' +
      '<td><strong>' + escHtml(r.waybill) + '</strong></td>' +
      '<td><span class="carrier-tag">' + escHtml(r.carrierName) + '</span></td>' +
      '<td>' + statusBadge(r.status) + '<br/><span style="font-size:.7rem;color:var(--muted)">' + escHtml(r.latestStatus) + '</span></td>' +
      '<td>' + formatTime(r.lastUpdate) + '</td>' +
      '<td>' + detailHtml + '</td>' +
      '</tr>';
  }
  tbody.innerHTML = html;
}

function toggleEvents(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}
</script>
</body>
</html>`;
