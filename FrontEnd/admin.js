// ════════════════════════════════════════════════════════════════
// Credify — ADMIN DASHBOARD (admin.js)
// Loaded after app.js; reuses sbClient, Auth, goto, escapeHtml.
//
// Everything shown here is computed live from Supabase rows.
// Access control is enforced server-side by RLS (is_admin() policies);
// the UI gate below is just for honest navigation, not security.
// ════════════════════════════════════════════════════════════════

// ── Entry ───────────────────────────────────────────────────────
function openAdmin() {
  if (!Auth.isLoggedIn() || !Auth.isAdmin) {
    goto('screen-home-auth');
    return;
  }
  goto('screen-admin');
  switchAdminTab('overview');
}

function switchAdminTab(tab) {
  ['overview', 'flags', 'trends', 'claims'].forEach(t => {
    const panel = document.getElementById('apanel-' + t);
    const btn   = document.getElementById('atab-' + t);
    if (panel) panel.style.display = (t === tab) ? '' : 'none';
    if (btn)   btn.classList.toggle('active', t === tab);
  });
  if (tab === 'overview') loadAdminOverview();
  if (tab === 'flags')    loadAdminFlags();
  if (tab === 'trends')   loadAdminTrends();
  if (tab === 'claims')   loadAdminClaims();
}

// ── TAB 1: OVERVIEW — stats computed from real rows ─────────────
async function loadAdminOverview() {
  const grid = document.getElementById('stat-grid');
  grid.innerHTML = '<div class="admin-loading">Loading…</div>';
  try {
    // Admin RLS policy lets us read ALL reports, not just our own.
    const [repRes, flagRes] = await Promise.all([
      sbClient.from('reports')
        .select('score, verdict, created_at, user_id')
        .order('created_at', { ascending: false }).limit(1000),
      sbClient.from('flags').select('status'),
    ]);
    const reports = repRes.data || [];
    const flags   = flagRes.data || [];

    const total   = reports.length;
    const avg     = total ? Math.round(reports.reduce((a, r) => a + (r.score || 0), 0) / total) : 0;
    const pending = flags.filter(f => f.status === 'pending').length;
    const users   = new Set(reports.map(r => r.user_id)).size;

    grid.innerHTML =
      statCard('Total scans', total.toLocaleString(), 'across all accounts') +
      statCard('Average score', avg, 'out of 100') +
      statCard('Pending flags', pending, pending ? 'awaiting review' : 'queue is clear', pending ? 'warn' : '') +
      statCard('Active users', users, 'have run scans');

    const badge = document.getElementById('flags-badge');
    if (badge) badge.textContent = pending ? pending : '';

    renderVerdictBars(reports);
    renderActivityChart(reports);
  } catch (e) {
    grid.innerHTML = '<div class="admin-loading">Could not load stats — has admin.sql been run?</div>';
  }
}

function statCard(label, value, sub, mod) {
  return `<div class="stat-card ${mod || ''}">` +
           `<div class="stat-value">${value}</div>` +
           `<div class="stat-label">${label}</div>` +
           `<div class="stat-sub">${sub}</div>` +
         `</div>`;
}

function renderVerdictBars(reports) {
  const el = document.getElementById('verdict-bars');
  if (!el) return;
  const total = reports.length || 1;
  const counts = { credible: 0, uncertain: 0, not_credible: 0 };
  reports.forEach(r => { if (counts[r.verdict] !== undefined) counts[r.verdict]++; });
  const rows = [
    ['Not fake news', counts.credible, 'green'],
    ['Unsure',        counts.uncertain, 'yellow'],
    ['Likely fake',   counts.not_credible, 'red'],
  ];
  el.innerHTML = rows.map(([label, n, cls]) => {
    const pct = Math.round((n / total) * 100);
    return `<div class="vbar-row">` +
             `<span class="vbar-label">${label}</span>` +
             `<div class="vbar-track"><div class="vbar-fill ${cls}" style="width:${pct}%"></div></div>` +
             `<span class="vbar-num">${n} · ${pct}%</span>` +
           `</div>`;
  }).join('');
}

function renderActivityChart(reports) {
  const el = document.getElementById('activity-chart');
  if (!el) return;
  // Count scans per day for the last 14 days
  const days = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push({ key: d.toDateString(), label: d.toLocaleDateString(undefined, { day: 'numeric' }), n: 0 });
  }
  const idx = Object.fromEntries(days.map((d, i) => [d.key, i]));
  reports.forEach(r => {
    const k = new Date(r.created_at).toDateString();
    if (idx[k] !== undefined) days[idx[k]].n++;
  });
  const max = Math.max(1, ...days.map(d => d.n));
  el.innerHTML = days.map(d =>
    `<div class="act-col" title="${d.n} scan(s)">` +
      `<div class="act-bar" style="height:${Math.max(4, Math.round((d.n / max) * 100))}%"></div>` +
      `<div class="act-label">${d.label}</div>` +
    `</div>`).join('');
}

