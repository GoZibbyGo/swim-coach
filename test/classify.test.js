import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { inferPoolSubtype } from '../src/classify.js';
import { parseGarminCsv } from '../src/garmin-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────────────────────
// Synthetic parsed-object builders

function freeLen(time, drill = false) {
  return { is_drill: drill, is_freestyle: true, time_s: time };
}

function buildParsed(specs) {
  // specs: array of { distance_m, time_s, lengths: [{time, drill}], stroke }
  const intervals = [];
  const lengths = [];
  for (const s of specs) {
    const ls = s.lengths.map(l => freeLen(l.time, l.drill));
    intervals.push({
      is_rest: false, stroke: s.stroke ?? 'Unknown',
      distance_m: s.distance_m, time_s: s.time_s, lengths: ls,
    });
    lengths.push(...ls);
  }
  return { intervals, lengths };
}

// ──────────────────────────────────────────────────────────────────────────

test('classifies a sprint session (many single max reps)', () => {
  const specs = [];
  for (let n = 0; n < 8; n++) specs.push({ distance_m: 25, time_s: 17, lengths: [{ time: 17 }] });
  const r = inferPoolSubtype(buildParsed(specs));
  assert.equal(r.subtype, 'sprint');
  assert.equal(r.confidence, 'high');
});

test('classifies a threshold session (several long reps)', () => {
  const specs = [];
  for (let n = 0; n < 5; n++) {
    specs.push({ distance_m: 200, time_s: 192, lengths: Array.from({ length: 8 }, () => ({ time: 24 })) });
  }
  const r = inferPoolSubtype(buildParsed(specs));
  assert.equal(r.subtype, 'threshold');
  assert.equal(r.confidence, 'high');
});

test('classifies a technique session (drill-heavy)', () => {
  const specs = [];
  // 4 drill 100s + 2 swim 100s → 16/24 = 67% drills
  for (let n = 0; n < 4; n++) {
    specs.push({ distance_m: 100, time_s: 100, stroke: 'Drill', lengths: Array.from({ length: 4 }, () => ({ time: 25, drill: true })) });
  }
  for (let n = 0; n < 2; n++) {
    specs.push({ distance_m: 100, time_s: 96, lengths: Array.from({ length: 4 }, () => ({ time: 24 })) });
  }
  const r = inferPoolSubtype(buildParsed(specs));
  assert.equal(r.subtype, 'technique');
});

test('classifies a race-pace session (several fast 50m reps)', () => {
  const specs = [];
  for (let n = 0; n < 5; n++) {
    specs.push({ distance_m: 50, time_s: 38, lengths: [{ time: 19 }, { time: 19 }] });
  }
  const r = inferPoolSubtype(buildParsed(specs));
  assert.equal(r.subtype, 'race_pace');
});

test('low-confidence mixed when nothing dominates', () => {
  const specs = [
    { distance_m: 100, time_s: 100, lengths: Array.from({ length: 4 }, () => ({ time: 25 })) },
    { distance_m: 50, time_s: 50, lengths: [{ time: 25 }, { time: 25 }] },
  ];
  const r = inferPoolSubtype(buildParsed(specs));
  assert.equal(r.subtype, 'mixed');
  assert.equal(r.confidence, 'low');
});

test('empty parse → mixed/low', () => {
  const r = inferPoolSubtype({ intervals: [], lengths: [] });
  assert.equal(r.subtype, 'mixed');
  assert.equal(r.confidence, 'low');
});

// ──────────────────────────────────────────────────────────────────────────
// Real session 17 — a threshold session (5×200m main set).

const csvPath = join(__dirname, '..', 'fixtures', 'activity_22919208781.csv');
if (existsSync(csvPath)) {
  test('real session 17 classified as threshold', () => {
    const out = parseGarminCsv(readFileSync(csvPath, 'utf8'));
    const r = inferPoolSubtype(out);
    assert.equal(r.subtype, 'threshold', `reason: ${r.reason}`);
  });
} else {
  test('real session 17 classify — skipping (file not found)', { skip: true }, () => {});
}
