// ===========================
//  CREDIFY — APP.JS
// ===========================

// ── Config ─────────────────────────────────────────────────────
//the url and anon key comes from a config.js file that can't be uploaded because we can't
// share the anon key (really unsafe)
const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const captchaWidgets = {}; // container id -> turnstile widget id
// ── Screen navigation ──────────────────────────────────────────
function goto(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) {
    target.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Captcha boxes have zero width while their screen is hidden, so they
    // can't be scaled until now. Re-fit once this screen is visible.
    if (typeof fitCaptchas === 'function') requestAnimationFrame(fitCaptchas);
    // Restart the analysing timeline every time the loading screen opens.
    if (screenId === 'screen-loading') startLoadingSteps();
  }
}

// ── Filter pills (History screen) ──────────────────────────────
function setFilter(el) {
  const parent = el.closest('.filter-row');
  parent.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
}

// ── Loading screen ─────────────────────────────────────────────
// Steps run on an estimated timeline so the screen feels alive, then snap to
// complete the moment the real analysis returns. The last step is never
// auto-completed: if the backend is slow, it holds there until the result lands.

const LOADING_STEP_MS = [700, 1100, 2600, 1500];   // dwell time per step, last step excluded
let loadingTimers = [];

function clearLoadingTimers() {
  loadingTimers.forEach(clearTimeout);
  loadingTimers = [];
}

function setStepState(step, state) {
  if (!step) return;
  const dot = step.querySelector('.step-dot');
  step.classList.remove('pending', 'active', 'done');
  step.classList.add(state);
  if (dot) {
    dot.classList.remove('pending', 'active', 'done');
    dot.classList.add(state);
  }
}

function loadingStepEls() {
  return Array.from(document.querySelectorAll('#loading-steps .step'));
}

function startLoadingSteps() {
  clearLoadingTimers();
  const steps = loadingStepEls();
  if (!steps.length) return;

  steps.forEach(s => setStepState(s, 'pending'));
  // Force a reflow so the reset paints before the first step lights up.
  void steps[0].offsetWidth;
  setStepState(steps[0], 'active');

  let at = 0;
  LOADING_STEP_MS.forEach((ms, i) => {
    if (i + 1 >= steps.length) return;
    at += ms;
    loadingTimers.push(setTimeout(() => {
      setStepState(steps[i], 'done');
      setStepState(steps[i + 1], 'active');
    }, at));
  });
}

// Completes any remaining steps in a quick cascade, then resolves so the
// caller can move on to the result screen.
function finishLoadingSteps() {
  clearLoadingTimers();
  const remaining = loadingStepEls().filter(s => !s.classList.contains('done'));
  return new Promise(resolve => {
    let at = 0;
    remaining.forEach(step => {
      at += 130;
      loadingTimers.push(setTimeout(() => setStepState(step, 'done'), at));
    });
    loadingTimers.push(setTimeout(resolve, at + 420));
  });
}

// ── Animate credibility bars on result screens ──────────────────
function animateBars() {
  // Credibility bars: a full-width gradient clipped back to the score, so the
  // colour at the tip of the bar matches the value it represents.
  document.querySelectorAll('.cred-fill').forEach(bar => {
    const target = bar.style.getPropertyValue('--pct') || '0';
    bar.style.setProperty('--pct', '0');
    setTimeout(() => { bar.style.setProperty('--pct', target); }, 80);
  });
  // Trend bars still use plain width fills.
  document.querySelectorAll('.trend-bar-fill').forEach(bar => {
    const target = bar.style.width;
    bar.style.width = '0';
    setTimeout(() => { bar.style.width = target; }, 80);
  });
}
document.querySelectorAll('[id^="screen-result"], #screen-trends').forEach(screen => {
  new MutationObserver(mutations => {
    mutations.forEach(m => {
      if (m.target.classList.contains('active')) animateBars();
    });
  }).observe(screen, { attributes: true, attributeFilter: ['class'] });
});

// ──────────────────────────────────────────────────────────────
//  SMART COMPOSER
// ──────────────────────────────────────────────────────────────

// Auto-resize textarea as the user types
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// Detect what kind of input was pasted / typed and show a badge
const URL_RE = /^https?:\/\/\S+/i;
const URL_IN = /https?:\/\/\S+/i;

function detectInputType(value, badgeId = 'type-badge') {
  const badge = document.getElementById(badgeId);
  if (!badge) return;

  const trimmed = value.trim();
  if (!trimmed) {
    badge.textContent = '';
    badge.classList.remove('visible');
    return;
  }

  let label = '';
  if (URL_RE.test(trimmed)) {
    label = '🔗 URL detected';
  } else if (URL_IN.test(trimmed)) {
    label = '🔗 Contains URL';
  } else if (trimmed.length > 0) {
    label = '📝 Text claim';
  }

  badge.textContent = label;
  badge.classList.add('visible');
}

// Submit on Enter (Shift+Enter = newline)
function handleComposerKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    runScan();
  }
}

// ──────────────────────────────────────────────────────────────
//  SCAN ENGINE  (the actual credibility check)
// ──────────────────────────────────────────────────────────────

const BACKEND_URL = "https://credifyy.onrender.com";

fetch(`${BACKEND_URL}/`, { method: 'GET' }).catch(() => {});

// Grab whatever the user typed in the composer of the active screen.
function getComposerInput() {
  const active = document.querySelector('.screen.active');
  const ta = active && active.querySelector('.composer-textarea');
  return ta ? ta.value.trim() : '';
}

// Start a fresh check: clear any attached image, chips, and composer text.
function newCheck() {
  scanAttachment = null;
  document.querySelectorAll('.composer-attachments').forEach(el => { el.innerHTML = ''; });
  document.querySelectorAll('.composer-textarea').forEach(el => { el.value = ''; el.style.height = 'auto'; });
  document.querySelectorAll('.input-type-badge').forEach(el => { el.textContent = ''; el.classList.remove('visible'); });
  goto(Auth.isLoggedIn() ? 'screen-home-auth' : 'screen-home');
}

// The image currently attached to the composer (if any), kept so runScan
// can actually send it for analysis.
let scanAttachment = null;
let lastScan = null; // last payload, for the Re-check button

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

