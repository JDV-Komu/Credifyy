// ===========================
//  CREDIFY — APP.JS
// ===========================

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
  }
}

// ── Filter pills (History screen) ──────────────────────────────
function setFilter(el) {
  const parent = el.closest('.filter-row');
  parent.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
}

// ── Loading screen ─────────────────────────────────────────────
// (The old code auto-jumped to a hardcoded 98% result after 3.2s.
//  Navigation is now driven by runScan() once the real analysis returns.)

// ── Animate credibility bars on result screens ──────────────────
function animateBars() {
  document.querySelectorAll('.cred-fill, .trend-bar-fill').forEach(bar => {
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

const BACKEND_URL = "http://127.0.0.1:8000";

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

  const startedAt = Date.now();
  let report;
  try {
    // Abort if the backend doesn't answer within 25s, so the loading screen
    // can never get stuck — we fall back to the local heuristic instead.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
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

  const elapsed = Date.now() - startedAt;
  setTimeout(() => {
    renderResult(report);
    goto('screen-result-high');
    saveReport(payload, report); // account users: persist to report history
  }, Math.max(0, 1200 - elapsed));
}

// Paint a report object into the result screen.
function renderResult(r) {
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
  const barColor = v => v >= 70 ? 'var(--green)' : v >= 40 ? 'var(--yellow)' : 'var(--red)';

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
  if (ob) { ob.style.width = r.score + '%'; ob.style.background = barColor(r.score); }
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
        `<div class="cred-bar"><div class="cred-fill" style="width:${v}%;background:${barColor(v)}"></div></div>` +
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
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    ? { verdict: 'credible', label: 'Credible', desc: 'Strong credibility markers detected.' }
    : score >= 40
    ? { verdict: 'uncertain', label: 'Uncertain', desc: 'Mixed signals — verify with other sources.' }
    : { verdict: 'not_credible', label: 'Not credible', desc: 'High likelihood of misinformation.' };

  const assemble = (score, confidence, inputType, breakdown, details, tags, summary) => {
    const v = verdictOf(score);
    const full = [
      { label: 'Input type', value: inputType },
      { label: 'Assessment confidence', value: clamp(confidence) + '%' },
    ].concat(details);
    return { score: clamp(score), confidence: clamp(confidence), input_type: inputType,
             verdict: v.verdict, label: v.label, desc: v.desc,
             breakdown, details: full, tags, summary, engine: 'heuristic' };
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
    return assemble(score, confidence, 'Image', breakdown, details, tags, summary);
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
  verify += Math.min(ATTRIB.filter(a => lower.includes(a)).length * 8, 32);
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
  if (knownFalse) bits.push('This matches a known false or debunked claim: ' + knownFalse + '.');
  else if (score >= 70) bits.push(publisher + ' shows strong credibility signals.');
  else if (score >= 40) bits.push('The signals here are mixed — nothing confirms or debunks it outright.');
  else bits.push('Several warning signs typical of low-quality or misleading content were found.');
  if (clickHits || sensHits) bits.push('The wording leans on emotional or clickbait-style language.');
  if (verify < 45 && !knownFalse) bits.push('Little sourcing or attribution was detected.');
  if (confidence < 45) bits.push('Confidence is low because there was little to go on — treat this as a rough estimate.');
  bits.push('This is an automated signal-based estimate; cross-check important claims with trusted fact-checkers.');

  return assemble(score, confidence, isUrl ? 'Article' : 'Text claim', breakdown, details, tags, bits.join(' '));
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

function checkStrength(value) {
  const fill = document.getElementById('strength-fill');
  const label = document.getElementById('strength-label');
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

// authentication

async function getToken() {
  const { data } = await sbClient.auth.getSession();
  return data?.session?.access_token || Auth.token;
}
// ── Auth state — kept in memory ────────────────────────────────
// Stores the logged-in user's token and info after login
// ── Config ─────────────────────────────────────────────────────

// ── Config ─────────────────────────────────────────────────────
//the url and anon key comes from a config.js file that can't be uploaded because we can't
// share the anon key (really unsafe)
const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

const captchaWidgets = {}; // container id -> turnstile widget id

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
  // If we're on a public screen (fresh load, or just back from Google),
  // move into the app.
  const active = document.querySelector('.screen.active');
  if (!active || ['screen-home', 'screen-login', 'screen-register', 'screen-otp'].includes(active.id)) {
    goto('screen-home-auth');
  }
}

sbClient.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session) applySession(session);
  if (event === 'SIGNED_OUT') {
    Auth.token = null;
    Auth.user  = null;
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
  renderResult(r.result);
  renderReportSidebar();
  goto('screen-result-high');
}

// Initial paint (locked panel for guests until a session is restored).
renderReportSidebar();

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
      options: { data: { account_name }, captchaToken }
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
      options: { captchaToken }
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

// ── Change Email ───────────────────────────────────────────────
async function changeEmail(newEmail) {
  console.log("attempting to change email")
  const token = await getToken()
  const res = await fetch("http://127.0.0.1:8000/account/email", {
    method: 'PUT',
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ email: newEmail })
  });

  const data = await res.json();
  console.log(data);
  if (!res.ok) showError('settings-error', data.detail || 'Failed to update email.');
  else 
    showError('settings-error', '✓ Email updated!')
    updateAvatar(newEmail)
  ;
}

// ── Change Password ────────────────────────────────────────────
async function changePassword(newPassword) {
  const token = await getToken()
  console.log("attempting to change password");
  const res = await fetch("http://127.0.0.1:8000/account/password", {
    method: 'PUT',
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ password: newPassword })
  });
  const data = await res.json();
  if (!res.ok) showError('settings-error', data.detail || 'Failed to update password.');
  else showError('settings-error', '✓ Password updated!');
}

// ── Delete Account ─────────────────────────────────────────────
async function deleteAccount() {
  console.log("trying to delete account");
  const token = await getToken()
  const res = await fetch("http://127.0.0.1:8000/account", {
    method: 'DELETE',
    headers: {
      "Authorization": `Bearer ${token}`
    }
  });
  if (!res.ok) { showError('settings-error', 'Failed to delete account.'); return; }
  await sbClient.auth.signOut();
  Auth.token = null;
  Auth.user  = null;
  goto('screen-login');
}



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