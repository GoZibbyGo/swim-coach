// Swim Coach PWA — wires the UI to the engine modules (imported directly;
// no build step). First slice: Today (generate + render) and Settings.

import { generateSession } from '../src/orchestrator.js';
import { renderSessionMarkdown, humanizeFlag } from '../src/renderer.js';
import { migrateCatalogue } from '../src/schema.js';
import { parseGarminCsv } from '../src/garmin-parser.js';
import { logSession, resolveFlag } from '../src/catalogue-writer.js';
import { phaseProgress } from '../src/phases.js';
import { analyzeSession } from '../src/session-analysis.js';
import { extractMarkerSeries } from '../src/series.js';
import { pullCatalogue, pushCatalogue, checkRepo, validateConfig, normalizeConfig } from '../src/github-sync.js';
import { buildBlockReportMarkdown } from '../src/block-report.js';

// ── Demo mode ──
// ?demo uses a completely separate storage namespace + a fake catalogue, so
// previewing History/Feedback/Graphs never touches the real data. The Gemini
// key/model are shared so the demo can still call the LLM.
const DEMO = new URLSearchParams(location.search).has('demo');
const NS = DEMO ? 'swimcoach.demo.' : 'swimcoach.';
const SEED = DEMO ? './seed-catalogue.demo.json' : './seed-catalogue.json';

// ── Storage keys ──
const K = {
  catalogue: NS + 'catalogue',
  pendingPlanned: NS + 'pendingPlanned',
  analysisPrefix: NS + 'analysis.',
  geminiKey: 'swimcoach.geminiKey', // shared across real + demo
  model: 'swimcoach.model',         // shared
  equipment: 'swimcoach.equipment', // shared device preference (not synced)
  // GitHub sync — real data only (sync is disabled in demo). Token/repo config
  // plus the last-synced blob sha, a dirty flag, and the last-synced timestamp.
  ghToken: 'swimcoach.github.token',
  ghOwner: 'swimcoach.github.owner',
  ghRepo: 'swimcoach.github.repo',
  ghPath: 'swimcoach.github.path',
  ghBranch: 'swimcoach.github.branch',
  ghSha: 'swimcoach.github.sha',
  ghDirty: 'swimcoach.github.dirty',
  ghSyncedAt: 'swimcoach.github.syncedAt',
};

// One-time model migration. `gemini-flash-latest` (a moving alias) started
// 503'ing persistently on the user's key; the diagnostic showed the stable
// `gemini-2.5-flash` healthy. Clear any stale stored value so the new default
// takes effect; users who *did* deliberately pick `flash-latest` in Settings
// can re-enter it there. Idempotent — only fires the once.
try {
  if (localStorage.getItem(K.model) === 'gemini-flash-latest') {
    localStorage.setItem(K.model, 'gemini-2.5-flash');
  }
} catch { /* localStorage may be unavailable in some contexts; safe to ignore */ }

// The pending (generated-but-not-yet-logged) session lives INSIDE the catalogue
// (`pending_session`), so it syncs to GitHub with everything else — generate on
// the phone, push, and the desktop sees the plan on its next open. Mutating it
// marks the catalogue dirty (a push shares it); logging the plan clears it.
function readCatalogueRaw() {
  try { return JSON.parse(localStorage.getItem(K.catalogue) || 'null'); } catch { return null; }
}
function getPending() { return readCatalogueRaw()?.pending_session || null; }
function setPending(session) {
  const cat = readCatalogueRaw();
  if (!cat) return; // catalogue is always loaded before we generate
  cat.pending_session = { session, at: Date.now() };
  saveCatalogue(cat);
}
function clearPending() {
  const cat = readCatalogueRaw();
  if (!cat?.pending_session) return;
  delete cat.pending_session;
  saveCatalogue(cat);
}

// ── Catalogue load/save (localStorage; seeded from web/seed-catalogue.json) ──
async function loadCatalogue() {
  const raw = localStorage.getItem(K.catalogue);
  if (raw) {
    try {
      const cat = JSON.parse(raw);
      // One-time upgrade: fold a legacy device-local pending plan into the
      // catalogue so it survives (and starts syncing).
      const legacy = localStorage.getItem(K.pendingPlanned);
      let foldedLegacy = false;
      if (legacy && !cat.pending_session) {
        try { cat.pending_session = JSON.parse(legacy); foldedLegacy = true; } catch { /* ignore */ }
        localStorage.removeItem(K.pendingPlanned);
      }
      // Run one-time migrations on the local copy too — not every open comes
      // through a pull. A corrective migration (e.g. the standing-start 25m
      // scrub) is gated to run once; when it changes anything, persist and mark
      // dirty so the fix syncs back to GitHub and every device.
      const before = JSON.stringify(cat);
      const migrated = migrateCatalogue(cat);
      if (JSON.stringify(migrated) !== before) saveCatalogue(migrated); // dirty → auto-push
      else if (foldedLegacy) writeCatalogue(migrated);                  // quiet persist (prior behaviour)
      return migrated;
    } catch { /* fall through */ }
  }
  const seed = await fetch(SEED).then(r => r.json());
  const migrated = migrateCatalogue(seed);
  // Demo: seed a pending planned session (e.g. a dryland) so the structured
  // Log form is visible on first run.
  if (DEMO && seed.demo_pending_session && !migrated.pending_session) {
    migrated.pending_session = { session: seed.demo_pending_session, at: Date.now() };
  }
  localStorage.setItem(K.catalogue, JSON.stringify(migrated));
  return migrated;
}
// writeCatalogue persists without touching sync state (used by pull/seed).
// saveCatalogue is for *local edits* (logging, flag changes) — it marks the
// catalogue dirty so the sync pill prompts a push.
function writeCatalogue(cat) { localStorage.setItem(K.catalogue, JSON.stringify(cat)); }
function saveCatalogue(cat) { writeCatalogue(cat); markDirty(); }

// ── GitHub sync (real data only) ──────────────────────────────────────────
function githubConfig() {
  return normalizeConfig({
    token: localStorage.getItem(K.ghToken) || '',
    owner: localStorage.getItem(K.ghOwner) || '',
    repo: localStorage.getItem(K.ghRepo) || '',
    path: localStorage.getItem(K.ghPath) || '',
    branch: localStorage.getItem(K.ghBranch) || '',
  });
}
function syncConfigured() { return !DEMO && validateConfig(githubConfig()).valid; }
function isDirty() { return localStorage.getItem(K.ghDirty) === '1'; }
function markDirty() { if (DEMO) return; localStorage.setItem(K.ghDirty, '1'); updateSyncPill(); scheduleAutoPush(); }
function markClean(sha) {
  if (DEMO) return;
  localStorage.setItem(K.ghDirty, '0');
  if (sha) localStorage.setItem(K.ghSha, sha);
  localStorage.setItem(K.ghSyncedAt, new Date().toISOString());
  updateSyncPill();
}

// ── Auto-push ──
// Every local edit (generate/log/flag change) schedules a background push.
// Debounced so a burst of saves (e.g. log → clear pending) coalesces into one
// request. Success is silent (the pill turns 'synced'); a conflict or hard
// error surfaces a banner. Offline just leaves it dirty to retry on next change.
let _pushTimer = null, _pushing = false, _pushAgain = false;
function scheduleAutoPush() {
  if (!syncConfigured()) return;
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(runAutoPush, 800);
}
async function runAutoPush() {
  if (!syncConfigured() || !isDirty()) return;
  if (_pushing) { _pushAgain = true; return; }
  _pushing = true;
  try {
    const cat = readCatalogueRaw();
    if (!cat) return;
    const sha = localStorage.getItem(K.ghSha) || undefined;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const r = await pushCatalogue(githubConfig(), cat, { sha, message: `Auto-sync — ${stamp}` });
    if (r.ok) markClean(r.sha);
    else if (r.error.kind === 'conflict') banner('warn', '⚠ Couldn’t auto-sync — the catalogue changed on another device. Open Settings → Push to resolve.');
    else if (r.error.kind !== 'offline') banner('warn', `Auto-sync failed: ${r.error.message}`);
    // offline → stay dirty (pill shows 'unsynced'); retries on the next change.
  } finally {
    _pushing = false;
    if (_pushAgain) { _pushAgain = false; scheduleAutoPush(); }
  }
}