async function runScan() {
  const text = getComposerInput();
  const file = scanAttachment;

  // Build the payload for this scan, or reuse the last one (Re-check).
  let payload, displayLabel;
  if (text || file) {
    payload = { input: text };
    displayLabel = text;
    if (file) {
      try {
        const dataUrl = await readFileAsDataURL(file);
        payload.image = String(dataUrl).split(',')[1];   // strip "data:...;base64,"
        payload.image_type = file.type || 'image/png';
        payload.filename = file.name || 'upload';
        displayLabel = '🖼️ ' + payload.filename + (text ? ' — ' + text : '');
      } catch (e) {
        console.warn('[scan] could not read image', e);
      }
    }
    lastScan = payload;
  } else if (lastScan) {
    payload = lastScan;
    displayLabel = payload.filename ? ('🖼️ ' + payload.filename) : payload.input;
  } else {
    const active = document.querySelector('.screen.active');
    const ta = active && active.querySelector('.composer-textarea');
    if (ta) { ta.focus(); ta.placeholder = 'Paste a URL, type a claim, or attach an image first…'; }
    return;
  }

  // Show what's being analysed on the loading screen.
  const pill = document.getElementById('loading-pill');
  if (pill) pill.textContent = displayLabel && displayLabel.length > 90
    ? displayLabel.slice(0, 90) + '…' : (displayLabel || 'Analyzing…');
  goto('screen-loading');

  let report;
  try {
    // Abort if the backend doesn't answer within 75s, so the loading screen
    // can never get stuck — we fall back to the local heuristic instead.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75000);
    const res = await fetch(`${BACKEND_URL}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('bad status ' + res.status);
    report = await res.json();
    if (report.error) throw new Error(report.error);
  } catch (err) {
    console.warn('[scan] backend unavailable, using local engine:', err.message);
    report = heuristicScanJS(payload);
  }

  // Race the remaining steps to completion, then reveal the result.
  await finishLoadingSteps();

  renderResult(report);
  goto('screen-result-high');
  currentReportMeta = {
    preview: displayLabel,
    score: report.score,
    verdict: report.verdict,
    report_id: null // filled in by saveReport once the row exists
  };
  saveReport(payload, report); // account users: persist to report history
}

// Paint a report object into the result screen.
function renderResult(r) {
  lastReport = r;   // kept for the PDF export
  const level = r.verdict === 'credible' ? 'high'
              : r.verdict === 'uncertain' ? 'mid' : 'low';

  const setClass = (id, base) => {
    const el = document.getElementById(id);
    if (el) el.className = `${base} ${level}`;
  };
  const setText = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  // Bars are coloured by the shared red-to-green ramp in CSS (--score-ramp);
  // JS only supplies the percentage via clampPct(), so the colour under the tip
  // of a bar always matches the value it represents.

  setClass('rc-card', 'score-card');
  setClass('rc-circle', 'score-circle');
  setClass('rc-label', 'score-label');

  setText('rc-circle', r.score);
  setText('rc-label', r.label);
  setText('rc-desc', r.desc);

  const numEl = document.getElementById('rc-num');
  if (numEl) {
    numEl.innerHTML =
      `${r.score}<span style="font-size:18px;font-weight:400;color:var(--text3)">/100</span>`;
  }

  // Tags
  const tagWrap = document.getElementById('rc-tags');
  if (tagWrap) {
    tagWrap.innerHTML = '';
    (r.tags || []).forEach(t => {
      const span = document.createElement('span');
      span.className = `tag ${t.kind || 'gray'}`;
      span.textContent = t.text;
      tagWrap.appendChild(span);
    });
  }

  // Overall bar + confidence
  const ob = document.getElementById('rc-bar-overall');
  if (ob) ob.style.setProperty('--pct', clampPct(r.score));
  setText('rc-val-overall', r.score + '%');
  setText('rc-confidence', (r.confidence != null ? r.confidence : '—') + '%');

  // Dynamic breakdown rows (labels adapt to input type)
  const rows = document.getElementById('rc-breakdown-rows');
  if (rows) {
    rows.innerHTML = '';
    (r.breakdown || []).forEach(dim => {
      const v = typeof dim.value === 'number' ? dim.value : 0;
      const row = document.createElement('div');
      row.className = 'cred-row';
      row.innerHTML =
        `<span class="cred-key">${escapeHtml(dim.label)}</span>` +
        `<div class="cred-bar"><div class="cred-fill" style="--pct:${clampPct(v)}"></div></div>` +
        `<span class="cred-val">${v}%</span>`;
      rows.appendChild(row);
    });
  }

  // Dynamic details list
  const det = document.getElementById('rc-details');
  if (det) {
    det.innerHTML = '';
    (r.details || []).forEach(d => {
      const row = document.createElement('div');
      row.className = 'detail-row';
      const colorClass = d.color ? ` ${d.color}` : '';
      row.innerHTML =
        `<span class="dk">${escapeHtml(d.label)}</span>` +
        `<span class="dv${colorClass}">${escapeHtml(String(d.value))}</span>`;
      det.appendChild(row);
    });
  }
  const detTitle = document.getElementById('rc-details-title');
  if (detTitle) {
    detTitle.textContent = r.input_type === 'Image' ? 'Image details'
                         : r.input_type === 'Article' ? 'Source details'
                         : 'Details';
  }

  setText('rc-summary', r.summary || '');
  const engineLabel = r.engine === 'groq' ? 'Analysis by Llama (Groq)'
                    : r.engine === 'gemini' ? 'Analysis by Gemini'
                    : 'Signal-based analysis';
  setText('rc-engine', engineLabel);

  // Key findings (newer reports only — hide the box if absent)
  const findBox = document.getElementById('rc-findings-box');
  const findList = document.getElementById('rc-findings');
  if (findBox && findList) {
    const kf = Array.isArray(r.key_findings) ? r.key_findings : [];
    findBox.style.display = kf.length ? '' : 'none';
    findList.innerHTML = '';
    kf.forEach(f => {
      const li = document.createElement('li');
      li.className = 'finding-item';
      li.innerHTML = `<span class="finding-dot ${level}"></span><span>${escapeHtml(String(f))}</span>`;
      findList.appendChild(li);
    });
  }

  // Recommendation ("What you should do")
  const recoBox = document.getElementById('rc-reco-box');
  const recoEl  = document.getElementById('rc-reco');
  if (recoBox && recoEl) {
    recoBox.style.display = r.recommendation ? '' : 'none';
    recoBox.className = `reco-box ${level}`;
    recoEl.textContent = r.recommendation || '';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ──────────────────────────────────────────────────────────────
//  PDF REPORT EXPORT
// ──────────────────────────────────────────────────────────────
// Draws a light, print-friendly A4 document with jsPDF's vector API rather
// than screenshotting the dark UI, so the text stays selectable and the file
// stays small. Layout units are millimetres.

let lastReport = null;

const PDF = {
  W: 210, H: 297, M: 18, CW: 174,
  INK:   [23, 23, 26],
  MUTED: [107, 107, 117],
  HAIR:  [227, 227, 232],
  SOFT:  [247, 247, 249],
  // Print-safe version of the on-screen red-to-green ramp.
  RAMP: [[220, 38, 38], [234, 88, 12], [202, 138, 4], [101, 163, 13], [22, 163, 74]]
};

// jsPDF's built-in fonts only cover Latin-1, so glyphs the app uses in tags and
// input previews (check marks, warning signs, the image emoji) would render as
// blanks. Transliterate what has an equivalent and drop the rest.
function pdfSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[\u00A0\u202F\u2009\u200A]/g, ' ')
    .replace(/[\u2713\u2714]/g, '')
    .replace(/[\u2715\u2717\u2718]/g, 'x')
    .replace(/\u26A0\uFE0F?/g, '!')
    .replace(/[\u2690\u2691]/g, '')
    .replace(/[\u2190-\u21FF]/g, '')
    .replace(/\u2026/g, '...')
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\x20-\xFF\n]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function pdfVerdictColor(verdict, score) {
  if (verdict === 'credible') return [22, 163, 74];
  if (verdict === 'uncertain') return [202, 138, 4];
  if (verdict) return [220, 38, 38];
  return score >= 70 ? [22, 163, 74] : score >= 45 ? [202, 138, 4] : [220, 38, 38];
}

// Blend a colour toward white. 0 = untouched, 1 = white.
function pdfTint(c, amount) {
  return c.map(v => Math.round(v + (255 - v) * amount));
}

async function downloadReport(btn) {
  const lib = window.jspdf && window.jspdf.jsPDF;
  if (!lib) {
    if (btn) flashButton(btn, 'Export unavailable', '↓ Download report');
    console.warn('[report] jsPDF failed to load');
    return;
  }
  const r = lastReport;
  if (!r) {
    if (btn) flashButton(btn, 'No report yet', '↓ Download report');
    return;
  }

  const original = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }

  try {
    const doc = new lib({ unit: 'mm', format: 'a4' });
    const M = PDF.M, CW = PDF.CW;
    const accent = pdfVerdictColor(r.verdict, r.score);
    let y = 0;

    const lh = size => size * 0.48;
    const ensure = h => {
      if (y + h > PDF.H - 24) { doc.addPage(); y = 20; }
    };
    const setText = (size, weight, color) => {
      doc.setFont('helvetica', weight);
      doc.setFontSize(size);
      doc.setTextColor(color[0], color[1], color[2]);
    };
    const para = (txt, size, color, gapAfter) => {
      setText(size, 'normal', color);
      doc.splitTextToSize(pdfSafe(txt), CW).forEach(line => {
        ensure(lh(size));
        doc.text(line, M, y);
        y += lh(size);
      });
      y += gapAfter || 0;
    };
    const heading = txt => {
      ensure(16);
      y += 3;
      setText(8.5, 'bold', PDF.MUTED);
      doc.text(pdfSafe(txt).toUpperCase(), M, y);
      y += 2.2;
      doc.setDrawColor(PDF.HAIR[0], PDF.HAIR[1], PDF.HAIR[2]);
      doc.setLineWidth(0.2);
      doc.line(M, y, M + CW, y);
      y += 6;
    };
    // Full-width gradient track clipped to the value, mirroring the app.
    const gradientBar = (x, top, w, h, pct) => {
      const v = clampPct(pct);
      doc.setFillColor(234, 234, 239);
      doc.roundedRect(x, top, w, h, h / 2, h / 2, 'F');
      const filled = w * v / 100;
      if (filled <= 0) return;
      const step = 0.5;
      for (let px = 0; px < filled; px += step) {
        const t = Math.min(px / w, 1) * (PDF.RAMP.length - 1);
        const i = Math.min(Math.floor(t), PDF.RAMP.length - 2);
        const f = t - i;
        const c = PDF.RAMP[i].map((cv, k) => Math.round(cv + (PDF.RAMP[i + 1][k] - cv) * f));
        doc.setFillColor(c[0], c[1], c[2]);
        doc.rect(x + px, top, Math.min(step + 0.12, filled - px), h, 'F');
      }
    };

    // ── Header ────────────────────────────────────────────────
    y = 22;
    setText(21, 'bold', PDF.INK);
    doc.text('Credify', M, y);
    setText(9, 'normal', PDF.MUTED);
    doc.text('Credibility report', M + CW, y - 3.5, { align: 'right' });
    doc.text(pdfSafe(new Date().toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })),
             M + CW, y + 0.5, { align: 'right' });
    y += 4;
    doc.setDrawColor(PDF.HAIR[0], PDF.HAIR[1], PDF.HAIR[2]);
    doc.setLineWidth(0.3);
    doc.line(M, y, M + CW, y);
    y += 10;

    // ── Score panel ───────────────────────────────────────────
    const panelTop = y;
    const descLines = doc.splitTextToSize(pdfSafe(r.desc), CW - 62);
    const panelH = Math.max(30, 18 + descLines.length * lh(9.5));
    doc.setFillColor(PDF.SOFT[0], PDF.SOFT[1], PDF.SOFT[2]);
    doc.roundedRect(M, panelTop, CW, panelH, 3, 3, 'F');
    doc.setFillColor(accent[0], accent[1], accent[2]);
    doc.rect(M, panelTop, 1.6, panelH, 'F');

    setText(32, 'bold', accent);
    doc.text(String(r.score != null ? r.score : '—'), M + 10, panelTop + panelH / 2 + 4);
    const scoreW = doc.getTextWidth(String(r.score != null ? r.score : '—'));
    setText(11, 'normal', PDF.MUTED);
    doc.text('/100', M + 11 + scoreW, panelTop + panelH / 2 + 4);

    const tx = M + 52;
    setText(13, 'bold', PDF.INK);
    doc.text(pdfSafe(r.label), tx, panelTop + 12);
    setText(9.5, 'normal', PDF.MUTED);
    descLines.forEach((line, i) => doc.text(line, tx, panelTop + 18 + i * lh(9.5)));
    y = panelTop + panelH + 4;

    // ── Tags ──────────────────────────────────────────────────
    if ((r.tags || []).length) {
      let tagX = M;
      setText(8.5, 'normal', PDF.INK);
      (r.tags || []).forEach(t => {
        const label = pdfSafe(t.text);
        if (!label) return;
        const w = doc.getTextWidth(label) + 7;
        if (tagX + w > M + CW) { tagX = M; y += 7; }
        const base = t.kind === 'green' ? [22, 163, 74]
                   : t.kind === 'yellow' ? [202, 138, 4]
                   : t.kind === 'red' ? [220, 38, 38]
                   : PDF.MUTED;
        const bg = pdfTint(base, 0.88);
        doc.setFillColor(bg[0], bg[1], bg[2]);
        doc.roundedRect(tagX, y, w, 5.6, 2.8, 2.8, 'F');
        doc.setTextColor(base[0], base[1], base[2]);
        doc.text(label, tagX + 3.5, y + 3.8);
        tagX += w + 3;
      });
      y += 10;
    } else {
      y += 3;
    }

    // ── Analysed input ────────────────────────────────────────
    heading('Analysed input');
    const preview = (currentReportMeta && currentReportMeta.preview) || '-';
    para(preview, 10, PDF.INK, 2);
    const meta = [];
    if (r.input_type) meta.push('Input type: ' + r.input_type);
    meta.push('Engine: ' + (r.engine === 'groq' ? 'Llama (Groq)'
                          : r.engine === 'gemini' ? 'Gemini'
                          : 'Signal-based analysis'));
    para(meta.join('   ·   '), 8.5, PDF.MUTED, 4);

    // ── Credibility breakdown ─────────────────────────────────
    heading('Credibility breakdown');
    ensure(14);
    setText(10, 'bold', PDF.INK);
    doc.text('Overall credibility', M, y);
    setText(10, 'bold', accent);
    doc.text(clampPct(r.score) + '%', M + CW, y, { align: 'right' });
    y += 2.5;
    gradientBar(M, y, CW, 3.4, r.score);
    y += 7;
    setText(8.5, 'normal', PDF.MUTED);
    doc.text('Assessment confidence: ' + (r.confidence != null ? r.confidence + '%' : '-'), M, y);
    y += 7;

    (r.breakdown || []).forEach(dim => {
      const v = clampPct(dim.value);
      ensure(9);
      setText(9.5, 'normal', PDF.INK);
      doc.text(doc.splitTextToSize(pdfSafe(dim.label), 50)[0], M, y + 1.8);
      gradientBar(M + 54, y, 100, 2.8, v);
      setText(9, 'normal', PDF.MUTED);
      doc.text(v + '%', M + CW, y + 1.8, { align: 'right' });
      y += 8;
    });
    y += 1;

    // ── Details ───────────────────────────────────────────────
    if ((r.details || []).length) {
      heading(r.input_type === 'Image' ? 'Image details'
            : r.input_type === 'Article' ? 'Source details' : 'Details');
      (r.details || []).forEach(d => {
        ensure(8);
        setText(9.5, 'normal', PDF.MUTED);
        doc.text(pdfSafe(d.label), M, y);
        setText(9.5, 'normal', PDF.INK);
        const value = doc.splitTextToSize(pdfSafe(d.value == null ? '-' : d.value) || '-', CW - 60);
        doc.text(value[0], M + CW, y, { align: 'right' });
        y += 3;
        doc.setDrawColor(PDF.HAIR[0], PDF.HAIR[1], PDF.HAIR[2]);
        doc.setLineWidth(0.15);
        doc.line(M, y, M + CW, y);
        y += 4.5;
      });
      y += 1;
    }

    // ── Key findings ──────────────────────────────────────────
    const findings = Array.isArray(r.key_findings) ? r.key_findings : [];
    if (findings.length) {
      heading('Key findings');
      findings.forEach(f => {
        const lines = doc.splitTextToSize(pdfSafe(f), CW - 6);
        ensure(lines.length * lh(9.5) + 2);
        doc.setFillColor(accent[0], accent[1], accent[2]);
        doc.circle(M + 1.2, y - 1.3, 0.9, 'F');
        setText(9.5, 'normal', PDF.INK);
        lines.forEach((line, i) => doc.text(line, M + 6, y + i * lh(9.5)));
        y += lines.length * lh(9.5) + 2;
      });
      y += 2;
    }

    // ── Analysis summary ──────────────────────────────────────
    if (r.summary) {
      heading('Analysis summary');
      para(r.summary, 10, PDF.INK, 3);
    }

    // ── Recommendation ────────────────────────────────────────
    if (r.recommendation) {
      heading('What you should do');
      const lines = doc.splitTextToSize(pdfSafe(r.recommendation), CW - 12);
      const boxH = lines.length * lh(10) + 9;
      ensure(boxH);
      const bg = pdfTint(accent, 0.90);
      doc.setFillColor(bg[0], bg[1], bg[2]);
      doc.roundedRect(M, y - 4, CW, boxH, 2.5, 2.5, 'F');
      setText(10, 'normal', PDF.INK);
      lines.forEach((line, i) => doc.text(line, M + 6, y + 2 + i * lh(10)));
      y += boxH;
    }

    // ── Footer on every page ──────────────────────────────────
    const pages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setDrawColor(PDF.HAIR[0], PDF.HAIR[1], PDF.HAIR[2]);
      doc.setLineWidth(0.2);
      doc.line(M, PDF.H - 17, M + CW, PDF.H - 17);
      setText(7.5, 'normal', PDF.MUTED);
      const note = doc.splitTextToSize(
        'Credify produces automated credibility estimates, not statements of fact. '
        + 'Verify independently before acting on this report.', CW - 26);
      note.forEach((line, i) => doc.text(line, M, PDF.H - 13 + i * 3));
      doc.text('Page ' + p + ' of ' + pages, M + CW, PDF.H - 13, { align: 'right' });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    doc.save('credify-report-' + (r.verdict || 'result') + '-' + stamp + '.pdf');
  } catch (err) {
    console.error('[report] export failed', err);
    if (btn) flashButton(btn, 'Export failed', original);
    return;
  } finally {
    if (btn && btn.textContent === 'Preparing…') {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}

// Briefly show a message on a button, then restore its label.
function flashButton(btn, message, restoreTo) {
  const back = restoreTo || btn.textContent;
  btn.disabled = true;
  btn.textContent = message;
  setTimeout(() => { btn.textContent = back; btn.disabled = false; }, 2000);
}

// ── Local fallback scorer (mirrors the backend heuristic) ──────
// Runs entirely in the browser when the FastAPI backend isn't reachable, so
// the scan always returns a real, input-dependent result. Accepts the same
// payload object runScan sends: { input, image?, filename? }.
function heuristicScanJS(payload) {
  const clamp = n => Math.max(0, Math.min(100, Math.round(n)));
  const text = (payload && payload.input || '').trim();
  const hasImage = !!(payload && payload.image);
  const filename = (payload && payload.filename) || '';

  const KNOWN_FALSE = [
    [/\beinstein\b.*\bmoon\b|\bmoon\b.*\beinstein\b/i, 'Historically impossible — Einstein died in 1955, before any Moon landing'],
    [/\bflat\s+earth\b/i, 'Contradicts established science'],
    [/vaccines?\s+cause\s+autism/i, 'Debunked medical claim'],
    [/5\s?g\b.*(covid|corona)/i, 'Debunked conspiracy theory'],
    [/(covid|corona).*\bhoax\b/i, 'Debunked conspiracy theory'],
    [/climate\s+change.*\bhoax\b/i, 'Contradicts scientific consensus'],
    [/\bmoon\s+landing\b.*\b(fake|hoax|staged)\b/i, 'Debunked conspiracy theory'],
  ];
  const matchFalse = s => { for (const [re, why] of KNOWN_FALSE) if (re.test(s || '')) return why; return null; };

  const verdictOf = score => score >= 70
    ? { verdict: 'credible', label: 'Not fake news — high confidence', desc: "We're confident this is NOT fake news. It shows strong sourcing and is consistent with known facts." }
    : score >= 45
    ? { verdict: 'uncertain', label: 'Unsure — verify before sharing', desc: 'The signals are mixed. Treat this with caution and verify with trusted sources before believing or sharing it.' }
    : { verdict: 'not_credible', label: 'Likely fake news — high confidence', desc: 'Highly confident this is fake news or misleading — but double-check with a trusted fact-checker to be certain.' };

  // Anti-clustering: nudge suspiciously round scores by a deterministic,
  // input-derived offset (mirrors the backend's spread()). Band-safe.
  const spreadScore = (score, seed) => {
    let s = clamp(score);
    if (s % 5 !== 0) return s;
    let h = 0;
    const str = seed || 'x';
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
    let n = s + (Math.abs(h) % 9) - 4; // -4 .. +4
    if (s >= 70) n = Math.max(70, n);
    else if (s >= 45) n = Math.min(69, Math.max(45, n));
    else n = Math.min(44, n);
    return clamp(n);
  };

  const recoOf = score => score >= 70
    ? 'This looks safe to trust and share, but no automated check is perfect — for high-stakes decisions, confirm directly with the original source.'
    : score >= 45
    ? 'Hold off on sharing this. Search the claim on VERA Files, Rappler Fact Check, or Google Fact Check Explorer first, and treat it as unverified until confirmed.'
    : "Do not share this content. If you've seen it circulating, check it against trusted fact-checkers — and consider reporting the post where you found it.";

  const assemble = (score, confidence, inputType, breakdown, details, tags, summary, keyFindings) => {
    const v = verdictOf(score);
    const full = [
      { label: 'Input type', value: inputType },
      { label: 'Assessment confidence', value: clamp(confidence) + '%' },
    ].concat(details);
    return { score: clamp(score), confidence: clamp(confidence), input_type: inputType,
             verdict: v.verdict, label: v.label, desc: v.desc,
             breakdown, details: full, tags, summary,
             key_findings: keyFindings || [], recommendation: recoOf(score),
             engine: 'heuristic' };
  };

  // ---- IMAGE ----
  if (hasImage) {
    const hay = (filename + ' ' + text).toLowerCase();
    const AI_HINTS = ['ai-generated', 'aigenerated', 'aigen', 'midjourney', 'dalle', 'dall-e',
      'stable-diffusion', 'stablediffusion', 'sora', 'deepfake', 'synthetic', 'generated'];
    const aiHit = AI_HINTS.some(h => hay.includes(h));
    const knownFalse = matchFalse(text) || matchFalse(filename);
    let score, confidence, auth, plaus, consist, prov, summary, tags;
    if (aiHit || knownFalse) {
      score = 10; confidence = 75; auth = 8; plaus = knownFalse ? 10 : 25; consist = 20; prov = 15;
      summary = 'Signals indicate this image is likely AI-generated or fabricated'
        + (knownFalse ? ' — ' + knownFalse + '.' : ' (based on its filename/caption).')
        + ' Enable the Groq vision engine (set GROQ_API_KEY) for a full pixel-level analysis.';
      tags = [{ text: '🖼️ Image', kind: 'gray' }, { text: '✗ Likely AI-generated / fabricated', kind: 'red' }];
    } else {
      score = 45; confidence = 20; auth = 45; plaus = 50; consist = 45; prov = 30;
      summary = "Image authenticity can't be verified without the AI vision engine. "
        + 'Enable Groq (set GROQ_API_KEY) so Credify can inspect the pixels for AI-generation, '
        + 'manipulation, and scene plausibility. Until then this is an unverified estimate, not a confirmation.';
      tags = [{ text: '🖼️ Image', kind: 'gray' }, { text: '⚠ Not verified (AI engine off)', kind: 'yellow' }];
    }
    const breakdown = [
      { label: 'Authenticity', value: auth },
      { label: 'Scene plausibility', value: plaus },
      { label: 'Visual consistency', value: consist },
      { label: 'Provenance', value: prov },
    ];
    const details = [];
    if (filename) details.push({ label: 'File', value: filename });
    if (text) details.push({ label: 'Caption', value: text.slice(0, 80) });
    const seed = filename + '|' + text;
    score = spreadScore(score, seed);
    breakdown.forEach(d => { d.value = spreadScore(d.value, seed + '::' + d.label); });
    const findings = (aiHit || knownFalse) ? [
      'The filename or caption itself signals AI generation or fabrication',
      knownFalse ? ('Matches a known debunked claim: ' + knownFalse) : 'Provenance cannot be established for this image',
      'Pixel-level inspection was NOT performed (AI vision engine is off)',
    ] : [
      'No AI-generation hints in the filename or caption',
      'Pixel-level inspection was NOT performed (AI vision engine is off)',
      'Authenticity, manipulation, and scene plausibility remain unverified',
    ];
    return assemble(score, confidence, 'Image', breakdown, details, tags, summary, findings);
  }

  // ---- ARTICLE / TEXT ----
  const isUrl = /^https?:\/\/\S+$/i.test(text) ||
                (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text) && !/\s/.test(text));
  const CREDIBLE = {
    'abs-cbn.com': ['ABS-CBN News', 'Center-left'], 'gmanetwork.com': ['GMA News', 'Center'],
    'rappler.com': ['Rappler', 'Center-left'], 'inquirer.net': ['Inquirer', 'Center'],
    'philstar.com': ['Philippine Star', 'Center'], 'reuters.com': ['Reuters', 'Center'],
    'apnews.com': ['Associated Press', 'Center'], 'bbc.com': ['BBC', 'Center'],
    'nytimes.com': ['New York Times', 'Center-left'], 'verafiles.org': ['VERA Files', 'Center'],
  };
  const SATIRE = {
    'theonion.com': ['The Onion (satire)', 'Satire'],
    'adobo-chronicles.com': ['Adobo Chronicles (satire)', 'Satire'],
    'babylonbee.com': ['The Babylon Bee (satire)', 'Satire'],
  };
  const CLICKBAIT = [/you won'?t believe/i, /shocking/i, /doctors hate/i, /miracle (cure|drug|remedy)/i,
    /share (this )?before/i, /gone viral/i, /will blow your mind/i, /the truth about/i, /exposed!?/i, /one weird trick/i];
  const SENSATIONAL = ['hoax', 'coverup', 'cover-up', 'conspiracy', 'plandemic', 'microchip', 'sheeple', 'wake up', 'false flag'];
  const ATTRIB = ['according to', 'said', 'reported', 'study', 'research', 'data', 'official', 'confirmed', 'cited', 'statement'];

  const lower = text.toLowerCase();
  const words = (text.match(/[A-Za-z']+/g) || []);
  const wc = Math.max(1, words.length);
  const knownFalse = matchFalse(text);

  let domain = '', publisher = 'No source provided', bias = 'Unknown', domainAge = '—';
  if (isUrl) {
    try { domain = new URL(text.startsWith('http') ? text : 'https://' + text).hostname.replace(/^www\./, '').toLowerCase(); }
    catch (e) { domain = text.split('/')[0].replace(/^www\./, '').toLowerCase(); }
  }

  let source;
  if (CREDIBLE[domain]) { source = 92; [publisher, bias] = CREDIBLE[domain]; domainAge = 'Established outlet'; }
  else if (SATIRE[domain]) { source = 12; [publisher, bias] = SATIRE[domain]; domainAge = 'Satire / flagged'; }
  else if (domain) {
    source = 50; publisher = domain;
    if (/blogspot\.|wordpress\.com|medium\.com|\.tumblr\.com|facebook\.com|t\.me|tiktok\.com/.test(domain)) { source -= 18; publisher = domain + ' (self-published)'; }
    if (!/^https/i.test(text)) source -= 6;
    if ((domain.match(/[-0-9]/g) || []).length >= 4) source -= 8;
    if (['gov', 'edu', 'int'].includes(domain.split('.').pop())) source += 15;
  } else { source = 42; }

  let factual = 62;
  const clickHits = CLICKBAIT.filter(re => re.test(lower)).length;
  const sensHits = SENSATIONAL.filter(w => lower.includes(w)).length;
  factual -= clickHits * 12 + sensHits * 10;
  const capsRatio = words.filter(w => w.length >= 3 && w === w.toUpperCase()).length / wc;
  if (capsRatio > 0.12) factual -= 16; else if (capsRatio > 0.05) factual -= 7;
  const exclaims = (text.match(/!/g) || []).length;
  if (exclaims >= 4) factual -= 12; else if (exclaims >= 2) factual -= 5;
  if (knownFalse) factual = Math.min(factual, 8);

  let neutral = 76 - sensHits * 10 - clickHits * 6;
  if (capsRatio > 0.08) neutral -= 12;

  let verify = 40;
  const attrHits = ATTRIB.filter(a => lower.includes(a)).length;
  verify += Math.min(attrHits * 8, 32);
  if (isUrl || /https?:\/\//.test(text)) verify += 8;
  if (wc < 12 && !isUrl) verify -= 10;
  if (CREDIBLE[domain]) verify += 16;

  source = clamp(source); factual = clamp(factual); neutral = clamp(neutral); verify = clamp(verify);
  let score = isUrl
    ? 0.38 * source + 0.30 * factual + 0.14 * neutral + 0.18 * verify
    : 0.22 * source + 0.46 * factual + 0.14 * neutral + 0.18 * verify;
  if (SATIRE[domain]) score = Math.min(score, 28);
  if (knownFalse) score = Math.min(score, 12);
  score = clamp(score);

  let confidence = 45;
  if (CREDIBLE[domain] || SATIRE[domain]) confidence += 30;
  if (knownFalse) confidence = 88;
  if (clickHits || sensHits) confidence += 12;
  if (!domain && wc < 10) confidence -= 15;
  confidence = clamp(confidence);

  const breakdown = isUrl ? [
    { label: 'Source reliability', value: source },
    { label: 'Factual accuracy', value: factual },
    { label: 'Neutrality', value: neutral },
    { label: 'Transparency', value: verify },
  ] : [
    { label: 'Factual plausibility', value: factual },
    { label: 'Attribution', value: verify },
    { label: 'Neutrality', value: neutral },
    { label: 'Source reliability', value: source },
  ];

  const details = [{ label: 'Publisher', value: publisher }];
  if (isUrl) details.push({ label: 'Domain', value: domain || '—' }, { label: 'Bias', value: bias });

  const tags = [{ text: isUrl ? '🔗 Article' : '📝 Text claim', kind: 'gray' }];
  if (source >= 80) tags.push({ text: '✓ Reputable source', kind: 'green' });
  else if (source < 35 && domain) tags.push({ text: '✗ Unverified source', kind: 'red' });
  if (knownFalse) tags.push({ text: '✗ Matches known false claim', kind: 'red' });
  if (clickHits) tags.push({ text: '⚠ Clickbait language', kind: 'yellow' });
  if (sensHits) tags.push({ text: '⚠ Sensational wording', kind: 'yellow' });
  if (bias === 'Satire') tags.push({ text: '✗ Satire / parody', kind: 'red' });

  const bits = [];
  bits.push('Credify analyzed ' + (isUrl ? 'the linked article' : 'the submitted text claim')
    + (publisher && publisher !== 'No source provided' ? ' from ' + publisher : '') + '.');
  if (knownFalse) {
    bits.push('It matches a known false or debunked claim: ' + knownFalse
      + '. That alone caps the score in the lowest band, because repeating an already-debunked claim is one of the clearest markers of misinformation.');
  } else if (score >= 70) {
    bits.push('The strongest signals in its favor: a recognizable source, attribution cues, and language that stays largely neutral rather than emotional.');
    bits.push('No debunked claims, clickbait framing, or sensational trigger words were detected.');
  } else if (score >= 45) {
    bits.push('Nothing here confirms or debunks the content outright. Some signals point each way, which is why it lands in the middle band rather than a confident verdict.');
    bits.push(attrHits ? 'It does include some attribution, which helps, but not enough to verify the claims independently.'
                       : 'It makes assertions without citing sources, officials, or data that could be independently checked.');
  } else {
    bits.push('Multiple warning signs typical of low-quality or misleading content were found, and they outweigh any positive signals.');
  }
  if (clickHits) bits.push('The wording uses ' + clickHits + ' clickbait-style pattern(s) — phrasing engineered for shares rather than accuracy.');
  if (sensHits) bits.push(sensHits + ' sensational or conspiratorial term(s) appear, which credible reporting tends to avoid.');
  if (verify < 45 && !knownFalse) bits.push("Little sourcing or attribution was detected, so the claims can't be traced back to anyone accountable.");
  if (confidence < 45) bits.push('Confidence is low because there was little material to analyze — treat the score as a rough signal, not a ruling.');
  bits.push('This is an automated, signal-based estimate; for anything important, cross-check with trusted fact-checkers such as VERA Files or FactCheck.org.');

  const seed = text;
  score = spreadScore(score, seed);
  confidence = spreadScore(confidence, seed + '::conf');
  breakdown.forEach(d => { d.value = spreadScore(d.value, seed + '::' + d.label); });

  const findings = ['Source: ' + publisher];
  if (knownFalse) findings.push('Matches a known debunked claim: ' + knownFalse);
  findings.push(attrHits
    ? attrHits + ' attribution cue(s) found — quotes, officials, studies, or data'
    : 'No attribution detected — nothing traces the claims to an accountable source');
  if (clickHits) findings.push(clickHits + ' clickbait-style phrase(s) in the wording');
  if (sensHits) findings.push(sensHits + ' sensational or conspiratorial term(s) used');
  if (isUrl && !(clickHits || sensHits || knownFalse)) findings.push('Language stays largely neutral, with no emotional-manipulation patterns');

  return assemble(score, confidence, isUrl ? 'Article' : 'Text claim', breakdown, details, tags, bits.join(' '), findings.slice(0, 6));
}

// ── File attachment ────────────────────────────────────────────

function triggerFileUpload(inputId = 'file-upload', previewId = 'attachments-preview') {
  const input = document.getElementById(inputId);
  if (input) {
    // Store which preview container to use
    input._previewId = previewId;
    input.click();
  }
}

function handleFileUpload(input, previewId) {
  // Support being called with just the input element (onchange handler)
  const resolvedPreviewId = previewId || input._previewId || 'attachments-preview';
  const preview = document.getElementById(resolvedPreviewId);
  if (!preview || !input.files) return;

  Array.from(input.files).forEach(file => {
    addAttachmentChip(file, preview);
  });

  // Reset so the same file can be re-selected
  input.value = '';
}

function addAttachmentChip(file, container) {
  const isImage = file.type.startsWith('image/');
  const isPDF = file.type === 'application/pdf';

  const chip = document.createElement('div');
  chip.className = 'attachment-chip';

  const icon = isImage
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
    : isPDF
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

  const name = document.createElement('span');
  name.className = 'attachment-chip-name';
  name.textContent = file.name;
  name.title = file.name;

  const remove = document.createElement('button');
  remove.className = 'attachment-remove';
  remove.innerHTML = '×';
  remove.title = 'Remove';
  remove.onclick = () => {
    chip.remove();
    if (scanAttachment === file) scanAttachment = null;
  };

  chip.innerHTML = icon;
  chip.appendChild(name);
  chip.appendChild(remove);
  container.appendChild(chip);

  // Remember the most recent image so runScan can actually analyze it.
  if (isImage) scanAttachment = file;
}

// ── Handle paste events for URLs / images ──────────────────────
document.addEventListener('paste', function (e) {
  const active = document.querySelector('.screen.active');
  if (!active) return;

  const textarea = active.querySelector('.composer-textarea');
  if (!textarea) return;

  // If an image is on the clipboard, treat it as a file attachment
  const items = e.clipboardData && e.clipboardData.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          // Find the matching preview container for this textarea
          const previewId = textarea.id === 'auth-textarea'
            ? 'auth-attachments-preview'
            : 'attachments-preview';
          const preview = document.getElementById(previewId);
          if (preview) addAttachmentChip(file, preview);
        }
      }
    }
  }
});

// ── Password utilities ─────────────────────────────────────────

function togglePass(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isText = input.type === 'text';
  input.type = isText ? 'password' : 'text';
  // Swap eye icon
  btn.innerHTML = isText
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
}

// function checkStrength(value) {
//   const fill = document.getElementById('strength-fill');
//   const label = document.getElementById('strength-label');
//   if (!fill || !label) return;

//   let score = 0;
//   if (value.length >= 8) score++;
//   if (/[A-Z]/.test(value)) score++;
//   if (/[0-9]/.test(value)) score++;
//   if (/[^A-Za-z0-9]/.test(value)) score++;

//   const levels = [
//     { pct: '0%',   color: 'transparent', text: '' },
//     { pct: '25%',  color: '#F87171',     text: 'Weak' },
//     { pct: '50%',  color: '#FACC15',     text: 'Fair' },
//     { pct: '75%',  color: '#A78BFA',     text: 'Good' },
//     { pct: '100%', color: '#4ADE80',     text: 'Strong' },
//   ];

//   const lvl = levels[score];
//   fill.style.width = lvl.pct;
//   fill.style.background = lvl.color;
//   label.textContent = lvl.text;
//   label.style.color = lvl.color;
// }

function checkStrengthFor(value, fillId, labelId) {
  const fill = document.getElementById(fillId);
  const label = document.getElementById(labelId);
  if (!fill || !label) return;

  let score = 0;
  if (value.length >= 8) score++;
  if (/[A-Z]/.test(value)) score++;
  if (/[0-9]/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;

  const levels = [
    { pct: '0%',   color: 'transparent', text: '' },
    { pct: '25%',  color: '#F87171',     text: 'Weak' },
    { pct: '50%',  color: '#FACC15',     text: 'Fair' },
    { pct: '75%',  color: '#A78BFA',     text: 'Good' },
    { pct: '100%', color: '#4ADE80',     text: 'Strong' },
  ];

  const lvl = levels[score];
  fill.style.width = lvl.pct;
  fill.style.background = lvl.color;
  label.textContent = lvl.text;
  label.style.color = lvl.color;
}

// ── Update avatar/profile UI after login ───────────────────────
// Show the user's initial when logged in, a neutral icon for guests.
// (The HTML used to hardcode a placeholder "V", which showed up even in
//  guest sessions — e.g. on the Analyzing screen.)
function refreshAvatars() {
  if (Auth.isLoggedIn()) {
    const email = Auth.user?.email || 'U';
    updateAvatar(email);
  } else {
    document.querySelectorAll('.avatar, .profile-avatar').forEach(el => { el.textContent = '👤'; });
    document.querySelectorAll('.profile-name').forEach(el => { el.textContent = 'Guest'; });
    document.querySelectorAll('.profile-email').forEach(el => { el.textContent = 'Not signed in'; });
  }
}

function updateAvatar(email) {
  const initial = email.charAt(0).toUpperCase();
  const name = Auth.user?.user_metadata?.account_name || email;

  document.querySelectorAll('.avatar').forEach(el => el.innerHTML = initial);
  document.querySelectorAll('.profile-avatar').forEach(el => el.innerHTML = initial);
  document.querySelectorAll('.profile-name').forEach(el => el.innerHTML = name);
  document.querySelectorAll('.profile-email').forEach(el => el.innerHTML = email);
}

// ── History screen filter ──────────────────────────────────────
let historyFilter = 'all';

function setHistoryFilter(el) {
  document.querySelectorAll('#screen-history .filter-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  historyFilter = el.dataset.verdict;
  renderHistoryList();
}

function renderHistoryList() {
  const list = document.getElementById('history-list');
  if (!list) return;

  if (!Auth.isLoggedIn()) {
    list.innerHTML = '<div class="rs-empty">Sign in to see your verification history.</div>';
    return;
  }

  const filtered = historyFilter === 'all'
    ? reportsCache
    : reportsCache.filter(r => r.verdict === historyFilter);

  if (!filtered.length) {
    const msg = historyFilter === 'all'
      ? 'No saved reports yet. Run a check and it will appear here.'
      : 'No reports matching this filter.';
    list.innerHTML = `<div class="rs-empty">${msg}</div>`;
    return;
  }

  let html = '', lastDay = '';
  filtered.forEach(r => {
    const day = reportDayLabel(r.created_at);
    if (day !== lastDay) {
      html += `<div class="hist-day">${escapeHtml(day)}</div>`;
      lastDay = day;
    }
    const cls = r.score >= 70 ? 'green' : r.score >= 45 ? 'yellow' : 'red';
    const time = new Date(r.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    html +=
      `<div class="hist-item" onclick="openSavedReport('${r.id}')">` +
        `<div class="hist-badge ${cls}">${r.score}</div>` +
        `<div class="hist-info">` +
          `<div class="hist-url">${escapeHtml(r.input_preview || 'Untitled')}</div>` +
          `<div class="hist-date">${escapeHtml(time)} · ${escapeHtml(r.input_type || 'Scan')} · ${escapeHtml(r.verdict || '')}</div>` +
        `</div>` +
        `<span class="hist-arrow">›</span>` +
      `</div>`;
  });
  list.innerHTML = html;
}

// authentication

async function getToken() {
  const { data } = await sbClient.auth.getSession();
  return data?.session?.access_token || Auth.token;
}
// ── Auth state — kept in memory ────────────────────────────────
// Stores the logged-in user's token and info after login
// ── Auth state ─────────────────────────────────────────────────
const Auth = {
  token: null,
  user: null,
  isLoggedIn() { return !!this.token; }
};

// Pending flows (kept in memory between screens)
let pendingSignup = null;  // { email, password } awaiting OTP verification
let resetEmail = '';       // email awaiting password-reset OTP

// ── CAPTCHA (Cloudflare Turnstile) ─────────────────────────────
// The site key should live in config.js (like SUPABASE_URL). If it's not
// defined we fall back to Cloudflare's public TEST key, which renders a
// widget that always passes — handy for local dev before Turnstile is
// configured. Replace with your real key + enable in Supabase for prod.
const TURNSTILE_KEY = (typeof TURNSTILE_SITE_KEY !== 'undefined')
  ? TURNSTILE_SITE_KEY
  : '1x00000000000000000000AA'; // test key: always passes



function renderCaptchas() {
  // Turnstile loads async; retry until it's available.
  if (!window.turnstile) { setTimeout(renderCaptchas, 250); return; }
  ['captcha-login', 'captcha-register', 'captcha-otp', 'captcha-forgot', 'captcha-reset']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el && !(id in captchaWidgets)) {
        captchaWidgets[id] = turnstile.render(el, {
          sitekey: TURNSTILE_KEY,
          theme: 'dark',
        });
      }
    });
  // The widget's iframe appears a beat after render(); fit once it's there.
  fitCaptchas();
  setTimeout(fitCaptchas, 400);
}
renderCaptchas();

// Scale each widget so it exactly fills its container width — full-width on
// desktop (matching the inputs) and shrunk to fit on narrow screens so it
// never overflows the card. Turnstile's natural size is 300 x 65.
function fitCaptchas() {
  document.querySelectorAll('.captcha-box').forEach(box => {
    const inner = box.querySelector('.captcha-inner');
    if (!inner) return;
    const avail = box.clientWidth;
    if (!avail) return;
    const scale = avail / 300;
    inner.style.transform = `scale(${scale})`;
    box.style.height = `${65 * scale}px`; // collapse the gap left by scaling
  });
}

// Re-fit on resize / orientation change.
window.addEventListener('resize', fitCaptchas);

function getCaptchaToken(id) {
  const w = captchaWidgets[id];
  if (w === undefined || !window.turnstile) return '';
  return turnstile.getResponse(w) || '';
}

// Turnstile tokens are single-use: reset the widget after every auth
// attempt (success OR failure) so the user can try again.
function resetCaptcha(id) {
  const w = captchaWidgets[id];
  if (w !== undefined && window.turnstile) turnstile.reset(w);
}

// ── Terms of Service modal ─────────────────────────────────────
function openTosModal(tab = 'tos') {
  switchTosTab(tab);
  document.getElementById('tos-modal').classList.add('open');
}

function closeTosModal() {
  document.getElementById('tos-modal').classList.remove('open');
}

function switchTosTab(tab) {
  const showPrivacy = tab === 'privacy';
  document.getElementById('tos-content').style.display     = showPrivacy ? 'none' : 'block';
  document.getElementById('privacy-content').style.display = showPrivacy ? 'block' : 'none';
  document.getElementById('tab-tos').classList.toggle('active', !showPrivacy);
  document.getElementById('tab-privacy').classList.toggle('active', showPrivacy);
}

// "I agree" inside the modal ticks the checkbox and closes the modal.
function agreeTosFromModal() {
  const box = document.getElementById('tos-agree');
  if (box) box.checked = true;
  clearError('register-error');
  closeTosModal();
}

// ── Google sign-in (OAuth via Supabase) ────────────────────────
// Redirects to Google, then back to this page; the session is picked up
// by onAuthStateChange below. Requires the Google provider to be enabled
// in Supabase and the page to be served over http(s) — not file://.
async function handleGoogleSignIn(fromRegister = false) {
  const errId = fromRegister ? 'register-error' : 'login-error';
  clearError(errId);

  // Signing UP with Google still requires agreeing to the TOS first.
  if (fromRegister) {
    const agree = document.getElementById('tos-agree');
    if (agree && !agree.checked) {
      showError(errId, 'Please agree to the Terms of Service and Privacy Policy to continue.');
      return;
    }
  }

  if (window.location.protocol === 'file:') {
    showError(errId, 'Google sign-in needs the site served over http — open it with Live Server (or any local server), not as a file.');
    return;
  }

  try {
    const { error } = await sbClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) showError(errId, error.message);
    // On success the browser navigates away to Google — nothing more to do here.
  } catch (e) {
    showError(errId, 'Could not start Google sign-in. Is the Google provider enabled in Supabase?');
  }
}

// ── Session handling (restores logins, catches OAuth redirects) ─
function applySession(session) {
  if (!session) return;
  Auth.token = session.access_token;
  Auth.user  = session.user;
  updateAvatar(session.user.email);
  loadReports();
  checkAdminRole();
  // If we're on a public screen (fresh load, or just back from Google),
  // move into the app.
  const active = document.querySelector('.screen.active');
  if (!active || ['screen-home', 'screen-login', 'screen-register', 'screen-otp'].includes(active.id)) {
    goto('screen-home-auth');
  }
}

// Show the Admin button only for accounts with the admin role.
// (The role itself is granted via `select make_admin('email')` in the
// Supabase SQL editor — it can never be self-assigned from the app,
// and RLS enforces the real security server-side regardless of the UI.)
async function checkAdminRole() {
  Auth.isAdmin = false;
  try {
    const session = await sbClient.auth.getSession();
    console.log("session for admin check:", session);
    
    const { data, error } = await sbClient.from('user_roles')
      .select('role').eq('user_id', Auth.user.id).maybeSingle();
    console.log("admin data:", data);
    console.log("admin error:", error);
    Auth.isAdmin = !!(data && data.role === 'admin');
  } catch (e) { }
  document.querySelectorAll('.nav-admin-btn')
    .forEach(b => { b.style.display = Auth.isAdmin ? '' : 'none'; });
}

sbClient.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session) applySession(session);
  if (event === 'SIGNED_OUT') {
    Auth.token = null;
    Auth.user  = null;
    Auth.isAdmin = false;
    document.querySelectorAll('.nav-admin-btn').forEach(b => { b.style.display = 'none'; });
    reportsCache = [];
    activeReportId = null;
    refreshAvatars();
    renderReportSidebar();
  }
});

// Restore an existing session on page load (also catches the OAuth
// redirect hash, which supabase-js parses automatically).
(async function restoreSession() {
  try {
    const { data } = await sbClient.auth.getSession();
    if (data && data.session) applySession(data.session);
  } catch (e) { /* not signed in — that's fine */ }
})();

// ── Reports (account-only saved scan history) ──────────────────
// Every scan a signed-in user runs is saved to the `reports` table in
// Supabase (protected by row-level security, so users only ever see their
// own). The results screen shows them in a left sidebar, grouped by day.
// Guests get a locked panel instead.
let reportsCache = [];
let activeReportId = null;

async function saveReport(payload, report) {
  if (!Auth.isLoggedIn() || !Auth.user) return; // guests: nothing saved
  const preview = payload && payload.filename
    ? '🖼️ ' + payload.filename
    : ((payload && payload.input) || '').slice(0, 140) || 'Untitled scan';
  try {
    const { data, error } = await sbClient.from('reports').insert({
      user_id: Auth.user.id,
      input_type: report.input_type || (payload && payload.image ? 'Image' : 'Text'),
      input_preview: preview,
      verdict: report.verdict || 'uncertain',
      score: (typeof report.score === 'number') ? report.score : 0,
      result: report
    }).select().single();
    if (error) { console.warn('[reports] save failed:', error.message); return; }
    activeReportId = data ? data.id : null;
    if (currentReportMeta && data) currentReportMeta.report_id = data.id;
    loadReports();
  } catch (e) {
    console.warn('[reports] save failed:', e);
  }
}

async function loadReports() {
  if (!Auth.isLoggedIn()) { renderReportSidebar(); return; }
  try {
    const { data, error } = await sbClient
      .from('reports')
      .select('id, created_at, input_type, input_preview, verdict, score, result')
      .order('created_at', { ascending: false })
      .limit(40);
    if (error) {
      console.warn('[reports] load failed:', error.message);
      reportsCache = [];
    } else {
      reportsCache = data || [];
    }
  } catch (e) {
    console.warn('[reports] load failed:', e);
    reportsCache = [];
  }
  renderReportSidebar();
  renderHistoryList();
}

// "Today" / "Yesterday" / "Jul 10" style labels for grouping by day.
function reportDayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const startOf = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

function renderReportSidebar() {
  const list  = document.getElementById('rs-list');
  const count = document.getElementById('rs-count');
  if (!list) return;

  // Guests: locked panel, no history.
  if (!Auth.isLoggedIn()) {
    if (count) count.textContent = '';
    list.innerHTML =
      '<div class="rs-locked">' +
        '<div class="rs-lock-icon">🔒</div>' +
        '<p>Report history is an account feature. Sign in and every report you run is saved here — scores and all — across days.</p>' +
        '<button class="btn-submit rs-signin" onclick="goto(\'screen-login\')">Sign in</button>' +
      '</div>';
    return;
  }

  if (count) count.textContent = reportsCache.length ? String(reportsCache.length) : '';

  if (!reportsCache.length) {
    list.innerHTML = '<div class="rs-empty">No saved reports yet.<br>Run a check and it will appear here.</div>';
    return;
  }

  let html = '', lastDay = '';
  reportsCache.forEach(r => {
    const day = reportDayLabel(r.created_at);
    if (day !== lastDay) {
      html += `<div class="rs-day">${escapeHtml(day)}</div>`;
      lastDay = day;
    }
    const cls  = r.score >= 70 ? 'green' : r.score >= 40 ? 'yellow' : 'red';
    const time = new Date(r.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    html +=
      `<div class="rs-item${r.id === activeReportId ? ' active' : ''}" onclick="openSavedReport('${r.id}')">` +
        `<span class="rs-badge ${cls}">${r.score}</span>` +
        `<span class="rs-meta">` +
          `<span class="rs-preview">${escapeHtml(r.input_preview || 'Untitled')}</span>` +
          `<span class="rs-sub">${escapeHtml(time)} · ${escapeHtml(r.input_type || 'Scan')}</span>` +
        `</span>` +
      `</div>`;
  });
  list.innerHTML = html;
}

// Clicking a saved report re-renders it into the results screen.
function openSavedReport(id) {
  const r = reportsCache.find(x => x.id === id);
  if (!r || !r.result) return;
  activeReportId = id;
  currentReportMeta = { preview: r.input_preview, score: r.score, verdict: r.verdict, report_id: r.id };
  renderResult(r.result);
  renderReportSidebar();
  goto('screen-result-high');
}

// Initial paint (locked panel for guests until a session is restored).
renderReportSidebar();

// ── Flag flow (the ⚑ button finally records something) ─────────
// What's currently on the results screen, so a flag can reference it.
let currentReportMeta = null;

function openFlagForm() {
  if (!Auth.isLoggedIn()) {
    goto('screen-login');
    showError('login-error', 'Sign in to flag a result — flags are tied to your account.');
    return;
  }
  const ctx = document.getElementById('flag-context');
  if (ctx) {
    if (currentReportMeta) {
      const cls = currentReportMeta.score >= 70 ? 'green' : currentReportMeta.score >= 45 ? 'yellow' : 'red';
      ctx.innerHTML =
        `<span class="rs-badge ${cls}">${currentReportMeta.score}</span>` +
        `<span class="flag-ctx-preview">${escapeHtml(currentReportMeta.preview || 'Current result')}</span>`;
      ctx.style.display = '';
    } else {
      ctx.style.display = 'none';
    }
  }
  const box = document.getElementById('flag-reason');
  if (box) box.value = '';
  clearError('flag-error');
  goto('screen-flag-form');
}

async function submitFlag() {
  const reason = (document.getElementById('flag-reason').value || '').trim();
  if (reason.length < 10) {
    showError('flag-error', 'Please describe the issue in a bit more detail (at least 10 characters).');
    return;
  }
  const btn = document.querySelector('#screen-flag-form .btn-submit');
  btn.textContent = 'Submitting…'; btn.disabled = true;
  try {
    const { error } = await sbClient.from('flags').insert({
      user_id: Auth.user.id,
      report_id: (currentReportMeta && currentReportMeta.report_id) || null,
      content_preview: (currentReportMeta && currentReportMeta.preview) || null,
      score: (currentReportMeta && typeof currentReportMeta.score === 'number') ? currentReportMeta.score : null,
      verdict: (currentReportMeta && currentReportMeta.verdict) || null,
      reason: reason,
      status: 'pending'
    });
    if (error) { showError('flag-error', error.message); return; }
    goto('screen-flag'); // the existing success screen — now it's telling the truth
  } catch (e) {
    showError('flag-error', 'Could not submit. Is Supabase reachable?');
  } finally {
    btn.textContent = 'Submit flag'; btn.disabled = false;
  }
}

// ── Public Trends page: load live rows from the trends table ───
// Falls back silently to the hardcoded cards if the table is empty
// or not created yet.
async function loadTrends() {
  try {
    const { data, error } = await sbClient.from('trends')
      .select('topic, flagged_count, pct')
      .order('flagged_count', { ascending: false });
    if (error || !data || !data.length) return;
    const grid = document.getElementById('trends-grid');
    if (!grid) return;
    const colorOf = p => p >= 80 ? '#F87171' : p >= 60 ? '#FACC15' : p >= 35 ? '#A78BFA' : '#4ADE80';
    grid.innerHTML = data.map(t =>
      `<div class="trend-card">` +
        `<div class="trend-topic">${escapeHtml(t.topic)}</div>` +
        `<div class="trend-count">${Number(t.flagged_count).toLocaleString()}</div>` +
        `<div class="trend-lbl">flagged articles</div>` +
        `<div class="trend-bar-row"><div class="trend-bar-track">` +
          `<div class="trend-bar-fill" style="width:${clampPct(t.pct)}%;background:${colorOf(t.pct)};"></div>` +
        `</div><span class="trend-pct">${clampPct(t.pct)}%</span></div>` +
      `</div>`).join('');
  } catch (e) { /* keep hardcoded fallback */ }
}
function clampPct(p) { return Math.max(0, Math.min(100, Number(p) || 0)); }
loadTrends();

// ── Guest guards ───────────────────────────────────────────────
// History and account settings require a real account. Guests are sent
// to the login screen with a short explanation.
function openHistory() {
  if (Auth.isLoggedIn()) {
    goto('screen-history');
  } else {
    goto('screen-login');
    showError('login-error', 'Please sign in to view your history.');
  }
}

function openProfile() {
  if (Auth.isLoggedIn()) {
    loadProfileStats();
    goto('screen-profile');
  } else {
    goto('screen-login');
    showError('login-error', 'Please sign in to access your account.');
  }
}

// Keep OTP inputs to 6 digits only.
function onlyDigits(el) {
  el.value = el.value.replace(/\D/g, '').slice(0, 6);
}

function showError(elementId, message) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = message;
}

function clearError(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = '';
}

// ── Register (step 1: send OTP) ────────────────────────────────
async function handleRegister() {
  const account_name = document.querySelector('#screen-register input[type="text"]').value.trim();
  const email        = document.querySelector('#screen-register input[type="email"]').value.trim();
  const password     = document.getElementById('reg-pass').value;
  const confirm      = document.getElementById('confirm-pass').value;

  clearError('register-error');

  // const captchaToken = turnstile.getResponse();
  // if (!captchaToken) {
  //   showError('register-error', 'Please complete the captcha.'); 
  //   return;
  // }

  if (!account_name || !email || !password) {
    showError('register-error', 'Please fill in all fields.'); return;
  }
  if (password !== confirm) {
    showError('register-error', 'Passwords do not match.'); return;
  }
  if (password.length < 6) {
    showError('register-error', 'Password must be at least 6 characters.'); return;
  }

  // Gate 1: must agree to the Terms of Service before anything is sent.
  if (!document.getElementById('tos-agree').checked) {
    showError('register-error', 'Please agree to the Terms of Service and Privacy Policy to continue.');
    return;
  }

  // Gate 2: captcha must be solved BEFORE the OTP email is triggered —
  // this protects the email-send endpoint from bots.
  const captchaToken = getCaptchaToken('captcha-register');
  if (!captchaToken) {
    showError('register-error', 'Please complete the captcha.');
    return;
  }

  const btn = document.querySelector('#screen-register .btn-submit');
  const orig = btn.innerHTML;
  btn.textContent = 'Sending code…';
  btn.disabled = true;


  try {
    // Creates the user (unconfirmed) and emails a 6-digit code.
    // The captcha token is verified server-side by Supabase before the
    // email is sent, so bots can't trigger sends by calling the API directly.
    const { data, error } = await sbClient.auth.signUp({
      email,
      password,
      options: { 
        data: { account_name },
        captchaToken 
      }
    });

    if (error) {
        if (error.message.toLowerCase().includes('already registered') || 
          error.message.toLowerCase().includes('already exists')) {
          
          // NOTE: we can't just call signUp again here to resend — the
          // captcha token was consumed by the first call. Send the user to
          // the OTP screen, where "Resend code" has its own captcha.
          pendingSignup = { email, password };
          document.getElementById('otp-target-email').textContent = email;
          document.getElementById('otp-code').value = '';
          clearError('otp-error');
          goto('screen-otp');
          showError('otp-error', 'Account exists but is unconfirmed. Solve the captcha below and tap "Resend code".');
          return;
        }
      showError('register-error', error.message); return;
    }

    // If email confirmations are OFF in Supabase, a session is returned right
    // away and there is no code to enter — just log the user in.
    if (data.session) {
      Auth.token = data.session.access_token;
      Auth.user  = data.user;
      updateAvatar(email);
      goto('screen-home-auth');
      return;
    }

    // Otherwise: move to the OTP screen to finish account creation.
    pendingSignup = { email, password };
    const target = document.getElementById('otp-target-email');
    if (target) target.textContent = email;
    document.getElementById('otp-code').value = '';
    clearError('otp-error');
    goto('screen-otp');
  } catch (err) {
    showError('register-error', 'Could not connect to Supabase. Is it running?');
  } finally {
    btn.innerHTML = orig;
    btn.disabled = false;
    resetCaptcha('captcha-register'); // token is single-use
  }
}

// ── Register (step 2: verify OTP → account created) ────────────
async function verifySignupOtp() {
  const token = document.getElementById('otp-code').value.trim();
  clearError('otp-error');

  if (!pendingSignup || !pendingSignup.email) {
    showError('otp-error', 'Session expired — please sign up again.'); return;
  }
  if (token.length !== 6) {
    showError('otp-error', 'Please enter the 6-digit code.'); return;
  }

  const btn = document.querySelector('#screen-otp .btn-submit');
  const orig = btn.innerHTML;
  btn.textContent = 'Verifying…';
  btn.disabled = true;


  console.log("attempting to send code")
  try {
    // 'signup' is the standard type for confirming a new account; some
    // Supabase versions label the same code 'email', so we fall back to it.
    let { data, error } = await sbClient.auth.verifyOtp({
      email: pendingSignup.email,
      token,
      type: 'signup'
    });
    if (error) {
      const retry = await sbClient.auth.verifyOtp({
        email: pendingSignup.email,
        token,
        type: 'email'
      });
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      showError('otp-error', error.message || 'Invalid or expired code.'); return;
    }

    // Verified — the account now exists and we're signed in.
    if (data.session) {
      Auth.token = data.session.access_token;
      Auth.user  = data.user;
    }
    if (data.user) updateAvatar(data.user.email);
    pendingSignup = null;
    goto('screen-home-auth');
  } catch (err) {
    showError('otp-error', 'Could not connect to Supabase. Is it running?');
  } finally {
    btn.innerHTML = orig;
    btn.disabled = false;
  }
}

async function resendSignupOtp() {
  if (!pendingSignup || !pendingSignup.email) return;

  const captchaToken = getCaptchaToken('captcha-otp');
  if (!captchaToken) {
    showError('otp-error', 'Please complete the captcha to resend the code.'); return;
  }

  const link = document.getElementById('otp-resend');
  const orig = link ? link.textContent : '';
  if (link) link.textContent = 'Sending…';

  console.log("attempting to resend code")
  try {
    const { error } = await sbClient.auth.signUp({
      email: pendingSignup.email,
      password: pendingSignup.password,
      options: { captchaToken }
    });
    showError('otp-error', error ? error.message : '✓ New code sent.');
  } catch (e) {
    showError('otp-error', 'Could not resend. Is Supabase running?');
  } finally {
    if (link) setTimeout(() => { link.textContent = orig; }, 1500);
    resetCaptcha('captcha-otp'); // token is single-use
  }
}

// ── Forgot password (step 1: send reset code) ──────────────────
async function sendResetCode() {
  const onReset = document.getElementById('screen-reset').classList.contains('active');
  const email = onReset
    ? resetEmail
    : document.getElementById('forgot-email').value.trim();
  const errId = onReset ? 'reset-error' : 'forgot-error';
  clearError(errId);

  if (!email) { showError(errId, 'Please enter your email.'); return; }

  // Pick the captcha widget on whichever screen we're on.
  const captchaId = onReset ? 'captcha-reset' : 'captcha-forgot';
  const captchaToken = getCaptchaToken(captchaId);
  if (!captchaToken) {
    showError(errId, 'Please complete the captcha.'); return;
  }

  const btn = onReset ? null : document.querySelector('#screen-forgot .btn-submit');
  let orig;
  if (btn) { orig = btn.innerHTML; btn.textContent = 'Sending…'; btn.disabled = true; }

  try {
    const { error } = await sbClient.auth.resetPasswordForEmail(email, { captchaToken });
    if (error) { showError(errId, error.message); return; }

    resetEmail = email;
    if (!onReset) {
      const target = document.getElementById('reset-target-email');
      if (target) target.textContent = email;
      document.getElementById('reset-code').value = '';
      document.getElementById('reset-pass').value = '';
      clearError('reset-error');
      goto('screen-reset');
    } else {
      showError('reset-error', '✓ New code sent.');
    }
  } catch (e) {
    showError(errId, 'Could not connect to Supabase. Is it running?');
  } finally {
    if (btn) { btn.innerHTML = orig; btn.disabled = false; }
    resetCaptcha(captchaId); // token is single-use
  }
}

// ── Forgot password (step 2: verify code + set new password) ───
async function resetPassword() {
  const token = document.getElementById('reset-code').value.trim();
  const newPass = document.getElementById('reset-pass').value;
  clearError('reset-error');

  if (!resetEmail) { showError('reset-error', 'Session expired — start over.'); return; }
  if (token.length !== 6) { showError('reset-error', 'Please enter the 6-digit code.'); return; }
  if (newPass.length < 6) { showError('reset-error', 'Password must be at least 6 characters.'); return; }

  const btn = document.querySelector('#screen-reset .btn-submit');
  const orig = btn.innerHTML;
  btn.textContent = 'Updating…';
  btn.disabled = true;

  try {
    // Verifying a recovery OTP signs the user in temporarily…
    const { error: vErr } = await sbClient.auth.verifyOtp({
      email: resetEmail,
      token,
      type: 'recovery'
    });
    if (vErr) { showError('reset-error', vErr.message || 'Invalid or expired code.'); return; }

    // …which lets us set the new password.
    const { error: uErr } = await sbClient.auth.updateUser({ password: newPass });
    if (uErr) { showError('reset-error', uErr.message); return; }

    // Sign out of the recovery session so they log in fresh.
    await sbClient.auth.signOut();
    Auth.token = null;
    Auth.user = null;
    resetEmail = '';
    goto('screen-login');
    showError('login-error', '✓ Password updated! Please sign in.');
  } catch (e) {
    showError('reset-error', 'Could not connect to Supabase. Is it running?');
  } finally {
    btn.innerHTML = orig;
    btn.disabled = false;
  }
}

// ── Login ──────────────────────────────────────────────────────
async function handleLogin() {
  const email    = document.querySelector('#screen-login input[type="email"]').value.trim();
  const password = document.getElementById('login-pass').value;

  clearError('login-error');

  // const captchaToken = turnstile.getResponse();
  // if (!captchaToken) {
  //   showError('login-error', 'Please complete the captcha first.');
  //   return;
  // }

  if (!email || !password) {
    showError('login-error', 'Please enter your email and password.'); return;
  }

  const captchaToken = getCaptchaToken('captcha-login');
  if (!captchaToken) {
    showError('login-error', 'Please complete the captcha.'); return;
  }

  const btn = document.querySelector('#screen-login .btn-submit');
  btn.textContent = 'Signing in…';
  btn.disabled = true;

  try {
    const { data, error } = await sbClient.auth.signInWithPassword({ 
      email, 
      password,
      options: {captchaToken} 
    });

    if (error) {
      showError('login-error', error.message); return;
    }

    Auth.token = data.session.access_token;
    Auth.user  = data.user;
    updateAvatar(data.user.email);
    goto('screen-home-auth');

  } catch (err) {
    showError('login-error', 'Could not connect to Supabase. Is it running?');
  } finally {
    btn.textContent = 'Sign in';
    btn.disabled = false;
    resetCaptcha('captcha-login'); // token is single-use
  }
}

// ── Logout ─────────────────────────────────────────────────────
async function handleLogout() {
  try {
    await sbClient.auth.signOut();
  } catch (err) {
    console.log("logout error:", err);
  } finally {
    Auth.token = null;
    Auth.user  = null;
    refreshAvatars();
    goto('screen-login');
  }
}

async function loadProfileStats() {
  if (!Auth.isLoggedIn()) return;
  const verified = reportsCache.filter(r => r.verdict === 'credible').length;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonth = reportsCache.filter(r => new Date(r.created_at) >= monthStart).length;
  const el = id => document.getElementById(id);
  if (el('stat-verified')) el('stat-verified').textContent = verified;
  if (el('stat-month')) el('stat-month').textContent = thisMonth;
  try {
    const { count } = await sbClient.from('flags')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', Auth.user.id);
    if (el('stat-flagged')) el('stat-flagged').textContent = count || 0;
  } catch (e) {
    if (el('stat-flagged')) el('stat-flagged').textContent = '—';
  }
}

// ── Change Email flow ──────────────────────────────────────────
async function handleChangeEmail() {
  const currentPass = document.getElementById('change-email-pass').value;
  const newEmail = document.getElementById('new-email-input').value.trim();
  clearError('change-email-error');
  if (!currentPass || !newEmail) { showError('change-email-error', 'Please fill in all fields.'); return; }

  const { error: authErr } = await sbClient.auth.signInWithPassword({
    email: Auth.user.email, password: currentPass
  });
  if (authErr) { showError('change-email-error', 'Incorrect password.'); return; }

  const btn = document.querySelector('#screen-change-email .btn-submit');
  btn.textContent = 'Updating…'; btn.disabled = true;
  try {
    const token = await getToken();
    const res = await fetch(`${BACKEND_URL}/account/email`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ email: newEmail })
    });
    const data = await res.json();
    if (!res.ok) { showError('change-email-error', data.detail || 'Failed to update email.'); return; }
    Auth.user.email = newEmail;
    updateAvatar(newEmail);
    document.getElementById('change-email-pass').value = '';
    document.getElementById('new-email-input').value = '';
    goto('screen-profile');
  } catch (e) {
    showError('change-email-error', 'Could not connect to server.');
  } finally {
    btn.textContent = 'Update email'; btn.disabled = false;
  }
}

// ── Change Password flow ───────────────────────────────────────
async function handleChangePassword() {
  const currentPass = document.getElementById('change-pass-current').value;
  const newPass = document.getElementById('change-pass-new').value;
  const confirmPass = document.getElementById('change-pass-confirm').value;
  clearError('change-pass-error');
  if (!currentPass || !newPass || !confirmPass) { showError('change-pass-error', 'Please fill in all fields.'); return; }
  if (newPass !== confirmPass) { showError('change-pass-error', 'New passwords do not match.'); return; }
  if (newPass.length < 6) { showError('change-pass-error', 'Password must be at least 6 characters.'); return; }

  const { error: authErr } = await sbClient.auth.signInWithPassword({
    email: Auth.user.email, password: currentPass
  });
  if (authErr) { showError('change-pass-error', 'Incorrect current password.'); return; }

  const btn = document.querySelector('#screen-change-password .btn-submit');
  btn.textContent = 'Updating…'; btn.disabled = true;
  try {
    const token = await getToken();
    const res = await fetch(`${BACKEND_URL}/account/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ password: newPass })
    });
    const data = await res.json();
    if (!res.ok) { showError('change-pass-error', data.detail || 'Failed to update password.'); return; }
    document.getElementById('change-pass-current').value = '';
    document.getElementById('change-pass-new').value = '';
    document.getElementById('change-pass-confirm').value = '';
    goto('screen-profile');
  } catch (e) {
    showError('change-pass-error', 'Could not connect to server.');
  } finally {
    btn.textContent = 'Update password'; btn.disabled = false;
  }
}