// ── TAB 2: FLAGS — the review queue ─────────────────────────────
let flagFilter = 'all';
let flagsCache = [];

function setFlagFilter(f) {
  flagFilter = f;
  document.querySelectorAll('.filter-pill-a')
    .forEach(b => b.classList.toggle('active', b.dataset.f === f));
  renderFlagList();
}

async function loadAdminFlags() {
  const el = document.getElementById('flag-list');
  el.innerHTML = '<div class="admin-loading">Loading…</div>';
  try {
    const { data, error } = await sbClient.from('flags')
      .select('id, created_at, user_id, content_preview, score, verdict, reason, status')
      .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    flagsCache = data || [];
    renderFlagList();
  } catch (e) {
    el.innerHTML = '<div class="admin-loading">Could not load flags — has admin.sql been run?</div>';
  }
}

function renderFlagList() {
  const el = document.getElementById('flag-list');
  const rows = flagFilter === 'all' ? flagsCache : flagsCache.filter(f => f.status === flagFilter);
  if (!rows.length) {
    el.innerHTML = '<div class="admin-loading">No flags here. 🎉</div>';
    return;
  }
  el.innerHTML = rows.map(f => {
    const cls = f.score >= 70 ? 'green' : f.score >= 45 ? 'yellow' : 'red';
    const when = new Date(f.created_at).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const who = (f.user_id || '').slice(0, 8);
    const actions = f.status === 'pending'
      ? `<button class="fbtn ok" onclick="setFlagStatus('${f.id}','reviewed')">✓ Mark reviewed</button>` +
        `<button class="fbtn no" onclick="setFlagStatus('${f.id}','dismissed')">✕ Dismiss</button>`
      : `<button class="fbtn" onclick="setFlagStatus('${f.id}','pending')">↺ Reopen</button>`;
    return `<div class="flag-item">` +
             `<span class="rs-badge ${cls}">${f.score ?? '–'}</span>` +
             `<div class="flag-body">` +
               `<div class="flag-preview">${escapeHtml(f.content_preview || 'No preview')}</div>` +
               `<div class="flag-reason">“${escapeHtml(f.reason)}”</div>` +
               `<div class="flag-sub">${when} · user ${escapeHtml(who)}… · ` +
                 `<span class="status-pill ${f.status}">${f.status}</span></div>` +
             `</div>` +
             `<div class="flag-actions">${actions}</div>` +
           `</div>`;
  }).join('');
}

async function setFlagStatus(id, status) {
  try {
    const patch = { status, reviewed_at: status === 'pending' ? null : new Date().toISOString() };
    const { error } = await sbClient.from('flags').update(patch).eq('id', id);
    if (error) throw error;
    const f = flagsCache.find(x => x.id === id);
    if (f) f.status = status;
    renderFlagList();
    // keep the tab badge honest
    const pending = flagsCache.filter(x => x.status === 'pending').length;
    const badge = document.getElementById('flags-badge');
    if (badge) badge.textContent = pending ? pending : '';
  } catch (e) {
    alert('Update failed: ' + (e.message || e));
  }
}

// ── TAB 3: TRENDS — drives the public Trends page ───────────────
async function loadAdminTrends() {
  const el = document.getElementById('trend-rows');
  el.innerHTML = '<div class="admin-loading">Loading…</div>';
  try {
    const { data, error } = await sbClient.from('trends')
      .select('id, topic, flagged_count, pct')
      .order('flagged_count', { ascending: false });
    if (error) throw error;
    if (!data.length) {
      el.innerHTML = '<div class="admin-loading">No trend rows yet — run seed_demo_data() or add one below.</div>';
      return;
    }
    el.innerHTML = data.map(t =>
      `<div class="edit-row" id="trow-${t.id}">` +
        `<input class="text-input a-input" value="${escapeHtml(t.topic)}" data-k="topic"/>` +
        `<input class="text-input a-input a-input-num" type="number" value="${t.flagged_count}" data-k="flagged_count"/>` +
        `<input class="text-input a-input a-input-num" type="number" min="0" max="100" value="${t.pct}" data-k="pct"/>` +
        `<button class="fbtn ok" onclick="saveTrend('${t.id}')">Save</button>` +
        `<button class="fbtn no" onclick="deleteTrend('${t.id}')">Delete</button>` +
      `</div>`).join('');
  } catch (e) {
    el.innerHTML = '<div class="admin-loading">Could not load trends — has admin.sql been run?</div>';
  }
}