function updateSyncPill() {
  const el = document.getElementById('syncState');
  if (!el) return;
  el.classList.remove('dirty', 'ok');
  if (DEMO) { el.textContent = 'DEMO DATA'; el.title = ''; return; }
  if (!syncConfigured()) { el.textContent = 'sync off'; el.title = 'Set up GitHub sync in Settings'; return; }
  if (isDirty()) { el.textContent = '● unsynced'; el.classList.add('dirty'); el.title = 'Local changes not pushed — open Settings to push'; return; }
  if (!localStorage.getItem(K.ghSyncedAt)) { el.textContent = 'not synced'; el.title = 'Configured but not synced yet — open Settings to pull or push'; return; }
  el.textContent = 'synced'; el.classList.add('ok'); el.title = 'Up to date with GitHub';
}

// Sessions present in `a` but not in `b`, matched on a content signature
// (date+type+subtype+distance) since ids can diverge across devices. Used to
// tell the athlete which logged sessions a conflict resolution would drop.
function sessionSig(s) { return `${s.date}|${s.type}|${s.subtype ?? ''}|${s.distance_m ?? ''}`; }
function sessionsNotIn(a, b) {
  const have = new Set((b || []).map(sessionSig));
  return (a || []).filter(s => !have.has(sessionSig(s)));
}
function sessionLabel(s) { return `${s.date} · ${s.subtype || s.type}${s.distance_m ? ` (${s.distance_m}m)` : ''}`; }

// On app open: if sync is configured and there are no unpushed local changes,
// adopt the remote catalogue when it has moved. If there ARE local changes we
// never auto-overwrite them — we tell the athlete to push (which reconciles).
async function maybeAutoPull() {
  updateSyncPill();
  if (!syncConfigured()) return;
  if (isDirty()) { banner('warn', 'You have changes that aren’t on GitHub yet — open Settings to push them.'); return; }

  const r = await pullCatalogue(githubConfig());
  if (!r.ok) {
    if (r.error.kind === 'not_found') return; // no remote file yet — first push will create it
    if (r.error.kind === 'offline') banner('warn', '📡 Offline — using your local catalogue; it’ll sync when you’re back online.');
    else banner('warn', `Couldn’t pull from GitHub: ${r.error.message}`);
    return;
  }
  const lastSha = localStorage.getItem(K.ghSha) || null;
  if (r.sha === lastSha) { markClean(r.sha); return; } // already current
  writeCatalogue(migrateCatalogue(r.catalogue)); // adopts remote's pending plan too
  markClean(r.sha);
  go('today'); // go() clears the banner, so render first then announce
  banner('good', '✓ Pulled the latest catalogue from GitHub.');
}