// ── Clear history flow ─────────────────────────────────────────
function confirmClearHistory() {
  document.getElementById('clear-history-modal').classList.add('open');
}
function closeClearHistoryModal() {
  document.getElementById('clear-history-modal').classList.remove('open');
}
async function executeClearHistory() {
  closeClearHistoryModal();
  if (!Auth.isLoggedIn()) return;
  try {
    await sbClient.from('reports').delete().eq('user_id', Auth.user.id);
    reportsCache = [];
    renderHistoryList();
  } catch (e) { console.warn('clear history failed:', e); }
}

// ── Delete account flow ────────────────────────────────────────
async function handleDeleteAccountConfirm() {
  const pass = document.getElementById('delete-confirm-pass').value;
  clearError('delete-account-error');
  if (!pass) { showError('delete-account-error', 'Please enter your password.'); return; }
  const { error: authErr } = await sbClient.auth.signInWithPassword({
    email: Auth.user.email, password: pass
  });
  if (authErr) { showError('delete-account-error', 'Incorrect password.'); return; }
  document.getElementById('delete-account-modal').classList.add('open');
}
function closeDeleteAccountModal() {
  document.getElementById('delete-account-modal').classList.remove('open');
}
async function executeDeleteAccount() {
  closeDeleteAccountModal();
  const token = await getToken();
  const res = await fetch(`${BACKEND_URL}/account`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) { showError('settings-error', 'Failed to delete account.'); return; }
  await sbClient.auth.signOut();
  Auth.token = null;
  Auth.user = null;
  goto('screen-login');
}

