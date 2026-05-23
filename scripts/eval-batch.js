// Training-camp self-play eval.
//
// Runs the REAL engine (deterministic core + Gemini if a key is set) through a
// 10-step self-play: generate a session → synthesise a realistic performance →
// log it → generate feedback → repeat, with the catalogue evolving each step.
// Writes ONE markdown file (10 plan/performance/feedback triples) to hand to a
// Claude project for grading (see docs/eval-grading-brief.md).
//
// SAFETY: this script is READ-ONLY w.r.t. your data. It loads web/seed-catalogue.json
// as a starting point, runs the whole simulation on an in-memory clone, and writes
// ONLY the eval output file. It never saves the catalogue, never touches
// localStorage, and never imports/uses git or the sync module.
//
// Run:
//   node scripts/eval-batch.js                         # fallback engine (no LLM)
//   GEMINI_API_KEY=... node scripts/eval-batch.js      # real Gemini generation + feedback
//   GEMINI_API_KEY=... node scripts/eval-batch.js 10 ./out.md   # count + output path

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { migrateCatalogue } from '../src/schema.js';
import { generateSession } from '../src/orchestrator.js';
import { parseGarminCsv } from '../src/garmin-parser.js';
import { logSession } from '../src/catalogue-writer.js';
import { analyzeSession } from '../src/session-analysis.js';
import { renderSessionMarkdown } from '../src/renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const COUNT = Number(process.argv[2]) || 10;
const OUT = process.argv[3] || join(ROOT, 'eval-output', `training-camp-${new Date().toISOString().slice(0, 10)}.md`);
const apiKey = process.env.GEMINI_API_KEY || undefined;
const model = process.env.GEMINI_MODEL || undefined;

// ── Performance synthesis ──────────────────────────────────────────────────
// Turn a prescribed plan into a realistic Garmin CSV, then parse it with the
// REAL parser so the performance flows through the engine exactly as a logged
// session would. Numbers derive from the athlete's level + the set's effort,
// with a small per-session improvement trend and per-rep noise.

function base25mForEffort(effort = '') {
  const e = String(effort).toLowerCase();
  if (/max|sprint/.test(e)) return 17.4;
  if (/near|race/.test(e)) return 18.6;
  if (/build|priming/.test(e)) return 21.0;
  if (/threshold|moderate|smooth|tempo/.test(e)) return 23.5;
  if (/drill/.test(e)) return 26.0;
  return 27.5; // easy / recovery / cool-down
}
function strokesForEffort(effort = '') {
  const e = String(effort).toLowerCase();
  if (/max|sprint|near|race/.test(e)) return 8;
  if (/drill/.test(e)) return 6;
  return 9;
}
function hrForEffort(effort = '') {
  const e = String(effort).toLowerCase();
  if (/max|sprint|near|race/.test(e)) return [168, 178];
  if (/build|priming/.test(e)) return [150, 162];
  if (/threshold|moderate|smooth|tempo/.test(e)) return [148, 160];
  return [120, 140];
}
const jitter = (pct) => 1 + (Math.random() * 2 - 1) * pct;
function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

