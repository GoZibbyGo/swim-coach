// Generates a rich DEMO catalogue (fake logged sessions with improving trends)
// for the ?demo preview mode. Writes web/seed-catalogue.demo.json.
// Run: node scripts/make-demo.js
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fmtPace(sec) { const m = Math.floor(sec / 60); return `${m}:${String(Math.round(sec - m * 60)).padStart(2, '0')}`; }
function r1(n) { return Math.round(n * 10) / 10; }
function r2(n) { return Math.round(n * 100) / 100; }
function addDays(iso, d) { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }

const poolCycle = ['sprint', 'technique', 'threshold'];
const feedbacks = [
  'felt strong, held 7 strokes most reps',
  'main set was a touch easy',
  'breathing held the whole cool-down',
  'legs a bit heavy but pushed through',
  'left quad felt tight on the last rep',
  'really focused today, good rhythm',
  'crowded pool, rest intervals a bit off',
  '',
];

// A plausible per-interval breakdown for a demo pool session.
function demoBreakdown(subtype, m, paceSec) {
  const rows = [];
  let n = 1;
  const j = () => (Math.random() - 0.5);
  // Warm-up: 4×100
  rows.push({ n: n++, stroke: 'Unknown', is_drill: false, distance_m: 100, time_s: r1(paceSec * 4 + 8),
    swolf: m.avg_swolf + 3, avg_hr: 120, max_hr: 138, avg_strokes: 10, rest_after_s: 15,
    splits_s: [r1(paceSec + 4 + j()), r1(paceSec + 6 + j()), r1(paceSec + 5 + j()), r1(paceSec + 5 + j())] });
  // Drill block: 8×25 (one interval)
  rows.push({ n: n++, stroke: 'Drill', is_drill: true, distance_m: 200, time_s: r1(8 * 22),
    swolf: 0, avg_hr: 130, max_hr: 140, avg_strokes: 0, rest_after_s: 25, splits_s: [] });
  if (subtype === 'threshold') {
    for (let i = 0; i < 5; i++) {
      const t = r1(paceSec * 8 + 6 + i * 4 + j() * 2);
      rows.push({ n: n++, stroke: 'Unknown', is_drill: false, distance_m: 200, time_s: t,
        swolf: m.avg_swolf + (i > 2 ? 2 : 1), avg_hr: 145 + i, max_hr: 152 + i, avg_strokes: 11, rest_after_s: 40, splits_s: [] });
    }
  } else if (subtype === 'technique') {
    for (let i = 0; i < 4; i++) {
      const t = r1(paceSec + 6 + j() * 2);
      rows.push({ n: n++, stroke: 'Unknown', is_drill: false, distance_m: 100, time_s: r1(t * 4),
        swolf: m.avg_swolf, avg_hr: 135, max_hr: 145, avg_strokes: 9, rest_after_s: 20, splits_s: [] });
    }
  } else { // sprint / race_pace
    const reps = subtype === 'race_pace' ? 6 : 8;
    const dist = subtype === 'race_pace' ? 50 : 25;
    for (let i = 0; i < reps; i++) {
      const base = dist === 50 ? m.best_25m_split_s * 2 + 4 : m.best_25m_split_s;
      const t = r1(base + Math.abs(j()) * 0.8 + (i === 1 ? -0.2 : 0));
      rows.push({ n: n++, stroke: 'Unknown', is_drill: false, distance_m: dist, time_s: t,
        swolf: m.avg_swolf - 6, avg_hr: 160, max_hr: m.max_hr, avg_strokes: 7,
        rest_after_s: 125, splits_s: dist === 50 ? [r1(t / 2 - 0.4), r1(t / 2 + 0.4)] : [t] });
    }
  }
  // Cool-down: 6×25
  rows.push({ n: n++, stroke: 'Unknown', is_drill: false, distance_m: 150, time_s: r1(6 * (paceSec / 4 + 2)),
    swolf: m.avg_swolf + 4, avg_hr: 150, max_hr: m.max_hr, avg_strokes: 10, rest_after_s: 0, splits_s: [] });
  return rows;
}