// // ── Change Email ───────────────────────────────────────────────
// async function changeEmail(newEmail) {
//   console.log("attempting to change email")
//   const token = await getToken()
//   const res = await fetch("http://127.0.0.1:8000/account/email", {
//     method: 'PUT',
//     headers: {
//       "Content-Type": "application/json",
//       "Authorization": `Bearer ${token}`
//     },
//     body: JSON.stringify({ email: newEmail })
//   });

//   const data = await res.json();
//   console.log(data);
//   if (!res.ok) showError('settings-error', data.detail || 'Failed to update email.');
//   else 
//     showError('settings-error', '✓ Email updated!')
//     updateAvatar(newEmail)
//   ;
// }

// // ── Change Password ────────────────────────────────────────────
// async function changePassword(newPassword) {
//   const token = await getToken()
//   console.log("attempting to change password");
//   const res = await fetch("http://127.0.0.1:8000/account/password", {
//     method: 'PUT',
//     headers: {
//       "Content-Type": "application/json",
//       "Authorization": `Bearer ${token}`
//     },
//     body: JSON.stringify({ password: newPassword })
//   });
//   const data = await res.json();
//   if (!res.ok) showError('settings-error', data.detail || 'Failed to update password.');
//   else showError('settings-error', '✓ Password updated!');
// }