// Build a Garmin-style CSV from the session's blocks. Trend: later sessions a
// touch faster (improvement); idx is 0-based session number.
function synthesizeCsv(session, idx) {
  const HEADER = '"","Intervals","Swim Stroke","Lengths","Distance","Time","Cumulative Time","Avg Pace","Best Pace","Avg. Swolf","Avg HR","Max HR","Total Strokes","Avg Strokes","Calories"';
  const rows = [HEADER];
  const trend = 1 - 0.004 * idx;
  let intNo = 0;
  let cum = 0;
  const restCol = (t) => `"","","Rest","--","--","${fmtTime(t)}","${fmtTime(cum)}","--","--","--","--","--","--","--","--"`;

  const swimSets = [];
  for (const b of session.blocks ?? []) {
    for (const s of b.sets ?? []) {
      if (s.distance_m && s.reps) swimSets.push(s);
    }
  }
  swimSets.forEach((s, si) => {
    const lengthsPerRep = Math.max(1, Math.round(s.distance_m / 25));
    const isDrill = /drill/i.test(s.effort || '') || !!s.drill;
    for (let r = 0; r < s.reps; r++) {
      intNo += 1;
      const lenRows = [];
      let repTime = 0, repStrokes = 0;
      const lengthTimes = [];
      for (let L = 1; L <= lengthsPerRep; L++) {
        // Realistic shape: the first length of each rep is slowest off the wall
        // (the athlete's known push-off weakness), then a touch of fatigue per
        // later length. This makes the first-length gap actually present (so the
        // feedback can be fairly graded on it) and keeps multi-length reps from
        // being implausibly fast.
        const pushOff = L === 1 ? 1.10 : 1.0;
        const fatigue = 1 + 0.025 * Math.max(0, L - 1);
        const base = base25mForEffort(s.effort) * trend * pushOff * fatigue * jitter(0.02);
        const t = Math.round(base * 10) / 10;
        const strokes = strokesForEffort(s.effort) + (Math.random() < 0.3 ? 1 : 0);
        lengthTimes.push(t); repTime += t; repStrokes += strokes;
        lenRows.push(`"","${intNo}.${L}","${isDrill ? 'Drill' : 'Unknown'}","--","25","${fmtTime(t)}","--","--","--","--","--","--","${strokes}","--","--"`);
      }
      repTime = Math.round(repTime * 10) / 10;
      cum += repTime;
      const avgStrokes = (repStrokes / lengthsPerRep).toFixed(1);
      const swolf = Math.round(repTime / lengthsPerRep + repStrokes / lengthsPerRep);
      const [hrLo, hrHi] = hrForEffort(s.effort);
      const avgHr = Math.round(hrLo + Math.random() * (hrHi - hrLo));
      const maxHr = Math.min(190, avgHr + 8);
      rows.push(`"","${intNo}","${isDrill ? 'Drill' : 'Unknown'}","${lengthsPerRep}","${s.distance_m}","${fmtTime(repTime)}","${fmtTime(cum)}","--","--","${isDrill ? '--' : swolf}","${avgHr}","${maxHr}","${repStrokes}","${avgStrokes}","3"`);
      rows.push(...lenRows);
      // Rest after the rep (skip after the very last rep of the last set).
      const lastRep = (si === swimSets.length - 1) && (r === s.reps - 1);
      const rest = s.rest_s ?? 0;
      if (!lastRep && rest > 0) { cum += rest; rows.push(restCol(rest)); }
    }
  });
  return rows.join('\n');
}

// Dryland: synthesise actual reps near the prescription with a fatigue dropoff.
function synthesizeDryland(session) {
  const exercises = [];
  for (const b of session.blocks ?? []) {
    for (const e of b.exercises ?? []) {
      const sets = e.sets || 3;
      const m = String(e.prescription ?? e.reps_per_set ?? '10').match(/\d+/);
      const baseReps = m ? Number(m[0]) : 10;
      const isHold = /s\b|sec|hold/i.test(e.prescription || '') || /hold/i.test(e.name || '');
      const vals = Array.from({ length: sets }, (_, i) => Math.max(1, Math.round(baseReps * (1 - 0.08 * i) * jitter(0.05))));
      const ex = { name: e.name, sets, planned: e.prescription ?? e.reps_per_set };
      if (isHold) ex.duration_s_per_set = vals; else ex.reps_per_set = vals;
      exercises.push(ex);
    }
  }
  return { exercises };
}

// ── One self-play step ──────────────────────────────────────────────────────
async function runStep(catalogue, idx, knowledge) {
  const gen = await generateSession(catalogue, { apiKey, model, knowledge });
  const session = gen.session;
  const planMd = renderSessionMarkdown(session);

  const input = { source: 'app_generated', type: session.type, subtype: session.subtype, planned: session };
  let perfNote;
  if (session.type === 'pool') {
    const csv = synthesizeCsv(session, idx);
    input.parsed = parseGarminCsv(csv);
    const s = input.parsed.summary;
    perfNote = `pool ${s.total_distance_m}m · best 25m ${s.best_25m_split_s}s · avg SWOLF ${s.avg_swolf} · avg pace ${s.avg_pace_per_100m} · maxHR ${s.max_hr}`;
  } else {
    input.dryland = synthesizeDryland(session);
    perfNote = `dryland · ${input.dryland.exercises.length} exercises`;
  }
  // No athlete note — a synthetic placeholder here made the feedback "respond"
  // to a fake journal entry. Leave notes empty (a real athlete may add one).

  const logged = logSession(catalogue, input);
  const loggedSession = logged.catalogue.sessions[0];
  const analysis = await analyzeSession(logged.catalogue, { apiKey, model, knowledge });

  return {
    catalogue: logged.catalogue,
    record: {
      idx: idx + 1,
      block: session.block_number, session_in_block: session.session_in_block,
      type: session.type, subtype: session.subtype,
      gen_source: gen.source, gen_status: gen.status, fallback_reason: gen.fallback_reason ?? null,
      planMd, perfNote,
      metrics: loggedSession.metrics, breakdown: loggedSession.breakdown, dryland: loggedSession.dryland,
      flags: logged.flags, records: logged.records,
      feedback_source: analysis.source, feedback: analysis.text,
    },
  };
}

