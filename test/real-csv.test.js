// Real-data verification — Session 17 (2026-05-18, threshold w/ cramp).
//
// Asserts the parser's output against the values recorded in
// athlete_catalogue.json (the source of truth for what was actually swum).
// If Garmin changes its CSV export format in a way that breaks our parser,
// this test should be the first to catch it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseGarminCsv } from '../src/garmin-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = join(__dirname, '..', 'fixtures', 'activity_22919208781.csv');

if (!existsSync(csvPath)) {
  // Defensive: if the real CSV isn't present, skip these tests rather than
  // breaking CI. (Won't apply to local dev where the file is committed.)
  test('real CSV not present — skipping', { skip: true }, () => {});
} else {
  const csv = readFileSync(csvPath, 'utf8');
  const out = parseGarminCsv(csv);

  test('session 17 — best 25m split is INT 20.1 at 16.8s', () => {
    assert.equal(out.summary.best_25m_split_s, 16.8);
    assert.match(out.summary.best_25m_context, /INT 20\.1/);
  });

  test('session 17 — sprint finish lengths match catalogue', () => {
    // Catalogue sprint_finish_splits_s: [17.8, 16.8, 17.0, 17.0, 17.0, 17.3]
    // These are INTs 19.1 through 24.1.
    const sprintLengths = out.lengths
      .filter(l => l.interval_number >= 19 && l.interval_number <= 24)
      .sort((a, b) => a.interval_number - b.interval_number);
    assert.equal(sprintLengths.length, 6);
    assert.deepEqual(
      sprintLengths.map(l => l.time_s),
      [17.8, 16.8, 17.0, 17.0, 17.0, 17.3],
    );
  });

  test('session 17 — drill intervals 5-12 detected as drill', () => {
    const drillIntervals = out.intervals.filter(i =>
      i.interval_number >= 5 && i.interval_number <= 12);
    assert.equal(drillIntervals.length, 8);
    for (const di of drillIntervals) {
      assert.equal(di.stroke, 'Drill', `INT ${di.interval_number} stroke should be Drill`);
    }
  });

  test('session 17 — main set 200m intervals (13-17) have 8 lengths each', () => {
    for (let n = 13; n <= 17; n++) {
      const interval = out.intervals.find(i => i.interval_number === n);
      assert.ok(interval, `INT ${n} missing`);
      assert.equal(interval.lengths.length, 8, `INT ${n} should have 8 lengths`);
      assert.equal(interval.distance_m, 200);
    }
  });

  test('session 17 — INT 18 is the partial rep (50m, 2 lengths)', () => {
    const int18 = out.intervals.find(i => i.interval_number === 18);
    assert.equal(int18.distance_m, 50);
    assert.equal(int18.lengths.length, 2);
  });

  test('session 17 — total distance matches catalogue (1,950m)', () => {
    assert.equal(out.summary.total_distance_m, 1950);
  });

  test('session 17 — avg SWOLF excludes zero-SWOLF drill intervals', () => {
    // If drills (SWOLF=0) were included, the average would crash below 25.
    // The catalogue reports avg_swolf=34; our value should be in the same
    // ballpark (33-35) once drills are excluded.
    assert.ok(out.summary.avg_swolf != null);
    assert.ok(out.summary.avg_swolf >= 30 && out.summary.avg_swolf <= 36,
      `expected avg_swolf in 30-36, got ${out.summary.avg_swolf}`);
  });

  test('session 17 — DPS and stroke rate computed per length and in summary', () => {
    // INT 20.1: 25m, 16.8s, 7 strokes → DPS 25/7 = 3.57, SPM 7/16.8*60 = 25.0
    const len = out.lengths.find(l => l.interval_number === 20 && l.length_in_interval === 1);
    assert.equal(len.dps_m, 3.57);
    assert.equal(len.stroke_rate_spm, 25.0);
    // Session summary aggregates exist and are sane.
    assert.ok(out.summary.avg_dps_m > 2 && out.summary.avg_dps_m < 4,
      `avg_dps_m ${out.summary.avg_dps_m}`);
    assert.ok(out.summary.avg_stroke_rate_spm > 15 && out.summary.avg_stroke_rate_spm < 40,
      `avg_stroke_rate_spm ${out.summary.avg_stroke_rate_spm}`);
  });

  test('session 17 — rest_after_s captured for sprint reps (≥2 min)', () => {
    // INT 19 is a sprint rep followed by a 2:08.5 rest row → 128.5s.
    const int19 = out.intervals.find(i => i.interval_number === 19);
    assert.ok(Math.abs(int19.rest_after_s - 128.5) < 0.1,
      `rest_after_s ${int19.rest_after_s}`);
    // All sprint reps (19-24) rested ≥120s, matching the catalogue note.
    const sprints = out.intervals.filter(i => i.interval_number >= 19 && i.interval_number <= 24);
    for (const s of sprints) {
      assert.ok(s.rest_after_s >= 120, `INT ${s.interval_number} rest ${s.rest_after_s}s`);
    }
  });

  test('session 17 — length sub-rows treated as freestyle via parent inheritance', () => {
    // Length 20.1 has stroke "--" in the CSV; should inherit "Unknown" from
    // parent INT 20 and be classified as freestyle (not drill, not non-free).
    const len = out.lengths.find(l =>
      l.interval_number === 20 && l.length_in_interval === 1);
    assert.ok(len, 'INT 20.1 not parsed');
    assert.equal(len.is_freestyle, true);
    assert.equal(len.is_drill, false);
    assert.equal(len.effective_stroke, 'Unknown');
  });
}