// // ── Delete Account ─────────────────────────────────────────────
// async function deleteAccount() {
//   console.log("trying to delete account");
//   const token = await getToken()
//   const res = await fetch("http://127.0.0.1:8000/account", {
//     method: 'DELETE',
//     headers: {
//       "Authorization": `Bearer ${token}`
//     }
//   });
//   if (!res.ok) { showError('settings-error', 'Failed to delete account.'); return; }
//   await sbClient.auth.signOut();
//   Auth.token = null;
//   Auth.user  = null;
//   goto('screen-login');
// }



//OLd auth
// const SUPABASE_URL = "http://127.0.0.1:54321";
// const SUPABASE_ANON_KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
// const AUTH = `${SUPABASE_URL}/auth/v1`;

// const HEADERS = {
//   "Content-Type": "application/json",
//   "apikey": SUPABASE_ANON_KEY,
// };

// // ── Auth state ─────────────────────────────────────────────────
// const Auth = {
//   token: null,
//   user: null,
//   isLoggedIn() { return !!this.token; }
// };

// // ── Register ───────────────────────────────────────────────────
// async function handleRegister() {
//   const account_name = document.querySelector('#screen-register input[type="text"]').value.trim();
//   const email        = document.querySelector('#screen-register input[type="email"]').value.trim();
//   const password     = document.getElementById('reg-pass').value;
//   const confirm      = document.getElementById('confirm-pass').value;