function readEditRow(rowId) {
  const row = document.getElementById(rowId);
  const out = {};
  row.querySelectorAll('input').forEach(i => {
    out[i.dataset.k] = i.type === 'number' ? Number(i.value) : i.value.trim();
  });
  return out;
}

async function saveTrend(id) {
  const vals = readEditRow('trow-' + id);
  if (!vals.topic) { alert('Topic cannot be empty.'); return; }
  vals.pct = Math.max(0, Math.min(100, vals.pct || 0));
  vals.updated_at = new Date().toISOString();
  const { error } = await sbClient.from('trends').update(vals).eq('id', id);
  if (error) { alert('Save failed: ' + error.message); return; }
  loadAdminTrends();
  loadTrends(); // refresh the public page too
}

async function deleteTrend(id) {
  if (!confirm('Delete this topic from the public Trends page?')) return;
  const { error } = await sbClient.from('trends').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  loadAdminTrends();
  loadTrends();
}

async function addTrend() {
  const topic = (document.getElementById('new-trend-topic').value || '').trim();
  const count = Number(document.getElementById('new-trend-count').value) || 0;
  const pct   = Math.max(0, Math.min(100, Number(document.getElementById('new-trend-pct').value) || 0));
  if (!topic) { alert('Enter a topic name.'); return; }
  const { error } = await sbClient.from('trends').insert({ topic, flagged_count: count, pct });
  if (error) { alert('Add failed: ' + error.message); return; }
  document.getElementById('new-trend-topic').value = '';
  document.getElementById('new-trend-count').value = '';
  document.getElementById('new-trend-pct').value = '';
  loadAdminTrends();
  loadTrends();
}

// ── TAB 4: KNOWN-FALSE CLAIMS — edits the scan engine's list ────
async function loadAdminClaims() {
  const el = document.getElementById('claim-rows');
  el.innerHTML = '<div class="admin-loading">Loading…</div>';
  try {
    const { data, error } = await sbClient.from('known_claims')
      .select('id, pattern, reason, active')
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (!data.length) {
      el.innerHTML = '<div class="admin-loading">No dynamic claims yet — add one below. The engine merges them within ~60s.</div>';
      return;
    }
    el.innerHTML = data.map(c =>
      `<div class="edit-row ${c.active ? '' : 'inactive'}" id="crow-${c.id}">` +
        `<input class="text-input a-input mono" value="${escapeHtml(c.pattern)}" data-k="pattern"/>` +
        `<input class="text-input a-input" value="${escapeHtml(c.reason)}" data-k="reason"/>` +
        `<button class="fbtn" onclick="toggleClaim('${c.id}', ${!c.active})">${c.active ? '⏸ Disable' : '▶ Enable'}</button>` +
        `<button class="fbtn ok" onclick="saveClaim('${c.id}')">Save</button>` +
        `<button class="fbtn no" onclick="deleteClaim('${c.id}')">Delete</button>` +
      `</div>`).join('');
  } catch (e) {
    el.innerHTML = '<div class="admin-loading">Could not load claims — has admin.sql been run?</div>';
  }
}

async function saveClaim(id) {
  const vals = readEditRow('crow-' + id);
  if (!vals.pattern || !vals.reason) { alert('Pattern and reason are both required.'); return; }
  const { error } = await sbClient.from('known_claims').update(vals).eq('id', id);
  if (error) { alert('Save failed: ' + error.message); return; }
  loadAdminClaims();
}

async function toggleClaim(id, active) {
  const { error } = await sbClient.from('known_claims').update({ active }).eq('id', id);
  if (error) { alert('Update failed: ' + error.message); return; }
  loadAdminClaims();
}

async function deleteClaim(id) {
  if (!confirm('Delete this claim from the engine\'s dynamic list?')) return;
  const { error } = await sbClient.from('known_claims').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  loadAdminClaims();
}

async function addClaim() {
  const pattern = (document.getElementById('new-claim-pattern').value || '').trim();
  const reason  = (document.getElementById('new-claim-reason').value || '').trim();
  if (!pattern || !reason) { alert('Enter both a pattern and a reason.'); return; }
  const { error } = await sbClient.from('known_claims').insert({ pattern, reason, active: true });
  if (error) { alert('Add failed: ' + error.message); return; }
  document.getElementById('new-claim-pattern').value = '';
  document.getElementById('new-claim-reason').value = '';
  loadAdminClaims();
}