// Trigger a client-side file download (no server).
function downloadText(filename, text, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Block just completed → offer the analysis export (prepended above the debrief).
function showBlockFinished(catalogue, blockNumber) {
  const host = document.getElementById('debrief');
  if (!host) return;
  const card = document.createElement('div');
  card.className = 'card';
  card.style.borderColor = 'var(--accent)';
  card.innerHTML = `<strong>🎉 Block ${blockNumber} finished — download for deeper analysis</strong>
    <p class="muted">This file has the block's prescribed plans + your actual results + feedback. Hand it to your coaching-review Claude project (set up from the brief on this page) to grade how the app is generating and analysing — it returns a feedback file that goes to the developer to improve the app.</p>
    <button id="dlBlock" class="block">⬇ Download block ${blockNumber} analysis (.md)</button>`;
  host.prepend(card);
  document.getElementById('dlBlock').addEventListener('click', () =>
    downloadText(`swim-block-${blockNumber}-analysis.md`, buildBlockReportMarkdown(catalogue, blockNumber)));
}

// ── Minimal, safe Markdown → HTML for our renderer's output ──
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italics: only match _x_ at token boundaries so snake_case (e.g.
    // right_quad_pre_cramp) is left intact.
    .replace(/(^|[\s(>])_([^_\n]+?)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
}
function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^### /.test(line)) { out.push(`<h3>${inline(line.slice(4))}</h3>`); i++; continue; }
    if (/^## /.test(line)) { out.push(`<h2>${inline(line.slice(3))}</h2>`); i++; continue; }
    if (/^# /.test(line)) { out.push(`<h1>${inline(line.slice(2))}</h1>`); i++; continue; }
    // table
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      out.push(renderTable(rows));
      continue;
    }
    // list
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) { items.push(`<li>${inline(lines[i].slice(2))}</li>`); i++; }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    // indented cue / target (our renderer uses "  > " and "  → ")
    if (/^\s*> /.test(line)) { out.push(`<blockquote>${inline(line.replace(/^\s*> /, ''))}</blockquote>`); i++; continue; }
    if (/^\s*→ /.test(line)) { out.push(`<p class="cue">${inline(line.trim())}</p>`); i++; continue; }
    if (line.trim() === '') { i++; continue; }
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  return out.join('\n');
}
function renderTable(rows) {
  const cells = r => r.split('|').slice(1, -1).map(c => c.trim());
  const header = cells(rows[0]);
  const bodyRows = rows.slice(1).filter(r => !/^\|[\s|:-]+\|$/.test(r.replace(/\s/g, m => m)) && !/^\|[-:\s|]+$/.test(r));
  const th = `<tr>${header.map(h => `<th>${inline(h)}</th>`).join('')}</tr>`;
  const tb = bodyRows.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead>${th}</thead><tbody>${tb}</tbody></table>`;
}

// ── Banner ──
function banner(kind, msg) {
  const el = document.getElementById('banner');
  el.className = `banner ${kind}`;
  el.textContent = msg;
  if (!msg) el.classList.add('hidden');
}
function clearBanner() { banner('', ''); }

// ── Screens ──
const view = document.getElementById('view');

const SPARK = '#2ee6a6';
function r1(n) { return n == null ? null : Math.round(n * 10) / 10; }
function niceDay() { try { return new Date().toLocaleDateString(undefined, { weekday: 'long' }); } catch { return ''; } }

function sparklineSvg(values) {
  const v = (values || []).filter(x => x != null && Number.isFinite(x));
  if (v.length < 2) return '';
  const w = 100, h = 26, pad = 3;
  const min = Math.min(...v), max = Math.max(...v), span = (max - min) || 1;
  const pts = v.map((val, i) => {
    const x = pad + i * (w - 2 * pad) / (v.length - 1);
    const y = h - pad - (val - min) / span * (h - 2 * pad);
    return `${r1(x)},${r1(y)}`;
  }).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${SPARK}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// Ring shows block progress through the phase; targets shown as progress info.
// Current-block progress shown as `completed_blocks.sessions_done_this_block`
// (e.g. "1.2" = 1 block done, 2 sessions into the current block).
function blockProgress(catalogue, pp) {
  if (!pp || pp.terminal) return null;
  const t = catalogue?.weekly_block_tracking ?? {};
  const done = (t.current_block_pool_count ?? 0) + (t.current_block_dryland_count ?? 0);
  const total = 4; // 3 pool + 1 dryland
  return {
    number: t.current_block_number ?? 1,
    done, total,
    next: Math.min(done + 1, total),
    figure: `${pp.blocks_done}.${done}`,
  };
}

function ringCardHtml(pp, bp) {
  if (!pp) return '';
  const deg = Math.round((pp.pct || 0) * 3.6);
  const tgts = (pp.targets || []).map(t =>
    `<div class="gaterow"><span class="gdot ${t.met ? 'ok' : 'no'}">${t.met ? '✓' : ''}</span>
     ${esc(t.label)}: <b>${esc(String(t.current ?? '—'))}${esc(t.unit || '')}</b>
     <span class="muted">→ ${esc(String(t.target))}${esc(t.unit || '')}</span></div>`).join('');
  const center = pp.terminal ? '🏁' : `${pp.blocks_done}/${pp.blocks_total}`;
  const blockLine = bp
    ? `<div class="line">Progress <b>${bp.figure}</b> — Block ${bp.number}, ${bp.done}/${bp.total} sessions${bp.done < bp.total ? ` · next: session ${bp.next}` : ' · block complete'}</div>`
    : '';
  return `<div class="ring-card">
    <div class="ring" style="background:conic-gradient(var(--accent) 0 ${deg}deg,#22303f ${deg}deg 360deg)"><span>${center}</span></div>
    <div class="ring-meta">
      <div class="title">Phase ${pp.phase} · ${esc(pp.name)}</div>
      <div class="line">${pp.terminal ? 'Final phase — race attempt' : `Block ${pp.blocks_done} of ${pp.blocks_total}`}</div>
      ${blockLine}
      ${tgts}
    </div>
  </div>`;
}

function tilesHtml(catalogue, series) {
  const rb = catalogue.rolling_bests || {};
  const find = k => series.find(s => s.key === k);
  const delta = (s, lower) => {
    if (!s || s.points.length < 2) return { txt: '—', cls: 'flat' };
    const a = s.points[s.points.length - 2].value, b = s.points[s.points.length - 1].value;
    const d = r1(b - a);
    if (d === 0) return { txt: 'no change', cls: 'flat' };
    const improved = lower ? d < 0 : d > 0;
    const arrow = lower ? (d < 0 ? '▼' : '▲') : (d > 0 ? '▲' : '▼');
    return { txt: `${arrow} ${Math.abs(d)} vs last`, cls: improved ? 'up' : 'down' };
  };
  const sDps = find('dps');
  const tiles = [
    { k: 'Best 25m', v: rb.best_25m_sprint_protocol_s != null ? rb.best_25m_sprint_protocol_s + 's' : '—', s: find('best_25m'), lower: true },
    { k: 'Avg SWOLF', v: rb.best_avg_swolf ?? '—', s: find('avg_swolf'), lower: true },
    { k: 'Dist / stroke', v: sDps && sDps.points.length ? sDps.points[sDps.points.length - 1].value + 'm' : '—', s: sDps, lower: false },
    { k: 'Avg pace /100m', v: rb.best_avg_pace_per_100m ?? '—', s: find('avg_pace'), lower: true },
  ];
  return `<div class="grid">${tiles.map(t => {
    const d = delta(t.s, t.lower);
    return `<div class="tile"><div class="k">${esc(t.k)}</div><div class="v">${esc(String(t.v))}</div>
      <div class="d ${d.cls}">${esc(d.txt)}</div>${t.s ? sparklineSvg(t.s.points.map(p => p.value)) : ''}</div>`;
  }).join('')}</div>`;
}

// Known-bad early data: the best-25m readings on/before 2026-04-10 (16.1/16.3s)
// were faulty — implausibly fast vs. every later session — so they're hidden
// from the trend visuals (Graphs + the Today sparklines). Display-only: the
// catalogue itself is untouched and still syncs as-is.
const TREND_AFTER_DATE = '2026-04-10';
function trendSeries(catalogue) {
  return extractMarkerSeries(catalogue)
    .map(s => ({ ...s, points: s.points.filter(p => p.date > TREND_AFTER_DATE) }))
    .filter(s => s.points.length > 0);
}

// ── Equipment availability (pre-session checkboxes; device preference, not synced) ──
const EQUIPMENT = [
  { key: 'paddles', label: 'Paddles' },
  { key: 'pull_buoy', label: 'Pull buoy' },
  { key: 'bars', label: 'Bars' },
  { key: 'rings', label: 'Rings' },
  { key: 'weights', label: 'Weights' },
];
function getEquipment() {
  try { const v = JSON.parse(localStorage.getItem(K.equipment)); if (Array.isArray(v)) return v; } catch { /* */ }
  return EQUIPMENT.map(e => e.key); // default: assume everything is on hand
}
function setEquipment(list) { localStorage.setItem(K.equipment, JSON.stringify(list)); }
function readEquipmentBoxes() {
  const boxes = [...document.querySelectorAll('.equipBox')];
  return boxes.length ? boxes.filter(b => b.checked).map(b => b.value) : getEquipment();
}
function equipmentSelectorHtml() {
  const have = new Set(getEquipment());
  return `<div class="equip">
    <div class="equip-label">Equipment available — the session will match what's ticked</div>
    <div class="row">${EQUIPMENT.map(e =>
      `<label class="opt"><input type="checkbox" class="equipBox" value="${esc(e.key)}" ${have.has(e.key) ? 'checked' : ''}/> ${esc(e.label)}</label>`).join('')}</div>
  </div>`;
}
function wireEquipmentBoxes() {
  document.querySelectorAll('.equipBox').forEach(b => b.addEventListener('change', () => setEquipment(readEquipmentBoxes())));
}

async function screenToday() {
  const catalogue = await loadCatalogue();
  const pending = getPending();
  const series = trendSeries(catalogue);
  let pp; try { pp = phaseProgress(catalogue); } catch { pp = null; }

  // Sync the pending session's display label to the LIVE block counter. The
  // renderer reads `block_number` / `session_in_block` straight off the plan
  // (renderer.js:51), and those are baked in at generation time — so if the
  // counter changes after generation (e.g. the dedupe migration rolled it back),
  // the card title would otherwise stay stale. Re-derive from
  // weekly_block_tracking and persist when it actually changed.
  if (pending?.session) {
    const wbt = catalogue.weekly_block_tracking ?? {};
    const liveBlock = wbt.current_block_number ?? pending.session.block_number;
    const liveSiB = (wbt.current_block_pool_count ?? 0) + (wbt.current_block_dryland_count ?? 0) + 1;
    if (pending.session.session_in_block !== liveSiB || pending.session.block_number !== liveBlock) {
      pending.session.session_in_block = liveSiB;
      pending.session.block_number = liveBlock;
      saveCatalogue(catalogue); // marks dirty → debounced auto-push to GitHub
    }
  }

  const hello = `<div class="dash-hello">${esc(niceDay())}${pp ? ` · Phase ${pp.phase}` : ''}</div>
    <div class="dash-h1">${pending ? 'Your session is ready 🏊' : 'Ready to train 🏊'}</div>`;

  const session = pending?.session
    ? `<div class="sec">Today's session · awaiting log</div>
       <div class="card">${equipmentSelectorHtml()}
         <button id="regenBtn" class="block secondary">↻ Regenerate this session</button></div>
       <div id="sessionOut"><div class="card session">${mdToHtml(renderSessionMarkdown(pending.session))}</div></div>`
    : `<div class="sec">Next session</div>
       <div class="card"><p class="muted" style="margin-top:0">Generate your next session from your catalogue, phase and any active flags.</p>
       ${equipmentSelectorHtml()}
       <button id="genBtn" class="block">Generate next session</button></div>
       <div id="sessionOut"></div>`;

  view.innerHTML = hello + ringCardHtml(pp, blockProgress(catalogue, pp)) + tilesHtml(catalogue, series) + session;
  document.getElementById('genBtn')?.addEventListener('click', generate);
  document.getElementById('regenBtn')?.addEventListener('click', generate);
  wireEquipmentBoxes();
}

async function generate() {
  const btn = document.getElementById('genBtn') || document.getElementById('regenBtn');
  const out = document.getElementById('sessionOut');
  if (btn) btn.disabled = true;
  if (out) out.innerHTML = `<div class="card spinner">Generating…</div>`;
  clearBanner();
  try {
    const catalogue = await loadCatalogue();
    const apiKey = localStorage.getItem(K.geminiKey) || undefined;
    const model = localStorage.getItem(K.model) || undefined;
    const equipmentAvailable = readEquipmentBoxes();
    setEquipment(equipmentAvailable); // remember the selection for next time
    let knowledge;
    try { knowledge = await fetch('../knowledge/swimming-coaching-kb.md').then(r => r.ok ? r.text() : undefined); } catch { /* optional */ }

    const result = await generateSession(catalogue, { apiKey, model, knowledge, equipmentAvailable });

    if (result.status === 'success') banner('good', '✓ Session generated by Gemini.');
    else bannerForFallback(result);

    setPending(result.session);   // persist — Log binds to this, blocks re-advance
    screenToday();                // re-render into the "awaiting log" state
  } catch (e) {
    banner('bad', `Error: ${e?.message ?? e}`);
  }
}

function bannerForFallback(r) {
  const reason = r.fallback_reason;
  if (reason === 'no_llm') { banner('warn', 'Using the template library (no Gemini key set — add one in Settings for richer sessions).'); return; }
  if (reason === 'offline') { banner('warn', '📡 Offline — using the template library. Your session is ready; reconnect for Gemini next time.'); return; }
  if (reason === 'rate_limit_minute') {
    const s = r.retry_after_seconds ?? 60;
    banner('warn', `⏳ Gemini per-minute limit hit — using the template library. Try again in ~${s}s for a Gemini session.`);
    return;
  }
  if (reason === 'rate_limit_daily') {
    const when = r.retry_after_iso ? new Date(r.retry_after_iso).toLocaleString() : 'midnight Pacific';
    banner('warn', `📵 Gemini daily free quota reached — using the template library. Resets ${when}.`);
    return;
  }
  if (reason === 'validation_failed') { banner('warn', 'Gemini output failed validation — using the template library (still a complete, verified session).'); return; }
  // Transient Gemini errors (503 "model busy", 500 etc.) reach here as
  // 'api' / 'api_error'. Make it clear the user IS getting a real session /
  // debrief from the template library — they don't need to retry to use the
  // app, only to get the Gemini-flavoured version.
  if (reason === 'api' || reason === 'api_error') {
    banner('warn', '⚠ Gemini is busy right now — your session is ready from the template library. Try again in a few minutes for the Gemini-flavoured version.');
    return;
  }
  banner('warn', r.message || 'Using the template library.');
}

function screenSettings() {
  const key = localStorage.getItem(K.geminiKey) || '';
  const model = localStorage.getItem(K.model) || 'gemini-2.5-flash';
  view.innerHTML = `
    <div class="card">
      <strong>Gemini (free)</strong>
      <p class="muted">Get a free key at aistudio.google.com. Stored only on this device.</p>
      <label>API key</label>
      <input type="password" id="geminiKey" value="${esc(key)}" placeholder="AIza…" autocomplete="off" />
      <label>Model</label>
      <input type="text" id="model" value="${esc(model)}" />
      <button id="saveSettings" class="block">Save</button>
      <button id="clearKey" class="block secondary">Remove key</button>
    </div>
    ${githubCardHtml()}
    <div class="card">
      <strong>Catalogue</strong>
      <p class="muted">Reset clears your local copy and re-seeds from the bundled catalogue.</p>
      <button id="resetCat" class="block secondary">Reset local catalogue</button>
    </div>`;

  document.getElementById('saveSettings').addEventListener('click', () => {
    const k = document.getElementById('geminiKey').value.trim();
    const m = document.getElementById('model').value.trim() || 'gemini-2.5-flash';
    if (k) localStorage.setItem(K.geminiKey, k); else localStorage.removeItem(K.geminiKey);
    localStorage.setItem(K.model, m);
    banner('good', 'Settings saved.');
  });
  document.getElementById('clearKey').addEventListener('click', () => {
    localStorage.removeItem(K.geminiKey);
    document.getElementById('geminiKey').value = '';
    banner('good', 'Key removed — will use the template library.');
  });
  document.getElementById('resetCat').addEventListener('click', () => {
    localStorage.removeItem(K.catalogue); // pending_session lives in here, so it goes too
    localStorage.removeItem(K.pendingPlanned); // drop any legacy device-local plan
    // Local copy is gone → not "dirty"; let the next open re-pull from GitHub.
    localStorage.setItem(K.ghDirty, '0');
    localStorage.removeItem(K.ghSha);
    updateSyncPill();
    banner('good', 'Local catalogue reset.');
  });
  wireGithubCard();
}

// ── GitHub sync settings card ──
function githubCardHtml() {
  if (DEMO) {
    return `<div class="card"><strong>GitHub sync</strong>
      <p class="muted">Sync is disabled in demo mode — it never touches your real catalogue or repo.</p></div>`;
  }
  const cfg = githubConfig();
  const syncedAt = localStorage.getItem(K.ghSyncedAt);
  const when = syncedAt ? new Date(syncedAt).toLocaleString() : 'never';
  return `<div class="card">
    <strong>GitHub sync</strong>
    <p class="muted">Share one catalogue across your phone and desktop via a private repo. Needs a
      <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">personal access token</a>
      with read/write access to <em>Contents</em> on that repo. Stored only on this device.</p>
    <label>Token</label>
    <input type="password" id="ghToken" value="${esc(cfg.token)}" placeholder="github_pat_… or ghp_…" autocomplete="off" />
    <div class="row">
      <div style="flex:1;min-width:120px"><label>Owner (user/org)</label>
        <input type="text" id="ghOwner" value="${esc(cfg.owner)}" placeholder="your-username" /></div>
      <div style="flex:1;min-width:120px"><label>Repo</label>
        <input type="text" id="ghRepo" value="${esc(cfg.repo)}" placeholder="swim-catalogue" /></div>
    </div>
    <div class="row">
      <div style="flex:1;min-width:120px"><label>File path</label>
        <input type="text" id="ghPath" value="${esc(cfg.path)}" placeholder="catalogue.json" /></div>
      <div style="flex:1;min-width:120px"><label>Branch</label>
        <input type="text" id="ghBranch" value="${esc(cfg.branch)}" placeholder="main" /></div>
    </div>
    <button id="ghSave" class="block secondary">Save & test connection</button>
    <div class="row" style="margin-top:6px">
      <button id="ghPull" class="secondary" style="flex:1">⬇ Pull from GitHub</button>
      <button id="ghPush" style="flex:1">⬆ Push to GitHub</button>
    </div>
    <p class="muted" id="ghStatus" style="margin:10px 0 0">Last synced: ${esc(when)}.${isDirty() ? ' <strong>You have local changes to push.</strong>' : ''}</p>
    <div id="syncDialog"></div>
  </div>`;
}

function wireGithubCard() {
  if (DEMO) return;
  document.getElementById('ghSave')?.addEventListener('click', saveAndTestGithub);
  document.getElementById('ghPull')?.addEventListener('click', pullNow);
  document.getElementById('ghPush')?.addEventListener('click', pushNow);
}

function saveGithubFields() {
  const set = (k, id) => {
    const v = document.getElementById(id).value.trim();
    if (v) localStorage.setItem(k, v); else localStorage.removeItem(k);
  };
  set(K.ghToken, 'ghToken'); set(K.ghOwner, 'ghOwner'); set(K.ghRepo, 'ghRepo');
  set(K.ghPath, 'ghPath'); set(K.ghBranch, 'ghBranch');
}

async function saveAndTestGithub() {
  saveGithubFields();
  updateSyncPill();
  if (!syncConfigured()) { banner('warn', 'Add at least a token, owner and repo.'); return; }
  banner('warn', 'Testing connection…');
  const r = await checkRepo(githubConfig());
  if (r.ok) banner('good', `✓ Connected to ${r.repo.full_name}${r.repo.private ? ' (private)' : ' — ⚠ this repo is PUBLIC'}.`);
  else if (r.error.kind === 'offline') banner('warn', '📡 Offline — saved your settings; test again when online.');
  else banner('bad', `Connection failed: ${r.error.message}`);
}

async function pullNow() {
  if (!ensureConfigured()) return;
  if (isDirty() && !confirm('You have local changes that aren’t on GitHub. Pulling will replace your local copy and discard them. Continue?')) return;
  banner('warn', 'Pulling…');
  const r = await pullCatalogue(githubConfig());
  if (!r.ok) {
    if (r.error.kind === 'not_found') banner('warn', 'No catalogue on GitHub yet — Push to create it.');
    else if (r.error.kind === 'offline') banner('warn', '📡 Offline — couldn’t pull. Try again when online.');
    else banner('bad', `Pull failed: ${r.error.message}`);
    return;
  }
  writeCatalogue(migrateCatalogue(r.catalogue)); // adopts remote's pending plan too
  markClean(r.sha);
  go('settings');
  banner('good', '✓ Pulled the latest catalogue from GitHub.');
}

async function pushNow() {
  if (!ensureConfigured()) return;
  banner('warn', 'Pushing…');
  const cat = await loadCatalogue();
  const sha = localStorage.getItem(K.ghSha) || undefined;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const r = await pushCatalogue(githubConfig(), cat, { sha, message: `Update catalogue from app — ${stamp}` });
  if (r.ok) { markClean(r.sha); go('settings'); banner('good', '✓ Pushed to GitHub. Your other device will pick it up next time it opens.'); return; }
  if (r.error.kind === 'conflict') { await handleConflict(cat); return; }
  if (r.error.kind === 'offline') { banner('warn', '📡 Offline — couldn’t push. Try again when online.'); return; }
  banner('bad', `Push failed: ${r.error.message}`);
}

function ensureConfigured() {
  if (syncConfigured()) return true;
  banner('warn', 'Set up GitHub sync first — add a token, owner and repo, then Save & test.');
  return false;
}

// A push was rejected because GitHub moved since this device last synced.
// Show, in plain terms, which logged sessions each choice would delete, and let
// the athlete decide. Block progression stays correct either way: counts are
// recomputed whenever you log, so re-logging a dropped session restores them.
async function handleConflict(localCat) {
  const remote = await pullCatalogue(githubConfig());
  if (!remote.ok) { banner('bad', `The catalogue changed on GitHub, and the remote copy couldn’t be read: ${remote.error.message}`); return; }

  const localOnly = sessionsNotIn(localCat.sessions, remote.catalogue.sessions);  // dropped if you keep GitHub's copy
  const remoteOnly = sessionsNotIn(remote.catalogue.sessions, localCat.sessions); // dropped if you keep this device's copy
  const noLoggedDiff = localOnly.length === 0 && remoteOnly.length === 0;
  // Per-side warning: only shown when that choice would actually drop a logged session.
  const dropWarn = (arr, who) => arr.length
    ? `<br><span class="muted">These session(s) ${who} will be deleted:</span>
       <ul>${arr.map(s => `<li>${esc(sessionLabel(s))}</li>`).join('')}</ul>`
    : '';

  const dlg = document.getElementById('syncDialog');
  banner('warn', '⚠ The catalogue changed on another device since this one last synced.');
  dlg.innerHTML = `
    <div class="card" style="border-color:var(--warn);margin-top:12px">
      <strong>Sync conflict — pick which copy to keep</strong>
      <p class="muted">${noLoggedDiff
        ? 'No logged sessions differ — the copies differ only in the planned next session or minor state. Either choice is safe; nothing you logged will be lost.'
        : 'Both copies have sessions the other doesn’t. Whichever you don’t keep will be deleted — re-log it afterwards as an <em>External</em> session (it still counts toward your block). Your block progress stays correct either way.'}</p>

      <p style="margin-bottom:2px"><strong>Keep this device’s copy</strong> (push and overwrite GitHub).${dropWarn(remoteOnly, 'from the other device')}</p>
      <button id="ghForcePush" class="block">Keep this device’s copy</button>

      <p style="margin:14px 0 2px"><strong>Keep GitHub’s copy</strong> (pull and overwrite this device).${dropWarn(localOnly, 'you logged here')}</p>
      <button id="ghTakeRemote" class="block secondary">Keep GitHub’s copy</button>
    </div>`;

  document.getElementById('ghForcePush').addEventListener('click', async () => {
    banner('warn', 'Pushing…');
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const r = await pushCatalogue(githubConfig(), localCat, { sha: remote.sha, message: `Resolve conflict (kept this device) — ${stamp}` });
    if (r.ok) {
      markClean(r.sha);
      const note = remoteOnly.length ? ` Re-log as External: ${remoteOnly.map(sessionLabel).join('; ')}.` : '';
      go('settings');
      banner('good', `✓ This device’s copy is now on GitHub.${note}`);
    } else banner('bad', `Couldn’t push: ${r.error.message}`);
  });
  document.getElementById('ghTakeRemote').addEventListener('click', () => {
    writeCatalogue(migrateCatalogue(remote.catalogue)); // adopts remote's pending plan too
    markClean(remote.sha);
    const note = localOnly.length ? ` Re-log as External: ${localOnly.map(sessionLabel).join('; ')}.` : '';
    go('settings');
    banner('good', `✓ Took GitHub’s copy.${note}`);
  });
}

// ── Log screen ──
function currentSrc() { return document.querySelector('input[name=src]:checked')?.value || 'external'; }

function screenLog() {
  const pending = getPending();
  view.innerHTML = `
    <div class="card">
      <strong>What are you logging?</strong>
      <div class="row" style="margin-top:8px">
        <label class="opt"><input type="radio" name="src" value="planned" ${pending ? 'checked' : 'disabled'} /> Planned session</label>
        <label class="opt"><input type="radio" name="src" value="external" ${pending ? '' : 'checked'} /> External session</label>
      </div>
      <p class="muted" id="srcHint"></p>
    </div>

    <div id="logBody"></div>

    <div class="card">
      <label>How did it go? (feeling, technique, cramps, "too easy", equipment…)</label>
      <textarea id="feedback" placeholder="e.g. left quad felt tight on the last rep; held 7 strokes; main set too easy"></textarea>
      <label class="opt" style="margin-top:10px"><input type="checkbox" id="completed" checked /> I completed the session fully</label>
      <button id="logBtn" class="block">Log session</button>
    </div>

    <div id="debrief"></div>

    <div class="card">
      <strong>Coaching review</strong>
      <p class="muted">For deeper analysis: download a block's data when it finishes, plus this one-time brief to set up your review project in Claude. Paste the brief into a Claude.ai Project, then feed it your block exports.</p>
      <button id="briefBtn" class="block secondary">⬇ Download coaching project brief</button>
    </div>`;

  [...document.querySelectorAll('input[name=src]')].forEach(r => r.addEventListener('change', renderLogBody));
  renderLogBody();
  document.getElementById('logBtn').addEventListener('click', submitLog);
  document.getElementById('briefBtn').addEventListener('click', downloadBrief);
}

async function downloadBrief() {
  try {
    const md = await fetch('../docs/coaching-project-brief.md').then(r => r.ok ? r.text() : Promise.reject(new Error(r.status)));
    downloadText('swim-coach-project-brief.md', md);
    banner('good', 'Brief downloaded — paste it into a Claude.ai Project.');
  } catch {
    banner('warn', 'Couldn’t load the brief (needs wifi the first time). Try again online.');
  }
}

function renderLogBody() {
  const pending = getPending();
  const src = currentSrc();
  const body = document.getElementById('logBody');
  const hint = document.getElementById('srcHint');

  if (src === 'planned' && pending?.session) {
    const s = pending.session;
    hint.innerHTML = `Logging your generated <strong>Block ${s.block_number} · Session ${s.session_in_block} — ${esc(s.subtype)}</strong> (${esc(s.type)}).`;
    body.innerHTML = s.type === 'dryland'
      ? `<p class="muted" style="padding:0 4px">Enter what you actually did — one box per set:</p>${buildDrylandPlannedForm(s)}`
      : `<div class="card"><strong>Pool data</strong><label>Garmin CSV (export from Garmin Connect)</label><input type="file" id="csvFile" /></div>`;
    return;
  }

  hint.textContent = 'External: a squad / coach / your-own session — subtype is inferred from the data (shown after logging).';
  body.innerHTML = `
    <div class="card">
      <div class="row">
        <label class="opt"><input type="radio" name="etype" value="pool" checked /> Pool</label>
        <label class="opt"><input type="radio" name="etype" value="dryland" /> Dryland</label>
      </div>
      <div id="extPool">
        <label>Garmin CSV (what you actually swam)</label>
        <input type="file" id="csvFile" />
        <label>…or no watch data? Describe the sets you did</label>
        <textarea id="poolDescribe" placeholder="e.g. 8×50 free @ 1:00, 4×100 pull, 200 cooldown"></textarea>
        <label>Session plan you were given (optional file)</label>
        <input type="file" id="extPoolPlan" />
      </div>
      <div id="extDry" class="hidden">
        <label>Your plan — what you intend to do (one per line, e.g. "Pull-ups 4x8")</label>
        <textarea id="extDryPlan" placeholder="Pull-ups 4x8&#10;Ring rows 4x10&#10;Hollow hold 3x25s"></textarea>
        <label>…or upload the dryland plan you were given (optional)</label>
        <input type="file" id="extDryFile" />
        <div id="extDryResults"></div>
      </div>
    </div>`;
  [...document.querySelectorAll('input[name=etype]')].forEach(r => r.addEventListener('change', () => {
    const t = document.querySelector('input[name=etype]:checked').value;
    document.getElementById('extPool').classList.toggle('hidden', t !== 'pool');
    document.getElementById('extDry').classList.toggle('hidden', t !== 'dryland');
  }));
  // External dryland: typing/uploading a plan renders per-exercise result boxes.
  const planArea = document.getElementById('extDryPlan');
  planArea.addEventListener('input', renderExtDryResults);
  document.getElementById('extDryFile').addEventListener('change', async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try { planArea.value = await f.text(); renderExtDryResults(); }
    catch { banner('warn', "Couldn't read that file as text — type the exercises instead."); }
  });
}

function renderExtDryResults() {
  const exercises = parseDrylandLines(document.getElementById('extDryPlan').value);
  const out = document.getElementById('extDryResults');
  out.innerHTML = exercises.length
    ? `<p class="muted" style="margin:10px 0 4px">Now enter what you ACTUALLY did per set:</p>${exerciseResultBoxes(exercises)}`
    : '';
}

// True for HOLD-style exercises (time-based). The previous heuristic used
// `/s\b/` which matched any plural ending in 's' — so "10-12 reps" was
// classified as a hold (the 's' in 'reps'). Now we only match:
// (a) "hold" / "holding" in the exercise NAME (e.g. "Hollow-body hold",
//     "Wall-sit holding dumbbells"), or
// (b) a digit IMMEDIATELY followed by 's' in the prescription (e.g. "30s",
//     "20-30s"), or
// (c) the word "sec"/"second(s)" in the prescription.
function isHoldExercise(e) {
  const name = String(e?.name ?? '');
  const presc = String(e?.prescription ?? '');
  return /\bhold(?:ing)?\b/i.test(name) ||
         /\d+\s*-?\s*\d*\s*s\b/i.test(presc) ||
         /\bsec(?:ond)?s?\b/i.test(presc);
}

// True for exercises that take an external load (dumbbells, kettlebells,
// barbells, goblet variants, "weighted X"). Surfaces a kg input per set.
function isWeightedExercise(e) {
  const name = String(e?.name ?? '').toLowerCase();
  return ['dumbbell', 'goblet', 'weighted', 'barbell', 'kettlebell'].some(kw => name.includes(kw));
}

// Per-exercise actual-result boxes for an external dryland plan (flat list).
function exerciseResultBoxes(exercises) {
  return exercises.map((e, ei) => {
    const sets = e.sets || 1;
    const unit = isHoldExercise(e) ? 's' : 'reps';
    const weighted = isWeightedExercise(e);
    const planned = e.prescription || (e.reps_per_set != null ? `${e.reps_per_set} reps` : '');
    const repBoxes = Array.from({ length: sets }, (_, s) =>
      `<input type="text" class="exbox" data-ei="${ei}" data-unit="${unit}" inputmode="numeric" placeholder="S${s + 1}" />`).join('');
    const weightBoxes = weighted ? Array.from({ length: sets }, (_, s) =>
      `<input type="text" class="exweight" data-ei="${ei}" inputmode="decimal" placeholder="S${s + 1} kg" />`).join('') : '';
    const weightRow = weighted ? `<div class="row setrow"><span class="muted" style="min-width:70px">Weight kg</span>${weightBoxes}</div>` : '';
    const repLabelPrefix = weighted ? '<span class="muted" style="min-width:70px">Actual</span>' : '';
    return `<label>${esc(e.name)} <span class="muted">(planned ${sets}×${esc(planned)} — actual ${unit}${weighted ? ' + weight' : ''})</span></label>` +
           `<div class="row setrow">${repLabelPrefix}${repBoxes}</div>${weightRow}`;
  }).join('');
}

function collectExerciseResults(exercises) {
  return exercises.map((e, ei) => {
    const boxes = [...document.querySelectorAll(`.exbox[data-ei="${ei}"]`)];
    const vals = boxes.map(x => x.value.trim()).filter(v => v !== '').map(Number).filter(n => !Number.isNaN(n));
    const unit = boxes[0]?.dataset.unit;
    const ex = { name: e.name, sets: vals.length || (e.sets || 0), planned: e.prescription || e.reps_per_set };
    if (unit === 's') ex.duration_s_per_set = vals; else ex.reps_per_set = vals;
    if (isWeightedExercise(e)) {
      const wBoxes = [...document.querySelectorAll(`.exweight[data-ei="${ei}"]`)];
      const wVals = wBoxes.map(x => x.value.trim()).filter(v => v !== '').map(Number).filter(n => !Number.isNaN(n));
      if (wVals.length) ex.weight_kg_per_set = wVals;
    }
    return ex;
  });
}

// Structured per-set form for a planned dryland session.
function buildDrylandPlannedForm(session) {
  return (session.blocks || []).map((b, bi) => {
    const note = b.note ? `<p class="muted">${esc(b.note)}</p>` : '';
    const exs = (b.exercises || []).map((e, ei) => {
      const sets = e.sets || 1;
      const unit = isHoldExercise(e) ? 's' : 'reps';
      const weighted = isWeightedExercise(e);
      const presc = e.prescription || (e.reps_per_set ? `${e.reps_per_set} reps` : '');
      const repBoxes = Array.from({ length: sets }, (_, s) =>
        `<input type="text" class="setbox" data-bi="${bi}" data-ei="${ei}" data-unit="${unit}" inputmode="numeric" placeholder="S${s + 1}" />`).join('');
      const weightBoxes = weighted ? Array.from({ length: sets }, (_, s) =>
        `<input type="text" class="setweight" data-bi="${bi}" data-ei="${ei}" inputmode="decimal" placeholder="S${s + 1} kg" />`).join('') : '';
      const weightRow = weighted ? `<div class="row setrow"><span class="muted" style="min-width:70px">Weight kg</span>${weightBoxes}</div>` : '';
      const repLabelPrefix = weighted ? '<span class="muted" style="min-width:70px">Actual</span>' : '';
      return `<label>${esc(e.name)} <span class="muted">(${sets}×${esc(presc)}, ${unit}${weighted ? ' + weight' : ''})</span></label>` +
             `<div class="row setrow">${repLabelPrefix}${repBoxes}</div>${weightRow}`;
    }).join('');
    return `<div class="card"><strong>${esc(b.name)}</strong>${note}${exs}</div>`;
  }).join('');
}

function collectDrylandPlannedForm(session) {
  const exercises = [];
  (session.blocks || []).forEach((b, bi) => {
    (b.exercises || []).forEach((e, ei) => {
      const boxes = [...document.querySelectorAll(`.setbox[data-bi="${bi}"][data-ei="${ei}"]`)];
      const vals = boxes.map(x => x.value.trim()).filter(v => v !== '').map(Number).filter(n => !Number.isNaN(n));
      const unit = boxes[0]?.dataset.unit;
      const ex = { name: e.name, sets: vals.length || (e.sets || 0), planned: e.prescription || e.reps_per_set };
      if (unit === 's') ex.duration_s_per_set = vals; else ex.reps_per_set = vals;
      if (isWeightedExercise(e)) {
        const wBoxes = [...document.querySelectorAll(`.setweight[data-bi="${bi}"][data-ei="${ei}"]`)];
        const wVals = wBoxes.map(x => x.value.trim()).filter(v => v !== '').map(Number).filter(n => !Number.isNaN(n));
        if (wVals.length) ex.weight_kg_per_set = wVals;
      }
      exercises.push(ex);
    });
  });
  return { exercises };
}

function parseDrylandLines(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(.*?)\s+(\d+)\s*[x×]\s*([\d.]+)\s*(s|sec)?$/i);
    if (m) {
      const isHold = !!m[4];
      const ex = { name: m[1].trim(), sets: Number(m[2]) };
      if (isHold) ex.prescription = `${m[3]}s`; else ex.reps_per_set = Number(m[3]);
      return ex;
    }
    return { name: line };
  });
}

async function submitLog() {
  const btn = document.getElementById('logBtn');
  btn.disabled = true;
  clearBanner();
  const pending = getPending();
  const src = currentSrc();
  const completed = document.getElementById('completed').checked;
  let feedback = document.getElementById('feedback').value.trim();
  if (!completed) feedback = `Didn't finish the session fully. ${feedback}`.trim();

  try {
    const catalogue = await loadCatalogue();
    const input = { feedbackText: feedback || undefined, date: new Date().toISOString().slice(0, 10) };
    let isPlanned = false;

    if (src === 'planned' && pending?.session) {
      isPlanned = true;
      const s = pending.session;
      input.source = 'app_generated';
      input.type = s.type;
      input.subtype = s.subtype;
      input.planned = s; // keep the prescribed plan on the record (for block analysis export)
      if (s.type === 'pool') {
        const file = document.getElementById('csvFile')?.files?.[0];
        if (!file) { banner('bad', 'Add the Garmin CSV for this pool session.'); btn.disabled = false; return; }
        input.parsed = parseGarminCsv(await file.text());
      } else {
        input.dryland = collectDrylandPlannedForm(s);
      }
    } else {
      input.source = 'external';
      const t = document.querySelector('input[name=etype]:checked')?.value || 'pool';
      input.type = t;
      const notes = [];
      if (t === 'pool') {
        const file = document.getElementById('csvFile')?.files?.[0];
        if (file) input.parsed = parseGarminCsv(await file.text());
        const desc = document.getElementById('poolDescribe')?.value.trim();
        if (desc) notes.push(`Sets: ${desc}`);
        // Optional: the prescribed external session plan (a file you were given).
        const planFile = document.getElementById('extPoolPlan')?.files?.[0];
        if (planFile) {
          try { notes.push(`Plan (${planFile.name}): ${(await planFile.text()).slice(0, 1500)}`); }
          catch { notes.push(`Plan file attached: ${planFile.name}`); }
        }
        if (!file && !desc) { banner('bad', 'Add the Garmin CSV, or describe the sets you did.'); btn.disabled = false; return; }
      } else {
        // External dryland: actual results from the per-exercise boxes.
        const planText = document.getElementById('extDryPlan')?.value || '';
        const exercises = parseDrylandLines(planText);
        input.dryland = { exercises: collectExerciseResults(exercises) };
        if (planText.trim()) notes.push(`Planned: ${planText.trim().replace(/\n/g, '; ')}`);
        const planFile = document.getElementById('extDryFile')?.files?.[0];
        if (planFile) notes.push(`Plan file: ${planFile.name}`);
      }
      if (notes.length) input.notes = notes.join(' | ');
    }

    // Duplicate guard: if an existing session matches this one (same date +
    // type, and for a pool session a near-identical total distance), warn
    // before logging a second copy. This catches the "logged the planned
    // session, then logged the same CSV again as External" pattern.
    {
      const today = new Date().toISOString().slice(0, 10);
      const candDate = input.date ?? today;
      const candDist = input.parsed?.summary?.total_distance_m ?? null;
      const dup = (catalogue.sessions ?? []).find(s =>
        s?.date === candDate && s?.type === input.type &&
        (input.type !== 'pool' ||
          (candDist != null && s.distance_m != null && Math.abs(s.distance_m - candDist) <= 25)));
      if (dup) {
        const distBit = dup.distance_m != null ? `, ${dup.distance_m} m` : '';
        if (!confirm(`A ${input.type} session is already logged for ${candDate} (id ${dup.id}${distBit}). Log this as a separate session anyway?`)) {
          btn.disabled = false;
          return;
        }
      }
    }
    const r = logSession(catalogue, input);
    saveCatalogue(r.catalogue);
    if (isPlanned) clearPending(); // unblocks generating the next session
    renderDebrief(r);
    if (r.block_completed) showBlockFinished(r.catalogue, r.completed_block_number);
    banner('good', 'Session logged.' + (r.block_completed ? ` 🎉 Block ${r.completed_block_number} complete!` : (isPlanned ? ' You can generate the next session now.' : '')));
  } catch (e) {
    banner('bad', `Error: ${e?.message ?? e}`);
  } finally {
    btn.disabled = false;
  }
}

function renderDebrief(r) {
  const recs = Object.entries(r.records || {});
  const flags = r.flags || [];
  const inf = r.subtype_inference;
  const sig = r.signals || {};
  const expiring = r.expiring_flags || [];
  const activeNow = Object.keys(r.catalogue?.active_flags || {});
  const adj = [];
  if (sig.recovery_tilt) adj.push('next session tilts toward recovery');
  if (sig.intensity && sig.intensity !== 'normal') adj.push(`intensity → ${sig.intensity}`);
  if (sig.equipment) adj.push(`equipment → ${sig.equipment}`);
  if (sig.technique_focus?.length) adj.push(`focus → ${sig.technique_focus.join(', ')}`);

  const expiringHtml = expiring.length ? `
    <h3>🩹 Flags that may no longer apply</h3>
    <p class="muted">These haven't recurred for a while. Remove them, or keep them active if you're still cautious.</p>
    ${expiring.map(f => `
      <div class="row" style="justify-content:space-between; margin:6px 0">
        <span>${esc(humanizeFlag(f))}</span>
        <span class="row">
          <button class="secondary flagBtn" data-flag="${esc(f)}" data-action="remove">Remove</button>
          <button class="secondary flagBtn" data-flag="${esc(f)}" data-action="keep">Keep active</button>
        </span>
      </div>`).join('')}` : '';

  document.getElementById('debrief').innerHTML = `
    <div class="card session">
      <h2>Logged: Session ${r.session.id} — ${esc(r.session.subtype)}</h2>
      ${inf ? `<p class="muted">Inferred subtype: <strong>${esc(inf.subtype)}</strong> (${esc(inf.confidence)} — ${esc(inf.reason)})</p>` : ''}
      <h3>🏆 Records</h3>
      ${recs.length ? `<ul>${recs.map(([k, v]) => `<li>${esc(k)}: <strong>${esc(v)}</strong></li>`).join('')}</ul>` : '<p class="muted">No new records.</p>'}
      <h3>🚩 Coach flags</h3>
      ${flags.length ? `<ul>${flags.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="muted">None.</p>'}
      ${adj.length ? `<h3>⏭ Next-session adjustments</h3><ul>${adj.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
      ${expiringHtml}
      ${activeNow.length ? `<p class="muted">Active flags now: ${activeNow.map(f => esc(humanizeFlag(f))).join(', ')}</p>` : ''}
    </div>`;

  // Wire flag-resolution buttons.
  document.querySelectorAll('.flagBtn').forEach(b => b.addEventListener('click', async () => {
    const flag = b.dataset.flag, action = b.dataset.action;
    const cat = await loadCatalogue();
    saveCatalogue(resolveFlag(cat, flag, action));
    b.closest('.row').innerHTML = `<span class="muted">${esc(humanizeFlag(flag))} — ${action === 'remove' ? 'removed' : 'kept active'}</span>`;
  }));
}

// Render plain-prose / lightly-bulleted analysis text to HTML.
function textBlocksToHtml(text) {
  return String(text || '').split(/\n{2,}/).map(block => {
    const lines = block.split('\n');
    if (lines.every(l => /^\s*-\s/.test(l))) {
      return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*-\s/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

// ── Feedback screen — LLM analysis of the most recent logged session ──
async function screenFeedback() {
  const catalogue = await loadCatalogue();
  const last = catalogue.sessions?.[0];
  if (!last) {
    view.innerHTML = `<div class="card"><strong>Session feedback</strong><p class="muted">Log a session first — your most recent session's coaching feedback will appear here.</p></div>`;
    return;
  }
  const cacheKey = `${K.analysisPrefix}${last.id}`;
  const cached = localStorage.getItem(cacheKey);

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <strong>Feedback — Session ${last.id} (${esc(last.subtype)})</strong>
        <span class="pill">${localStorage.getItem(K.geminiKey) ? 'Gemini' : 'offline summary'}</span>
      </div>
      <p class="muted">Coaching debrief on your most recent session — performance and your notes.</p>
      <button id="analyzeBtn" class="block">${cached ? '↻ Re-analyze (needs wifi)' : 'Analyze this session'}</button>
    </div>
    <div id="analysisOut">${cached ? `<div class="card session">${mdToHtml(JSON.parse(cached).text)}</div>` : ''}</div>`;

  document.getElementById('analyzeBtn').addEventListener('click', () => runAnalysis(last.id));
  if (!cached) runAnalysis(last.id); // auto-run first time
}

async function runAnalysis(sessionId) {
  const out = document.getElementById('analysisOut');
  const btn = document.getElementById('analyzeBtn');
  if (btn) btn.disabled = true;
  out.innerHTML = `<div class="card spinner">Analyzing…</div>`;
  clearBanner();
  try {
    const catalogue = await loadCatalogue();
    const apiKey = localStorage.getItem(K.geminiKey) || undefined;
    const model = localStorage.getItem(K.model) || undefined;
    let knowledge;
    try { knowledge = await fetch('../knowledge/swimming-coaching-kb.md').then(r => r.ok ? r.text() : undefined); } catch { /* optional */ }

    const r = await analyzeSession(catalogue, { apiKey, model, knowledge });
    if (r.source === 'llm') banner('good', '✓ Coaching debrief by Gemini.');
    else if (r.reason === 'no_llm') banner('warn', 'Offline summary (add a Gemini key in Settings + wifi for a full debrief).');
    else if (r.reason) bannerForFallback({ fallback_reason: r.reason, retry_after_seconds: r.error?.retry_after_seconds, retry_after_iso: r.error?.retry_after_iso, message: r.error?.message });
    localStorage.setItem(`${K.analysisPrefix}${sessionId}`, JSON.stringify({ text: r.text, source: r.source, at: Date.now() }));
    out.innerHTML = `<div class="card session">${mdToHtml(r.text)}</div>`;
  } catch (e) {
    banner('bad', `Error: ${e?.message ?? e}`);
    out.innerHTML = '';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Graphs screen — Chart.js line charts of key markers over time ──
// Self-hosted UMD build (was a CDN ESM import) so charts work offline / when
// installed. Loaded lazily via a <script> tag; exposes the global `Chart`.
let ChartLib = null;
const CHART_SRC = './vendor/chart.umd.js';

function loadChart() {
  if (ChartLib) return Promise.resolve(ChartLib);
  if (window.Chart) { ChartLib = window.Chart; return Promise.resolve(ChartLib); }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CHART_SRC;
    s.onload = () => { ChartLib = window.Chart; ChartLib ? resolve(ChartLib) : reject(new Error('Chart global missing after load')); };
    s.onerror = () => reject(new Error('Failed to load chart.umd.js'));
    document.head.appendChild(s);
  });
}

async function screenGraphs() {
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <strong>Performance trends</strong>
        <button id="refreshGraphs" class="secondary">↻ Refresh</button>
      </div>
      <p class="muted">Key markers the coach tracks, over time. Charts load from the web, so they need wifi the first time.</p>
    </div>
    <div id="charts"></div>`;
  document.getElementById('refreshGraphs').addEventListener('click', renderGraphs);
  renderGraphs();
}

let chartInstances = [];
async function renderGraphs() {
  const charts = document.getElementById('charts');
  charts.innerHTML = `<div class="card spinner">Loading charts…</div>`;
  clearBanner();
  chartInstances.forEach(c => { try { c.destroy(); } catch { /* */ } });
  chartInstances = [];

  let Chart;
  try { Chart = await loadChart(); }
  catch {
    charts.innerHTML = `<div class="card"><p class="muted">Couldn't load the charting library — you may be offline. Reconnect and tap ↻ Refresh.</p></div>`;
    banner('warn', '📡 Charts need wifi to load the first time.');
    return;
  }

  const catalogue = await loadCatalogue();
  const series = trendSeries(catalogue);
  if (!series.length) {
    charts.innerHTML = `<div class="card"><p class="muted">No pool-session data yet. Log some sessions and refresh.</p></div>`;
    return;
  }

  charts.innerHTML = series.map(s =>
    `<div class="card"><strong>${esc(s.label)}${s.unit ? ` (${esc(s.unit)})` : ''}</strong>
     <span class="muted" style="font-size:12px"> · ${s.lowerIsBetter ? 'lower is better' : 'higher is better'}</span>
     <div class="chartwrap"><canvas id="chart_${s.key}"></canvas></div></div>`).join('');

  const css = getComputedStyle(document.body);
  const accent = css.getPropertyValue('--accent').trim() || '#2f9be0';
  const ink = css.getPropertyValue('--muted').trim() || '#9bb0c2';
  const grid = css.getPropertyValue('--border').trim() || '#28333f';

  for (const s of series) {
    const ctx = document.getElementById(`chart_${s.key}`);
    const inst = new Chart(ctx, {
      type: 'line',
      data: {
        labels: s.points.map(p => p.date.slice(5)), // MM-DD
        datasets: [{
          data: s.points.map(p => p.value),
          borderColor: accent, backgroundColor: accent + '33',
          tension: 0.25, pointRadius: 3, fill: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: ink }, grid: { color: grid } },
          y: { ticks: { color: ink }, grid: { color: grid } },
        },
      },
    });
    chartInstances.push(inst);
  }
}

// ── History screen — rolling bests + session list (read-only) ──
function sessionKeyMetric(s) {
  if (s.type === 'dryland') return 'dryland';
  const m = s.metrics || {};
  if (m.best_25m_split_s != null) return `25m ${m.best_25m_split_s}s · SWOLF ${m.avg_swolf ?? '—'}`;
  if (m.avg_pace_per_100m) return `pace ${m.avg_pace_per_100m}`;
  return `${s.distance_m || '?'}m`;
}

async function screenHistory() {
  const cat = await loadCatalogue();
  const rb = cat.rolling_bests ?? {};
  const sessions = cat.sessions ?? [];
  const flags = Object.keys(cat.active_flags ?? {});
  const bestRows = [
    ['Best 25m sprint', rb.best_25m_sprint_protocol_s, 's'],
    ['Best avg SWOLF', rb.best_avg_swolf, ''],
    ['Best sprint SWOLF', rb.best_sprint_swolf, ''],
    ['Best avg pace /100m', rb.best_avg_pace_per_100m, ''],
    ['Best threshold pace /100m', rb.best_threshold_pace_per_100m, ''],
    ['Best 50m equiv', rb.best_50m_equiv_s, 's'],
  ].filter(r => r[1] != null);

  view.innerHTML = `
    <div class="card">
      <strong>Rolling bests</strong>
      <table><tbody>${bestRows.map(([l, v, u]) => `<tr><td>${esc(l)}</td><td style="text-align:right"><strong>${esc(v)}${u}</strong></td></tr>`).join('')}</tbody></table>
    </div>
    ${flags.length ? `<div class="card"><strong>Active flags</strong><p>${flags.map(f => esc(humanizeFlag(f))).join(', ')}</p></div>` : ''}
    <div class="card session">
      <strong>Sessions (${sessions.length})</strong>
      <table>
        <thead><tr><th>Date</th><th>Type</th><th>Key result</th><th></th></tr></thead>
        <tbody>${sessions.map(s => `<tr>
          <td>${esc(s.date)}</td>
          <td>${esc(s.subtype || s.type)}</td>
          <td>${esc(sessionKeyMetric(s))}</td>
          <td>${s.source === 'external' ? '<span class="pill">ext</span>' : ''}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function screenStub(name) {
  view.innerHTML = `<div class="card"><strong>${name}</strong><p class="muted">Coming in the next slice.</p></div>`;
}

// ── Router ──
const screens = {
  today: screenToday,
  log: screenLog,
  feedback: screenFeedback,
  graphs: screenGraphs,
  history: screenHistory,
  settings: screenSettings,
};
function go(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.screen === name));
  clearBanner();
  (screens[name] || screenToday)();
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.screen)));

// Header sync pill — reflects sync state (or DEMO); tap to open Settings.
const syncEl = document.getElementById('syncState');
syncEl?.addEventListener('click', () => go('settings'));
updateSyncPill();

go('today');
if (DEMO) banner('warn', '🧪 Demo mode — fake data for preview. Your real catalogue is untouched.');
else maybeAutoPull(); // adopt the latest from GitHub on open (when configured + clean)

// Register the service worker for offline use. Resolve its URL relative to this
// module (…/web/app.js → …/sw.js) rather than hard-coding `/sw.js`, so it works
// whether the app is served from the domain root (Cloudflare/user.github.io) or
// a project sub-path (user.github.io/swim-coach/). Its scope is the app root,
// covering both /web/ (shell) and /src/ (engine modules) — see sw.js.
if ('serviceWorker' in navigator) {
  const swUrl = new URL('../sw.js', import.meta.url);
  window.addEventListener('load', () => { navigator.serviceWorker.register(swUrl).catch(() => { /* SW optional */ }); });
}