// The COMPLETE per-interval data the feedback engine received — so the grader
// can tell "used the data" from "fabricated" (the previous one-line summary
// made legitimate per-rep tables look invented).
function perfDetail(r) {
  if (Array.isArray(r.breakdown) && r.breakdown.length) {
    const rows = ['', '| INT | Dist | Time | SWOLF | avgHR | maxHR | Rest | Per-length splits (s) |', '|---|---|---|---|---|---|---|---|'];
    for (const b of r.breakdown) {
      const splits = (b.splits_s ?? []).filter(x => x != null).join(' / ');
      rows.push(`| ${b.n}${b.is_drill ? ' (drill)' : ''} | ${b.distance_m}m | ${b.time_s ?? '—'}s | ${b.swolf ?? '—'} | ${b.avg_hr ?? '—'} | ${b.max_hr ?? '—'} | ${b.rest_after_s ? Math.round(b.rest_after_s) + 's' : '—'} | ${splits || '—'} |`);
    }
    return rows.join('\n');
  }
  if (r.dryland?.exercises?.length) {
    return '\n' + r.dryland.exercises.map(e => {
      const v = e.reps_per_set ?? e.duration_s_per_set ?? [];
      return `- ${e.name}: ${Array.isArray(v) ? v.join(' / ') : v}`;
    }).join('\n');
  }
  return '\n_(no per-interval data — nothing for the feedback to analyse)_';
}

function recordToMarkdown(r) {
  const out = [];
  out.push(`## Session ${r.idx} — Block ${r.block}, session ${r.session_in_block} · ${r.type}/${r.subtype}`);
  out.push(`*Plan by: **${r.gen_source}** (${r.gen_status}${r.fallback_reason ? `, ${r.fallback_reason}` : ''}) · Feedback by: **${r.feedback_source}***`);
  out.push('', '### Prescribed plan', r.planMd);
  out.push('', '### Synthesised performance — COMPLETE data the feedback engine received', r.perfNote, perfDetail(r));
  out.push('', '### Engine records this session (the ONLY records feedback may report)',
    (r.records && Object.keys(r.records).length) ? Object.entries(r.records).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- none');
  if (r.flags?.length) out.push('', '### Engine flags', r.flags.map(f => `- ${f}`).join('\n'));
  out.push('', '### Generated feedback', r.feedback);
  return out.join('\n');
}

async function main() {
  const seed = JSON.parse(readFileSync(join(ROOT, 'web', 'seed-catalogue.json'), 'utf8'));
  let catalogue = migrateCatalogue(seed); // in-memory only
  let knowledge;
  try { knowledge = readFileSync(join(ROOT, 'knowledge', 'swimming-coaching-kb.md'), 'utf8'); } catch { /* optional */ }

  const mode = apiKey ? `Gemini (${model || 'default model'})` : 'FALLBACK (no GEMINI_API_KEY — deterministic engine only)';
  console.log(`Training-camp eval: ${COUNT} sessions · engine: ${mode}`);

  const records = [];
  for (let i = 0; i < COUNT; i++) {
    process.stdout.write(`  session ${i + 1}/${COUNT}…`);
    const { catalogue: next, record } = await runStep(catalogue, i, knowledge);
    catalogue = next;
    records.push(record);
    console.log(` ${record.type}/${record.subtype} [plan:${record.gen_source}, fb:${record.feedback_source}]`);
    // Quota probe: if Gemini's daily limit is hit (e.g. not reset yet), stop —
    // a real eval needs Gemini, and continuing would just produce fallbacks.
    if (record.fallback_reason === 'rate_limit_daily') {
      console.log('  ⛔ Gemini daily quota reached (not reset) — stopping early. Re-run after the Pacific-midnight reset.');
      break;
    }
  }

  const header = [
    `# Swim Coach — training-camp eval (${new Date().toISOString().slice(0, 10)})`,
    `Engine: ${mode}. ${COUNT} self-play sessions (generate → synthetic performance → feedback), catalogue evolving each step.`,
    '',
    '> For the grader: assess **session-creation** quality (the prescribed plans — appropriate for phase/targets/safety/variety/equipment?) and **session-feedback** quality (accurate, specific, useful?). Note: performances are *synthetic*, so judge the coaching logic, not the athlete. Return your feedback file per `docs/eval-grading-brief.md`.',
    '',
    '---',
  ].join('\n');

  const body = records.map(recordToMarkdown).join('\n\n---\n\n');
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${header}\n\n${body}\n`, 'utf8');
  console.log(`\nWrote ${records.length} sessions → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