//   clearError('register-error');

//   if (!account_name || !email || !password) {
//     showError('register-error', 'Please fill in all fields.'); return;
//   }
//   if (password !== confirm) {
//     showError('register-error', 'Passwords do not match.'); return;
//   }
//   if (password.length < 6) {
//     showError('register-error', 'Password must be at least 6 characters.'); return;
//   }

//   const btn = document.querySelector('#screen-register .btn-submit');
//   btn.textContent = 'Creating account…';
//   btn.disabled = true;

//   try {
//     const res = await fetch(`${AUTH}/signup`, {
//       method: 'POST',
//       headers: HEADERS,
//       body: JSON.stringify({
//         email,
//         password,
//         data: { account_name }   // stored in user_metadata
//       })
//     });

//     const data = await res.json();

//     if (!res.ok) {
//       showError('register-error', data.msg || data.error_description || 'Registration failed.');
//       return;
//     }

//     goto('screen-login');
//     showError('login-error', '✓ Account created! Please sign in.');
//   } catch (err) {
//     showError('register-error', 'Could not connect to Supabase. Is it running? (sbClient start)');
//   } finally {
//     btn.textContent = 'Create account';
//     btn.disabled = false;
//   }
// }

// // ── Login ──────────────────────────────────────────────────────
// async function handleLogin() {
//   const email    = document.querySelector('#screen-login input[type="email"]').value.trim();
//   const password = document.getElementById('login-pass').value;