const sessions = [];
let id = 1;
let date = '2026-04-01';
const BLOCKS = 5; // 5 blocks ≈ 20 sessions
let best25 = 17.6, swolf = 35, pace = 98, dps = 3.2, spm = 24;
const N = BLOCKS * 4;
let t = 0;

function poolMetrics() {
  const prog = t / N;
  best25 = r1(17.6 - 1.5 * prog + (Math.random() - 0.5) * 0.3);
  swolf = Math.round(35 - 5 * prog + (Math.random() - 0.5));
  pace = 98 - 11 * prog + (Math.random() - 0.5) * 2;
  dps = r2(3.2 + 0.45 * prog + (Math.random() - 0.5) * 0.05);
  spm = r1(24 + 3 * prog + (Math.random() - 0.5));
  return {
    avg_pace_per_100m: fmtPace(pace),
    avg_swolf: swolf,
    best_25m_split_s: best25,
    avg_hr: Math.round(130 + 20 * prog),
    max_hr: Math.round(178 - 4 * prog),
    avg_strokes_per_length: r1(10 - 1.5 * prog),
    avg_dps_m: dps,
    avg_stroke_rate_spm: spm,
    perceived_effort: 6 + (t % 3),
    self_eval: prog > 0.5 ? 'Strong' : 'OK',
  };
}

for (let b = 0; b < BLOCKS; b++) {
  const drySlot = (b % 4) + 1;
  let poolIdx = 0;
  for (let s = 1; s <= 4; s++) {
    const isDry = s === drySlot;
    if (isDry) {
      sessions.push({
        id: id++, date, type: 'dryland', subtype: 'strength', distance_m: null,
        duration_min: 50, source: 'app_generated', block_number: b + 1,
        dryland: { exercises: [
          { name: 'Pull-ups', sets: 4, reps_per_set: [8, 6, 5, 5] },
          { name: 'Ring rows', sets: 4, reps_per_set: [12, 12, 11, 10] },
          { name: 'Hollow-body hold', sets: 3, duration_s_per_set: [25, 25, 22] },
        ] },
        coach_flags: ['Core stable; pull-up total improving.'],
        athlete_feedback: 'rings only today, grip got tired',
        phase_at_time: 1, notes: 'Dryland.',
      });
    } else {
      const subtype = b % 5 === 4 ? 'race_pace' : poolCycle[poolIdx % poolCycle.length];
      poolIdx++;
      const external = (b === 2 && s === 1);
      const m = poolMetrics();
      const flags = [];
      if (best25 <= 16.8) flags.push(`Sprint best near PB: ${best25}s`);
      if (m.max_hr >= 172) flags.push(`Cool-down HR elevated: max ${m.max_hr} bpm — CO2 tolerance still building.`);
      sessions.push({
        id: id++, date, type: 'pool', subtype,
        distance_m: subtype === 'threshold' ? 2500 : subtype === 'technique' ? 2100 : 1700,
        duration_min: 35, source: external ? 'external' : 'app_generated', block_number: b + 1,
        metrics: m,
        breakdown: demoBreakdown(subtype, m, pace),
        coach_flags: flags,
        athlete_feedback: feedbacks[(id) % feedbacks.length],
        phase_at_time: 1,
        notes: external ? 'External squad session.' : null,
      });
      t++;
    }
    date = addDays(date, s === 4 ? 4 : 3);
  }
}

sessions.reverse(); // most-recent-first

// Rolling bests from the generated data.
const poolSessions = sessions.filter(s => s.type === 'pool');
const best = (sel, cmp) => poolSessions.map(sel).filter(v => v != null).reduce((a, v) => cmp(v, a) ? v : a);
const bestPaceSec = Math.min(...poolSessions.map(s => { const m = s.metrics.avg_pace_per_100m.match(/(\d+):(\d+)/); return +m[1] * 60 + +m[2]; }));

