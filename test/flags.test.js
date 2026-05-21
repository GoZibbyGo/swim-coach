import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { detectFlags, detectRecords, detectTechnical } from '../src/flags.js';
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

    // cool-down HR was 175
    assert.ok(r.flags.some(f => /Cool-down HR elevated: max 175 bpm/.test(f)));
  });
} else {
  test('session 17 real-data flags — skipping (files not found)', { skip: true }, () => {});
}
