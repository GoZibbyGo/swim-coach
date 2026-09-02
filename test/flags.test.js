import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { detectFlags, detectRecords, detectTechnical, detectDrylandIssues, detectPlanDeviations, buildPlanTags, buildPlanReconciliation } from '../src/flags.js';
import { parseGarminCsv } from '../src/garmin-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────────────────────
// Helpers to build minimal parsed objects for synthetic tests.

function parsed({ summary = {}, intervals = [], lengths = [], glitches = [] } = {}) {
  return { summary, intervals, lengths, glitches };
}

function sprintRep(n, time, swolf, strokes = 7, restAfter = 130) {
  return {
    interval_number: n, is_rest: false, stroke: 'Unknown', time_s: time, swolf,
    rest_after_s: restAfter,
    lengths: [{ is_freestyle: true, is_drill: false, time_s: time, strokes }],
  };
}

function fiftyRep(n, l1, l2) {
  return {
    interval_number: n, is_rest: false, stroke: 'Unknown',
    lengths: [
      { is_freestyle: true, is_drill: false, time_s: l1, strokes: 8 },
      { is_freestyle: true, is_drill: false, time_s: l2, strokes: 8 },
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Record detection

test('detects new sprint protocol best (beats proto, not raw)', () => {
  const p = parsed({ summary: { best_25m_split_s: 16.5, best_25m_context: 'INT 9.1' } });
  const cat = { rolling_bests: { best_25m_sprint_protocol_s: 16.8, best_25m_split_s: 16.1 } };
  const r = detectFlags(p, cat);
  assert.ok(r.flags.some(f => /NEW SPRINT PROTOCOL BEST: 16\.5s/.test(f)));
  assert.ok(!r.flags.some(f => /NEW 25M BEST/.test(f))); // 16.5 > raw 16.1
  assert.equal(r.new_records.best_25m_sprint_protocol_s, 16.5);
});

test('detects new raw 25m best when faster than all-time raw', () => {
  const p = parsed({ summary: { best_25m_split_s: 15.9 } });
  const cat = { rolling_bests: { best_25m_sprint_protocol_s: 16.8, best_25m_split_s: 16.1 } };
  const r = detectFlags(p, cat);
  assert.ok(r.flags.some(f => /NEW 25M BEST \(raw\): 15\.9s/.test(f)));
  assert.equal(r.new_records.best_25m_split_s, 15.9);
});

test('detects new 50m best (fastest actual rep, any context)', () => {
  const p = parsed({ summary: { best_50m_split_s: 34.3, best_50m_context: 'INT 33' } });
  const cat = { rolling_bests: { best_50m_equiv_s: 38.0 } };
  const r = detectFlags(p, cat);
  assert.ok(r.flags.some(f => /NEW 50M BEST: 34\.3s — previous 38s/.test(f)));
  assert.equal(r.new_records.best_50m_equiv_s, 34.3);
});

test('no 50m record when the rep is slower than the rolling best', () => {
  const p = parsed({ summary: { best_50m_split_s: 39.0 } });
  const cat = { rolling_bests: { best_50m_equiv_s: 38.0 } };
  const r = detectFlags(p, cat);
  assert.ok(!r.flags.some(f => /NEW 50M BEST/.test(f)));
  assert.equal(r.new_records.best_50m_equiv_s, undefined);
});

test('detects new threshold pace best', () => {
  const p = parsed({ summary: { best_threshold_pace_per_100m: '1:32' } });
  const cat = { rolling_bests: { best_threshold_pace_per_100m: '1:36' } };
  const r = detectFlags(p, cat);
  assert.ok(r.flags.some(f => /NEW THRESHOLD PACE BEST: 1:32\/100m/.test(f)));
  assert.equal(r.new_records.best_threshold_pace_per_100m, '1:32');
});

test('no threshold pace record when the session is slower than the rolling best', () => {
  const p = parsed({ summary: { best_threshold_pace_per_100m: '1:41' } });
  const cat = { rolling_bests: { best_threshold_pace_per_100m: '1:36' } };
  const r = detectFlags(p, cat);
  assert.ok(!r.flags.some(f => /NEW THRESHOLD PACE BEST/.test(f)));
  assert.equal(r.new_records.best_threshold_pace_per_100m, undefined);
});

test('detects new 100m best', () => {
  const p = parsed({ summary: { best_100m_split_s: 89.5, best_100m_context: 'INT 5' } });
  const cat = { rolling_bests: { best_100m_split_s: 92.0 } };
  const r = detectFlags(p, cat);
  assert.ok(r.flags.some(f => /NEW 100M BEST: 89\.5s — previous 92s/.test(f)));
  assert.equal(r.new_records.best_100m_split_s, 89.5);
});

test('reports "matched" when equal to sprint protocol best', () => {
  const p = parsed({ summary: { best_25m_split_s: 16.8, best_25m_context: 'INT 20.1' } });
  const cat = { rolling_bests: { best_25m_sprint_protocol_s: 16.8, best_25m_split_s: 16.1 } };
  const r = detectRecords(p, cat.rolling_bests);
  assert.ok(r.flags.some(f => /Sprint protocol best matched: 16\.8s/.test(f)));
  assert.equal(r.newRecords.best_25m_sprint_protocol_s, undefined);
});

test('detects new sprint SWOLF best from sprint reps', () => {
  const p = parsed({ intervals: [sprintRep(1, 16.5, 22), sprintRep(2, 16.8, 23)] });
  const cat = { rolling_bests: { best_sprint_swolf: 24 } };
  const r = detectFlags(p, cat);
  assert.ok(r.flags.some(f => /NEW SPRINT SWOLF BEST: 22/.test(f)));
  assert.equal(r.new_records.best_sprint_swolf, 22);
});

test('detects new avg pace best', () => {
  const p = parsed({ summary: { avg_pace_per_100m: '1:25' } });
  const cat = { rolling_bests: { best_avg_pace_per_100m: '1:27' } };
  const r = detectFlags(p, cat);
  assert.ok(r.flags.some(f => /NEW AVG PACE BEST: 1:25/.test(f)));
});

// ──────────────────────────────────────────────────────────────────────────
// Technical detection

// Turn conversion (formerly "first-length gap"). L1 is a dead-stop push start,
// L2 is turn-aided — a 0.5–1.2s advantage to L2 is NORMAL and must stay silent.

test('NORMAL L1→L2 turn advantage (0.9s) produces NO flag', () => {
  // The athlete's core complaint: a dead-stop L1 vs a turn-aided L2 differing
  // by ~1s is physics, not a defect. The old rule fired at >=0.5s, i.e. on
  // essentially every session with 50m reps.
  const p = parsed({ intervals: [fiftyRep(1, 17.4, 16.5), fiftyRep(2, 17.6, 16.7)] });
  const r = detectTechnical(p);
  assert.ok(!r.flags.some(f => /Turn conversion|Split imbalance|First-length gap/.test(f)),
    `a normal turn advantage must be silent, got: ${JSON.stringify(r.flags)}`);
});

test('turn NOT converting (L2 only 0.2s faster) IS flagged', () => {
  const p = parsed({ intervals: [fiftyRep(1, 17.0, 16.8), fiftyRep(2, 17.2, 17.0)] });
  const r = detectTechnical(p);
  assert.ok(r.flags.some(f => /^Turn conversion:/.test(f)),
    `flags: ${JSON.stringify(r.flags)}`);
});

test('L2 SLOWER than L1 is flagged as a turn-conversion failure', () => {
  const p = parsed({ intervals: [fiftyRep(1, 16.8, 17.4), fiftyRep(2, 17.0, 17.6)] });
  const r = detectTechnical(p);
  assert.ok(r.flags.some(f => /^Turn conversion:.*SLOWER than L1/.test(f)),
    `flags: ${JSON.stringify(r.flags)}`);
});

test('oversized split gap (2.5s) is flagged as imbalance, not a push-off fault', () => {
  const p = parsed({ intervals: [fiftyRep(1, 22.0, 19.5), fiftyRep(2, 22.5, 20.0)] });
  const r = detectTechnical(p);
  assert.ok(r.flags.some(f => /^Split imbalance:.*2\.5s faster than L1/.test(f)),
    `flags: ${JSON.stringify(r.flags)}`);
});

test('oversized gap names the standing-start 25m best when L1 is off it', () => {
  const p = parsed({ intervals: [fiftyRep(1, 22.0, 19.5), fiftyRep(2, 22.5, 20.0)] });
  const r = detectFlags(p, { rolling_bests: { best_25m_sprint_protocol_s: 16.8 } });
  assert.ok(r.flags.some(f => /standing-start 25m best \(16\.8s\)/.test(f)),
    `flags: ${JSON.stringify(r.flags)}`);
});

test('split check judges the DOMINANT distance group, not a mix of 50s and 100s', () => {
  // 3×50 (normal 0.9s advantage) + 1×100 (huge L1/L2 gap). Averaging them
  // together is the mixed-rep_class error; the 50s dominate and are normal.
  const hundred = {
    interval_number: 9, is_rest: false, distance_m: 100, time_s: 80, stroke: 'Freestyle',
    lengths: [
      { is_freestyle: true, is_drill: false, time_s: 24.0 },
      { is_freestyle: true, is_drill: false, time_s: 18.0 },
      { is_freestyle: true, is_drill: false, time_s: 19.0 },
      { is_freestyle: true, is_drill: false, time_s: 19.0 },
    ],
  };
  const p = parsed({ intervals: [
    fiftyRep(1, 17.4, 16.5), fiftyRep(2, 17.6, 16.7), fiftyRep(3, 17.5, 16.6), hundred,
  ] });
  const r = detectTechnical(p);
  assert.ok(!r.flags.some(f => /Turn conversion|Split imbalance/.test(f)),
    `the dominant 50m group is normal — should be silent, got: ${JSON.stringify(r.flags)}`);
});

test('detects stroke drift when late strokes exceed early by >=1', () => {
  const lengths = [
    { is_freestyle: true, is_drill: false, strokes: 7 },
    { is_freestyle: true, is_drill: false, strokes: 7 },
    { is_freestyle: true, is_drill: false, strokes: 7 },
    { is_freestyle: true, is_drill: false, strokes: 9 },
    { is_freestyle: true, is_drill: false, strokes: 9 },
    { is_freestyle: true, is_drill: false, strokes: 10 },
  ];
  const r = detectTechnical(parsed({ lengths }));
  assert.ok(r.flags.some(f => /Stroke drift detected/.test(f)));
});

test('passes through Garmin glitches as flags', () => {
  const p = parsed({ glitches: [{ interval: 14, length: 1, kind: 'implausibly_fast', detail: 'too fast' }] });
  const r = detectTechnical(p);
  assert.ok(r.flags.some(f => /Garmin glitch: INT 14\.1 \(implausibly_fast\)/.test(f)));
});

// ──────────────────────────────────────────────────────────────────────────
// Sprint-quality markers (DPS-era additions)

test('flags inconsistent sprint pacing when spread >= 1.5s', () => {
  const p = parsed({ intervals: [
    sprintRep(1, 16.5, 24), sprintRep(2, 17.0, 24), sprintRep(3, 18.2, 26),
  ] });
  const r = detectTechnical(p);
  assert.ok(r.flags.some(f => /Sprint pacing inconsistent: 1\.7s spread/.test(f)),
    `flags: ${JSON.stringify(r.flags)}`);
});

test('flags velocity fade when last sprint rep >=1s slower than first', () => {
  const p = parsed({ intervals: [
    sprintRep(1, 16.5, 24), sprintRep(2, 17.0, 24), sprintRep(3, 17.8, 25),
  ] });
  const r = detectTechnical(p);
  assert.ok(r.flags.some(f => /Velocity fade: last sprint rep 1\.3s slower/.test(f)),
    `flags: ${JSON.stringify(r.flags)}`);
});

test('flags short sprint rest (<120s) — quad protection / alactic quality', () => {
  const p = parsed({ intervals: [
    sprintRep(1, 16.8, 24, 7, 130),
    sprintRep(2, 16.9, 24, 7, 60),   // too short
    sprintRep(3, 17.0, 24, 7, 130),
  ] });
  const r = detectTechnical(p);
  assert.ok(r.flags.some(f => /Sprint rest too short on 1 max-effort rep\(s\): INT 2 \(60s\)/.test(f)),
    `flags: ${JSON.stringify(r.flags)}`);
});

test('emits DPS/stroke-rate snapshot when summary has them', () => {
  const p = parsed({ summary: { avg_dps_m: 3.4, avg_stroke_rate_spm: 26.0 } });
  const r = detectTechnical(p);
  assert.ok(r.flags.some(f => /Efficiency: avg 3\.4 m\/stroke at 26 strokes\/min/.test(f)));
});

test('does NOT flag consistent, well-rested sprint set', () => {
  // Session 17-like: 17.8, 16.8, 17.0, 17.0, 17.0, 17.3 (spread 1.0), all rested.
  const p = parsed({ intervals: [
    sprintRep(19, 17.8, 25), sprintRep(20, 16.8, 24), sprintRep(21, 17.0, 24),
    sprintRep(22, 17.0, 25), sprintRep(23, 17.0, 24), sprintRep(24, 17.3, 25),
  ] });
  const r = detectTechnical(p);
  assert.ok(!r.flags.some(f => /inconsistent|Velocity fade|rest too short/.test(f)),
    `unexpected flags: ${JSON.stringify(r.flags)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// Real CSV — session 17. It SET the 16.8 / 24 bests, so flags should say
// "matched", not "new", and the cool-down HR flag should fire (max 175).

const csvPath = join(__dirname, '..', 'fixtures', 'activity_22919208781.csv');
const realCatPath = join(__dirname, '..', '..', 'Swimming Coach_code', 'athlete_catalogue.json');

// ──────────────────────────────────────────────────────────────────────────
// Dryland data-quality (round-3 feedback: catch obvious logging typos)

test('speed-technique set (25s reps at 60s rest) is NOT flagged as under-rested max effort', () => {
  // Session-29-shaped input: 12×25m at ~20s per rep, 60s rest — RPE 8 speed
  // technique, NOT max_alactic. Under round-5 sprintReps, 60s rest fails the
  // ≥90s alactic-rest gate, so these reps aren't in the max-effort pool and
  // don't trigger a rest-too-short flag.
  const reps = Array.from({ length: 12 }, (_, i) => sprintRep(i + 1, 19.5, 26, 8, 60));
  const p = parsed({ intervals: reps, summary: {} });
  const r = detectFlags(p, { rolling_bests: {} });
  assert.ok(!r.flags.some(f => /Sprint rest too short/.test(f)),
    `speed-technique set should not fire the sprint-rest safety flag, got: ${JSON.stringify(r.flags)}`);
});

test('rest-tolerance band: 117s is not flagged against 120s min (within 10%)', () => {
  const reps = [
    sprintRep(1, 16.5, 22, 7, 130), // has ≥90s rest → in sprintReps
    sprintRep(2, 16.6, 22, 7, 117), // ≥90s → in pool; 117s < 120 but ≥ 108 → NOT flagged
    sprintRep(3, 16.4, 22, 7, 130),
  ];
  const p = parsed({ intervals: reps, summary: {} });
  const r = detectFlags(p, { rolling_bests: {} });
  assert.ok(!r.flags.some(f => /Sprint rest too short/.test(f)),
    `117s vs 120s min should be inside the 10% tolerance, got: ${JSON.stringify(r.flags)}`);
});

test('cut_short signal suppresses the trailing rep from the sprint-rest check', () => {
  // 4 sprint reps: first three have 130s rest (ok), the last has 15s rest
  // (short) — because the session was cut short and there was no next rep.
  const reps = [
    sprintRep(1, 16.5, 24, 7, 130),
    sprintRep(2, 16.6, 24, 7, 130),
    sprintRep(3, 16.7, 24, 7, 130),
    sprintRep(4, 16.8, 24, 7, 15),
  ];
  const p = parsed({ intervals: reps, summary: {} });
  const catalogue = { rolling_bests: {} };
  // Without cut_short: the 15s rest fires the flag.
  const noSignal = detectFlags(p, catalogue);
  assert.ok(noSignal.flags.some(f => /Sprint rest too short/.test(f)));
  // With cut_short: the trailing rep is dropped from the check — no flag.
  const withCutShort = detectFlags(p, catalogue, {
    signals: { matched: [{ id: 'cut_short' }] },
  });
  assert.ok(!withCutShort.flags.some(f => /Sprint rest too short/.test(f)));
});

test('cut_short signal also suppresses velocity fade (athlete already explained)', () => {
  const reps = [
    sprintRep(1, 15.0, 22, 7, 130),
    sprintRep(2, 15.2, 22, 7, 130),
    sprintRep(3, 17.8, 25, 8, 130), // big fade — but athlete said nausea/cut-short
  ];
  const p = parsed({ intervals: reps, summary: {} });
  const catalogue = { rolling_bests: {} };
  const noSignal = detectFlags(p, catalogue);
  assert.ok(noSignal.flags.some(f => /Velocity fade/.test(f)));
  const withCutShort = detectFlags(p, catalogue, {
    signals: { matched: [{ id: 'cut_short' }] },
  });
  assert.ok(!withCutShort.flags.some(f => /Velocity fade/.test(f)));
});

test('PR gating: a fast 100m rep in a "Pull" block is NOT written as a PR', () => {
  // Session 32 pattern: 4×100 pull-buoy 100m at 88.8s — must not supersede
  // best_100m_split_s. Plan tags mark the block equipment as "pull buoy".
  const plan = {
    total_volume_m: 400,
    blocks: [
      { name: 'Pull set', sets: [{ reps: 4, distance_m: 100, effort: 'moderate', rest_s: 20, equipment: 'pull buoy' }] },
    ],
  };
  const breakdown = [
    { n: 1, distance_m: 100, time_s: 88.8 },
    { n: 2, distance_m: 100, time_s: 90 },
    { n: 3, distance_m: 100, time_s: 91 },
    { n: 4, distance_m: 100, time_s: 92 },
  ];
  const tags = buildPlanTags(plan, breakdown);
  assert.equal(tags.get(1).equipment, 'pull buoy', 'INT 1 must be tagged as pull-buoy assisted');
  // Now simulate detectRecords with the plan tags.
  const p = parsed({ summary: { best_100m_split_s: 88.8, best_100m_context: 'INT 1' } });
  const cat = { rolling_bests: { best_100m_split_s: 92.0 } };
  const r = detectFlags(p, cat, { planTags: tags });
  assert.ok(!r.flags.some(f => /NEW 100M BEST/.test(f)),
    `PR must be suppressed for assisted rep, got: ${JSON.stringify(r.flags)}`);
  assert.ok(r.flags.some(f => /Fast 100m NOT written as PR/.test(f)),
    `expected an "assisted rep" note, got: ${JSON.stringify(r.flags)}`);
  assert.equal(r.new_records.best_100m_split_s, undefined,
    'assisted rep must not enter new_records');
});

test('tracking-dropout signal suppresses volume-deviation flag', () => {
  const plan = { total_volume_m: 2200, blocks: [{ name: 'Main', sets: [{ reps: 8, distance_m: 100 }] }] };
  const breakdown = Array.from({ length: 8 }, (_, i) => ({ n: i + 1, distance_m: 100, time_s: 100 }));
  // Actual volume 800m vs prescribed 2200 = huge shortfall. Without a
  // tracking_dropout signal, this fires a volume-deviation flag. With it,
  // it becomes a data-quality note.
  const withoutSignal = detectPlanDeviations(plan, breakdown);
  assert.ok(withoutSignal.some(f => /total volume/.test(f)));
  const withDropout = detectPlanDeviations(plan, breakdown, {
    signals: { matched: [{ id: 'tracking_dropout' }] },
  });
  assert.ok(!withDropout.some(f => /Plan deviation: total volume/.test(f)),
    `dropout must suppress the volume-deviation flag, got: ${JSON.stringify(withDropout)}`);
  assert.ok(withDropout.some(f => /Data quality: tracking dropout/.test(f)),
    `dropout should emit a data-quality note, got: ${JSON.stringify(withDropout)}`);
});

test('mixed-distance block does NOT trigger a bogus "prescribed 12×100m" deviation', () => {
  // Session-31 warm-up: 4×100 + 4×50 + 4×25. Was rendering as "prescribed
  // 12×100m" against a 4×100 actual — bogus. Now skipped (heterogeneous block).
  const plan = {
    blocks: [{ name: 'Warm-up', sets: [
      { reps: 4, distance_m: 100 }, { reps: 4, distance_m: 50 }, { reps: 4, distance_m: 25 },
    ]}],
  };
  const breakdown = Array.from({ length: 4 }, (_, i) => ({ n: i + 1, distance_m: 100, time_s: 100 }));
  const flags = detectPlanDeviations(plan, breakdown);
  assert.ok(!flags.some(f => /12×100m/.test(f)),
    `mixed-block must not render as 12×100m, got: ${JSON.stringify(flags)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// Plan ↔ actual reconciliation — the deterministic mapping the feedback LLM
// used to have to guess at (and got wrong).

test('buildPlanReconciliation maps each plan block to its actual intervals', () => {
  const plan = {
    total_volume_m: 1000,
    blocks: [
      { name: 'Warm-up', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 20 }] },
      { name: 'Main Set — Sprints', sets: [{ reps: 8, distance_m: 25, effort: 'max', rest_s: 120 }] },
      { name: 'Cool-down', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 20 }] },
    ],
  };
  const breakdown = [
    ...Array.from({ length: 4 }, (_, i) => ({ n: i + 1, distance_m: 100, time_s: 100 })),
    ...Array.from({ length: 8 }, (_, i) => ({ n: i + 5, distance_m: 25, time_s: 17 })),
    ...Array.from({ length: 4 }, (_, i) => ({ n: i + 13, distance_m: 100, time_s: 110 })),
  ];
  const { rows, text } = buildPlanReconciliation(plan, breakdown);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].interval_range, 'INT 1–4');
  assert.equal(rows[0].actual, '4×100m');
  assert.match(rows[0].status, /swum as prescribed/);
  assert.equal(rows[1].interval_range, 'INT 5–12');
  assert.equal(rows[1].actual, '8×25m');
  assert.match(rows[1].prescribed, /8×25m max @120s/);
  assert.match(rows[1].status, /swum as prescribed/);
  assert.equal(rows[2].interval_range, 'INT 13–16');
  assert.match(text, /Main Set — Sprints/);
});

test('buildPlanReconciliation marks a genuinely short block, not a compliant one', () => {
  const plan = {
    blocks: [
      { name: 'Main Set', sets: [{ reps: 8, distance_m: 50, rest_s: 60 }] },
      { name: 'Cool-down', sets: [{ reps: 8, distance_m: 25, rest_s: 15 }] },
    ],
  };
  // Main set swum in full; cool-down cut to 2×25 of the prescribed 8×25.
  const breakdown = [
    ...Array.from({ length: 8 }, (_, i) => ({ n: i + 1, distance_m: 50, time_s: 40 })),
    { n: 9, distance_m: 25, time_s: 22 },
    { n: 10, distance_m: 25, time_s: 22 },
  ];
  const { rows } = buildPlanReconciliation(plan, breakdown);
  assert.match(rows[0].status, /swum as prescribed/, 'full main set must not be flagged');
  // Reports the rep count as well as the metres — a shortfall the athlete can act on.
  assert.match(rows[1].status, /2\/8 prescribed reps matched/, `cool-down should show the shortfall, got ${rows[1].status}`);
  assert.match(rows[1].status, /−150m/);
});

test('buildPlanReconciliation returns empty (not a crash) with no plan or no breakdown', () => {
  assert.deepEqual(buildPlanReconciliation(null, [{ n: 1, distance_m: 50 }]), { rows: [], text: '' });
  assert.deepEqual(buildPlanReconciliation({ blocks: [] }, []), { rows: [], text: '' });
});

test('detectDrylandIssues flags a high outlier rep count', () => {
  const dryland = { exercises: [
    { name: 'Dumbbell single-arm row', reps_per_set: [10, 18, 10] }, // 18 is likely a typo
    { name: 'Pull-ups',                 reps_per_set: [8, 5, 5, 4] }, // realistic fatigue
  ] };
  const { flags } = detectDrylandIssues(dryland);
  assert.ok(flags.some(f => /Dumbbell single-arm row.*outlier.*18/.test(f)));
  // Pull-ups now DO produce a finding — establishing a first baseline. A
  // dryland session returning nothing was a repeat complaint across blocks.
  assert.ok(flags.some(f => /Dryland baseline established: Pull-ups — 8 reps/.test(f)));
});

test('every logged exercise produces a finding — dryland is never silent', () => {
  const { flags } = detectDrylandIssues({ exercises: [
    { name: 'Heavy goblet squat', reps_per_set: [8, 20] },
  ] });
  assert.ok(flags.length > 0, 'a dryland session must never come back with no findings');
});

test('baselines are ESTABLISHED, beaten and persisted as updates', () => {
  const first = detectDrylandIssues({ exercises: [{ name: 'Hollow Body Hold', duration_s_per_set: [20, 18] }] }, {});
  assert.match(first.flags[0], /baseline established: Hollow Body Hold — 20s/);
  assert.equal(first.updates.hollow_body_hold_best, 20);

  // Session 30's real numbers: 30/25/24 against a 20s baseline — never recorded.
  const beat = detectDrylandIssues(
    { exercises: [{ name: 'Hollow Body Hold', duration_s_per_set: [30, 25, 24] }] },
    { hollow_body_hold_best: 20 });
  assert.ok(beat.flags.some(f => /Dryland PR: Hollow Body Hold — 30s beats the stored 20s/.test(f)));
  assert.equal(beat.updates.hollow_body_hold_best, 30, 'a PR must be written back, not just announced');
});

test('holding steady and regressing are distinguished, and neither overwrites the best', () => {
  const held = detectDrylandIssues(
    { exercises: [{ name: 'Dips', reps_per_set: [9] }] }, { dips_best: 10 });
  assert.ok(held.flags.some(f => /Dryland held: Dips — 9 reps against a stored best of 10/.test(f)));
  assert.equal(held.updates.dips_best, undefined);

  const down = detectDrylandIssues(
    { exercises: [{ name: 'Dips', reps_per_set: [5] }] }, { dips_best: 10 });
  assert.ok(down.flags.some(f => /Dryland regression: Dips/.test(f)));
  assert.equal(down.updates.dips_best, undefined);
});

test('clearing the top of a prescribed range asks for progression', () => {
  // Session 35: shoulder press 10/10/10 against "3×8-10" — never progressed.
  const { flags } = detectDrylandIssues({ exercises: [
    { name: 'Shoulder press', prescription: '3×8-10', reps_per_set: [10, 10, 10] },
  ] }, { shoulder_press_best: 10 });
  assert.ok(flags.some(f => /progression due: Shoulder press/.test(f)),
    `expected a progression prompt, got: ${JSON.stringify(flags)}`);
});

test('unestablished carry-forward items keep surfacing until programmed', () => {
  const { flags } = detectDrylandIssues({ exercises: [] },
    { bar_hang_external_rotation: 'NOT YET ESTABLISHED' });
  assert.ok(flags.some(f => /carry-forward: bar hang external rotation/.test(f)));
});

// ──────────────────────────────────────────────────────────────────────────
// Plan-deviation detection (round-3 feedback: catch cool-down swap)

test('detectPlanDeviations flags a cool-down swap (8×25 → 4×50)', () => {
  const plan = {
    blocks: [
      { name: 'Main', sets: [{ reps: 5, distance_m: 100, rest_s: 30 }] },
      { name: 'Cool-down', sets: [{ reps: 8, distance_m: 25, rest_s: 0 }] },
    ],
  };
  const breakdown = [
    // Main: 5×100
    { n: 1, distance_m: 100, time_s: 92 }, { n: 2, distance_m: 100, time_s: 92 },
    { n: 3, distance_m: 100, time_s: 93 }, { n: 4, distance_m: 100, time_s: 93 },
    { n: 5, distance_m: 100, time_s: 93 },
    // Cool-down: 4×50 (swapped from 8×25)
    { n: 6, distance_m: 50, time_s: 60 }, { n: 7, distance_m: 50, time_s: 60 },
    { n: 8, distance_m: 50, time_s: 60 }, { n: 9, distance_m: 50, time_s: 60 },
  ];
  const flags = detectPlanDeviations(plan, breakdown);
  // Reported as two FACTS rather than one inference. The engine can see that
  // the prescribed 8×25 has no matching reps and that 4×50 was swum outside any
  // block — it cannot actually see that one was substituted for the other, and
  // claiming so is the kind of unfounded "you swapped things" assertion the
  // athlete objected to. The main set, swum correctly, stays unflagged.
  assert.ok(flags.some(f => /Cool-down — prescribed 8 rep\(s\), none matching recorded/.test(f)),
    `expected the prescribed cool-down to be reported missing, got: ${JSON.stringify(flags)}`);
  assert.ok(flags.some(f => /4×50m swum but matching no prescribed block/.test(f)),
    `expected the unmatched 4×50 to be surfaced, got: ${JSON.stringify(flags)}`);
  assert.ok(!flags.some(f => /Main/.test(f)), 'the correctly-swum main set must not be flagged');
});

test('detectPlanDeviations stays quiet when plan is honoured exactly', () => {
  const plan = { blocks: [{ name: 'Main', sets: [{ reps: 4, distance_m: 100 }] }] };
  const breakdown = [
    { n: 1, distance_m: 100, time_s: 90 }, { n: 2, distance_m: 100, time_s: 90 },
    { n: 3, distance_m: 100, time_s: 90 }, { n: 4, distance_m: 100, time_s: 90 },
  ];
  assert.deepEqual(detectPlanDeviations(plan, breakdown), []);
});

test('detectPlanDeviations flags a total-volume cut', () => {
  const plan = { total_volume_m: 1600, blocks: [{ name: 'Main', sets: [{ reps: 8, distance_m: 200 }] }] };
  const breakdown = [
    { n: 1, distance_m: 200, time_s: 200 }, { n: 2, distance_m: 200, time_s: 200 },
    { n: 3, distance_m: 200, time_s: 200 }, { n: 4, distance_m: 200, time_s: 200 },
  ];
  const flags = detectPlanDeviations(plan, breakdown);
  assert.ok(flags.some(f => /total volume 800m vs prescribed 1600m/.test(f)));
});

if (existsSync(csvPath) && existsSync(realCatPath)) {
  test('session 17 flags: matched protocol best + sprint SWOLF + cool-down HR', () => {
    const out = parseGarminCsv(readFileSync(csvPath, 'utf8'));
    const cat = JSON.parse(readFileSync(realCatPath, 'utf8'));
    const r = detectFlags(out, cat);

    // 16.8 equals current proto best → matched, not new
    assert.ok(r.flags.some(f => /Sprint protocol best matched: 16\.8s/.test(f)),
      `flags: ${JSON.stringify(r.flags, null, 2)}`);
    assert.ok(!r.flags.some(f => /NEW SPRINT PROTOCOL BEST/.test(f)));

    // sprint SWOLF 24 equals current best → matched
    assert.ok(r.flags.some(f => /Sprint SWOLF best matched: 24/.test(f)));

    // cool-down HR was 175 — new lookback-3 / 140-threshold formatting:
    // "Cool-down HR elevated: peak 175 bpm at INT N (X/Y of the closing intervals ≥140)…"
    assert.ok(r.flags.some(f => /Cool-down HR elevated:.*peak 175 bpm/.test(f)));
  });
} else {
  test('session 17 real-data flags — skipping (files not found)', { skip: true }, () => {});
}

// ──────────────────────────────────────────────────────────────────────────
// Regression: the block-boundary drift the athlete caught (2026-08-28).
// A 500m warm-up written as 4×100 + 4×25 was truncated at 450m by a
// `consumed < blockVol * 0.9` guard, spilling its last 2×25 into the next
// block and shifting every boundary after it — reported as "warm-up 450m",
// a 4×50 primer rendered as "2×25 + 3×50", and main sets that looked
// reordered. It still said "swum as prescribed", so it was confidently wrong.

const DRIFT_PLAN = { blocks: [
  { name: 'Warm-up', sets: [{ reps: 4, distance_m: 100 }, { reps: 4, distance_m: 25 }] }, // 500m
  { name: 'Pre-Main Primer', sets: [{ reps: 4, distance_m: 50 }] },                        // 200m
  { name: 'Main Set', sets: [{ reps: 8, distance_m: 50 }] },                               // 400m
  { name: 'Cool-down', sets: [{ reps: 8, distance_m: 25 }] },                              // 200m
] };

function swim(spec) {
  let n = 1; const out = [];
  for (const [count, dist] of spec) for (let i = 0; i < count; i++) out.push({ n: n++, distance_m: dist, time_s: dist });
  return out;
}

test('a mixed-distance block that was swum in FULL reconciles in full', () => {
  const rows = buildPlanReconciliation(DRIFT_PLAN,
    swim([[4, 100], [4, 25], [4, 50], [8, 50], [8, 25]])).rows;
  assert.equal(rows[0].actual_m, 500, `warm-up must be 500m, not 450m — got ${rows[0].actual_m}`);
  assert.equal(rows[0].actual, '4×100m + 4×25m');
  assert.match(rows[0].status, /swum as prescribed/);
});

test('the truncated warm-up no longer spills its last reps into the next block', () => {
  const rows = buildPlanReconciliation(DRIFT_PLAN,
    swim([[4, 100], [4, 25], [4, 50], [8, 50], [8, 25]])).rows;
  assert.equal(rows[1].actual, '4×50m',
    `primer must be 4×50m, not "2×25m + 3×50m" — got ${rows[1].actual}`);
  assert.ok(!/25m/.test(rows[1].actual), 'no 25s may leak from the warm-up into the primer');
});

test('boundary drift does not cascade into the later blocks', () => {
  const rows = buildPlanReconciliation(DRIFT_PLAN,
    swim([[4, 100], [4, 25], [4, 50], [8, 50], [8, 25]])).rows;
  assert.equal(rows[2].actual, '8×50m');
  assert.equal(rows[3].actual, '8×25m', `cool-down must be 8×25m — got ${rows[3].actual}`);
  assert.equal(rows[3].actual_m, 200);
});

test('a genuinely short block is still reported, with the rep count', () => {
  const rows = buildPlanReconciliation(DRIFT_PLAN,
    swim([[4, 100], [4, 25], [4, 50], [5, 50], [8, 25]])).rows;
  assert.match(rows[2].status, /5\/8 prescribed reps matched/);
  assert.match(rows[2].status, /−150m/);
});

test('"swum as prescribed" now requires the REPS to match, not just the metres', () => {
  // Same total metres, wrong rep composition (4×50 instead of 8×25).
  const plan = { blocks: [{ name: 'Cool-down', sets: [{ reps: 8, distance_m: 25 }] }] };
  const rows = buildPlanReconciliation(plan, swim([[4, 50]])).rows;
  assert.ok(!/swum as prescribed/.test(rows[0].status),
    `matching volume with the wrong reps must not read as compliant: ${rows[0].status}`);
});

test('ambiguous boundaries between same-distance blocks are declared, not hidden', () => {
  const { text } = buildPlanReconciliation(DRIFT_PLAN,
    swim([[4, 100], [4, 25], [4, 50], [8, 50], [8, 25]]));
  assert.match(text, /Boundary inferred/);
  assert.match(text, /Pre-Main Primer → Main Set/);
  assert.match(text, /do not assert reps were moved between them/);
});

test('extra reps are absorbed only when the next block expects a different distance', () => {
  // 10×50 swum against an 8×50 main set, cool-down is 25s → safe to absorb.
  const rows = buildPlanReconciliation(DRIFT_PLAN,
    swim([[4, 100], [4, 25], [4, 50], [10, 50], [8, 25]])).rows;
  assert.equal(rows[2].actual, '10×50m');
  assert.equal(rows[3].actual, '8×25m', 'the cool-down must still be found intact');
});

test('a fully-swum session emits NO plan-deviation flags (single source of truth)', () => {
  // detectPlanDeviations used to keep its own copy of the drifting walk, so a
  // correctly-swum session got a clean reconciliation table AND contradictory
  // "Plan deviation" flags built from a different block assignment.
  const breakdown = swim([[4, 100], [4, 25], [4, 50], [8, 50], [8, 25]]);
  const flags = detectPlanDeviations({ ...DRIFT_PLAN, total_volume_m: 1300 }, breakdown);
  assert.deepEqual(flags, [], `a session swum as prescribed must raise nothing, got: ${JSON.stringify(flags)}`);
});

test('deviation flags agree with the reconciliation table', () => {
  const breakdown = swim([[4, 100], [4, 25], [4, 50], [5, 50], [8, 25]]);
  const rows = buildPlanReconciliation(DRIFT_PLAN, breakdown).rows;
  const flags = detectPlanDeviations({ ...DRIFT_PLAN, total_volume_m: 1300 }, breakdown);
  // The table says the main set is 5/8; the flag must say the same thing.
  assert.match(rows[2].status, /5\/8/);
  assert.ok(flags.some(f => /Main Set — prescribed 8×50m, actual 5×50m/.test(f)),
    `flags must match the table, got: ${JSON.stringify(flags)}`);
  // ...and must NOT invent deviations in the blocks that were swum correctly.
  assert.ok(!flags.some(f => /Warm-up|Pre-Main Primer|Cool-down/.test(f)),
    `correctly-swum blocks must not be flagged, got: ${JSON.stringify(flags)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// rep_class is now ENFORCED by the engine, not merely requested of the LLM.
// Block-6 report: a Sprint Finish tagged build_finish at 60s prescribed rest
// was flagged "max efforts need ≥120s" for taking 70s — MORE than prescribed —
// and its slow reps inflated a "2.8s spread across 8 max reps" when the real
// max set spanned 1.2s.

const TAGGED_PLAN = { blocks: [
  { name: 'Main Set', sets: [{ reps: 6, distance_m: 25, effort: 'max', rest_s: 120, rep_class: 'max_alactic' }] },
  { name: 'Sprint Finish', sets: [{ reps: 4, distance_m: 25, effort: 'build to max', rest_s: 60, rep_class: 'build_finish' }] },
] };

function taggedSession() {
  // Max set 16.8–18.0s (1.2s spread), build finish 19.0–19.6s at 70s rest.
  const intervals = [], breakdown = [];
  const times = [16.8, 17.1, 17.3, 17.5, 17.8, 18.0, 19.0, 19.2, 19.4, 19.6];
  times.forEach((t, i) => {
    const n = i + 1;
    const rest = i < 6 ? 130 : 70;
    intervals.push(sprintRep(n, t, 24, 7, rest));
    breakdown.push({ n, distance_m: 25, time_s: t, rest_after_s: rest });
  });
  return { intervals, breakdown };
}

test('a build_finish rep that BEAT its prescribed rest is not flagged', () => {
  const { intervals, breakdown } = taggedSession();
  const planTags = buildPlanTags(TAGGED_PLAN, breakdown);
  assert.equal(planTags.get(7).rep_class, 'build_finish');
  assert.equal(planTags.get(7).prescribed_rest_s, 60);
  const r = detectTechnical(parsed({ intervals }), { planTags });
  assert.ok(!r.flags.some(f => /^Sprint rest too short/.test(f)),
    `70s against a 60s prescription is compliant, got: ${JSON.stringify(r.flags)}`);
});

test('pacing spread is computed within max_alactic only, excluding the finish', () => {
  const { intervals, breakdown } = taggedSession();
  const planTags = buildPlanTags(TAGGED_PLAN, breakdown);
  const r = detectTechnical(parsed({ intervals }), { planTags });
  const spread = r.flags.find(f => /Sprint pacing inconsistent/.test(f));
  // Max set spans 16.8→18.0 = 1.2s, under the 1.5s threshold → no flag at all.
  assert.ok(!spread, `build_finish reps must not inflate the max spread, got: ${spread}`);
});

test('an actually under-rested max rep is STILL flagged, against its prescription', () => {
  const { intervals, breakdown } = taggedSession();
  intervals[2].rest_after_s = 40;          // a real violation inside the max set
  breakdown[2].rest_after_s = 40;
  const planTags = buildPlanTags(TAGGED_PLAN, breakdown);
  const r = detectTechnical(parsed({ intervals }), { planTags });
  assert.ok(r.flags.some(f => /Sprint rest too short.*INT 3 \(40s\).*prescribed 120s/.test(f)),
    `a genuine violation must still fire and cite the prescription, got: ${JSON.stringify(r.flags)}`);
});

test('untagged (external) sessions still fall back to the time heuristic', () => {
  const reps = [sprintRep(1, 16.8, 24, 7, 130), sprintRep(2, 16.9, 24, 7, 60), sprintRep(3, 17.0, 24, 7, 130)];
  const r = detectTechnical(parsed({ intervals: reps }), {});
  assert.ok(r.flags.some(f => /^Sprint rest too short/.test(f)),
    'with no plan tags the heuristic must still protect the athlete');
});
