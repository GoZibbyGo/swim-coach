import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { detectFlags, detectRecords, detectTechnical, detectDrylandIssues, detectPlanDeviations, buildPlanTags } from '../src/flags.js';
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

test('detects first-length gap across 50m reps', () => {
  const p = parsed({ intervals: [fiftyRep(1, 22.0, 19.5), fiftyRep(2, 22.5, 20.0)] });
  const r = detectTechnical(p);
  assert.ok(r.flags.some(f => /First-length gap: L1 avg 22\.3s vs L2 avg 19\.8s/.test(f)),
    `flags: ${JSON.stringify(r.flags)}`);
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
  assert.ok(r.flags.some(f => /Sprint rest too short on 1 rep\(s\): INT 2 \(60s\)/.test(f)),
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

test('detectDrylandIssues flags a high outlier rep count', () => {
  const dryland = { exercises: [
    { name: 'Dumbbell single-arm row', reps_per_set: [10, 18, 10] }, // 18 is likely a typo
    { name: 'Pull-ups',                 reps_per_set: [8, 5, 5, 4] }, // realistic fatigue → no flag
  ] };
  const flags = detectDrylandIssues(dryland);
  assert.ok(flags.some(f => /Dumbbell single-arm row.*outlier.*18/.test(f)));
  assert.ok(!flags.some(f => /Pull-ups/.test(f)));
});

test('detectDrylandIssues stays quiet when fewer than 3 sets', () => {
  const flags = detectDrylandIssues({ exercises: [{ name: 'Heavy goblet', reps_per_set: [8, 20] }] });
  assert.equal(flags.length, 0);
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
  assert.ok(flags.some(f => /Plan deviation: Cool-down.*8×25.*4×50/.test(f)),
    `expected cool-down deviation, got: ${JSON.stringify(flags)}`);
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