//   clearError('login-error');

//   if (!email || !password) {
//     showError('login-error', 'Please enter your email and password.'); return;
//   }

//   const btn = document.querySelector('#screen-login .btn-submit');
//   btn.textContent = 'Signing in…';
//   btn.disabled = true;

//   try {
//     const res = await fetch(`${AUTH}/token?grant_type=password`, {
//       method: 'POST',
//       headers: HEADERS,
//       body: JSON.stringify({ email, password })
//     });

//     const data = await res.json();
//     console.log("Supabase error:", data);
//     if (!res.ok) {
//       showError('login-error', data.error_description || 'Invalid email or password.');
//       return;
//     }

//     Auth.token = data.access_token;
//     Auth.user  = data.user;
//     const username = data.user.user_metadata?.account_name;
//     updateAvatar(data.user.email, username);
//     goto('screen-home-auth');

//   } catch (err) {
//     showError('login-error', 'Could not connect to Supabase. Is it running? (sbClient start)');
//   } finally {
//     btn.textContent = 'Sign in';
//     btn.disabled = false;
//   }
// }

// // ── Logout ─────────────────────────────────────────────────────
// async function handleLogout() {
//   try {
//     await fetch(`${AUTH}/logout`, {
//       method: 'POST',
//       headers: { ...HEADERS, "Authorization": `Bearer ${Auth.token}` }
//     });
//   } finally {
//     Auth.token = null;
//     Auth.user  = null;
//     goto('screen-login');
//   }
// }