const catalogue = {
  athlete: { name: 'Demo', goal: 'Sub-30s 50m freestyle (25m pool)', pool_length_m: 25 },
  training_phase: {
    current: 1, name: 'Sprint Development',
    blocks_in_phase: BLOCKS, // 5 of 6 blocks done — ring shows good progress
    phase_goals: { swolf_target: 30, best_25m_target_s: 14.0, best_50m_target_s: 30.0 },
  },
  rolling_bests: {
    best_25m_sprint_protocol_s: best(s => s.metrics.best_25m_split_s, (v, a) => v < a),
    best_25m_split_s: best(s => s.metrics.best_25m_split_s, (v, a) => v < a),
    best_avg_swolf: best(s => s.metrics.avg_swolf, (v, a) => v < a),
    // Sprint SWOLF is the efficiency of max-effort reps — lower than the
    // session average (fewer strokes + faster time on the sprints).
    best_sprint_swolf: best(s => s.metrics.avg_swolf, (v, a) => v < a) - 6,
    best_avg_pace_per_100m: fmtPace(bestPaceSec),
    best_threshold_pace_per_100m: '1:34',
    best_50m_equiv_s: 35.5,
  },
  weekly_block_tracking: {
    current_block_number: BLOCKS + 1, current_block_pool_count: 0, current_block_dryland_count: 0,
  },
  active_flags: {
    right_quad_pre_cramp: { onset_session_id: id - 6, onset_date: sessions[2]?.date, decay: { sessions: 2 }, sessions_since: 1, pending_clear: false },
  },
  sessions,
  coach_notes: { last_updated: sessions[0].date },
};

// A pending PLANNED dryland session so the demo shows the structured per-set
// Log form. (Just a session to view — it doesn't affect block progression
// until logged, and the demo is isolated storage anyway.)
catalogue.demo_pending_session = {
  date: sessions[0].date, type: 'dryland', subtype: 'pulling_strength',
  phase: 1, block_number: BLOCKS + 1, session_in_block: 2,
  active_flags: ['right_quad_pre_cramp'], source: 'app_generated', generator: 'fallback_library',
  blocks: [
    { name: 'Block A — Core & Rotation', exercises: [
      { name: 'Hollow-body hold', sets: 3, prescription: '20-30s', rest_s: 45, rationale: 'streamline trunk tension' },
      { name: 'Hanging knee raises', sets: 3, prescription: '10-12 reps', rest_s: 45, rationale: 'hip-flexor control' },
      { name: 'V-ups', sets: 3, prescription: '10-15 reps', rest_s: 45, rationale: 'trunk flexion' },
    ] },
    { name: 'Block B — Pulling Strength', exercises: [
      { name: 'Inverted rows', sets: 4, prescription: '10-12 reps', rest_s: 60, rationale: 'horizontal pull / catch' },
      { name: 'Pull-ups', sets: 4, prescription: 'max-3 reps', rest_s: 90, rationale: 'freestyle-pull pattern' },
      { name: 'Dips', sets: 3, prescription: '8-10 reps', rest_s: 60, rationale: 'pressing balance' },
    ] },
    { name: 'Block C — Shoulder Stability', exercises: [
      { name: 'Scapular pull-ups', sets: 3, prescription: '6-8 reps', rest_s: 45, rationale: 'scapular control' },
      { name: 'Prone Y-T-W raises', sets: 3, prescription: '10 each', rest_s: 45, rationale: 'lower-trap / cuff' },
    ] },
    { name: 'Block D — Controlled Leg / Hip-Flexor', note: '⚠️ Quad flag active — controlled tempo only, no jumping or explosive loading; keep isometric holds short.', exercises: [
      { name: 'Bar-assisted deep-squat hold', sets: 3, prescription: '20-30s', rest_s: 45, rationale: 'quad/hip mobility' },
      { name: 'Slow standing hip-flexor drive', sets: 3, prescription: '10 each', rest_s: 45, rationale: 'hip-flexor endurance' },
    ] },
  ],
};

const out = join(__dirname, '..', 'web', 'seed-catalogue.demo.json');
writeFileSync(out, JSON.stringify(catalogue, null, 2));
console.log(`Wrote ${sessions.length} demo sessions → ${out}`);