// // change email
// async function changeEmail(newEmail) {
//   const res = await fetch(`${AUTH}/user`, {
//     method: 'PUT',
//     headers: {
//       "Content-Type": "application/json",
//       "apikey": SUPABASE_ANON_KEY,
//       "Authorization": `Bearer ${Auth.token}`
//     },
//     body: JSON.stringify({ email: newEmail })
//   });
//   const data = await res.json();
//   console.log("new email: ", Auth.user.id)
//   if (!res.ok) showError('settings-error', data.msg || 'Failed to update email.');
//   else showError('settings-error', '✓ Email updated!');
//   console.log("success email(?)")
// }

// //change password
// async function changePassword(newPassword) {
//   console.log("trying to change password")
//   const res = await fetch(`${AUTH}/user`, {
//     method: 'PUT',
//     headers: { ...HEADERS, "Authorization": `Bearer ${Auth.token}` },
//     body: JSON.stringify({ password: newPassword })
//   });
//   const data = await res.json();
//   if (!res.ok) showError('settings-error', data.msg || 'Failed to update password.');
//   else showError('settings-error', '✓ Password updated!');
//    console.log("success password(?)")
// }

// async function deleteAccount() {
//   console.log("trying to delete account")
//   const res = await fetch(`http://127.0.0.1:8000/account`, {
//     method: 'DELETE',
//     headers: { "Authorization": `Bearer ${Auth.token}` }
//   });
//   if (res.ok) {
//     Auth.token = null;
//     Auth.user = null;
//     goto('screen-login');
//   }
//    console.log("success delete(?)")
// }


// // ── Update avatar initials after login ─────────────────────────
// function updateAvatar(email, name) {
//   const initial = email.charAt(0).toUpperCase();
//   document.querySelectorAll('.avatar').forEach(el => el.textContent = initial);
//   document.querySelectorAll(".profile-avatar").forEach(el => el.innerHTML = initial);
//   document.querySelectorAll(".profile-name").forEach(el => el.innerHTML = name);
//   document.querySelectorAll(".profile-email").forEach(el => el.innerHTML = email);
//   console.log("HELP ME")
// }

// Initialize avatars for the current (guest) session on page load.
refreshAvatars();