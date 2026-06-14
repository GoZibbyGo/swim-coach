import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseCsv,
  parseTimeToSeconds,
  formatPacePer100m,
  parseGarminCsv,
} from '../src/garmin-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '..', 'fixtures', 'synthetic_activity.csv');
const fixture = readFileSync(fixturePath, 'utf8');

// Synthetic activity contents:
// INT 1   Warm-up:   4 × 25m Unknown (freestyle), times 24.2 / 23.5 / 23.9 / 24.0
// INT 2   Rest 2:00
// INT 3   Drill:     2 × 25m Drill, times 14.0 / 16.0   (should NOT count as best 25m)
// INT 4   Rest 2:00
// INT 5   Sprint:    1 × 25m Unknown @ 12.5s            (implausibly_fast glitch)
// INT 6   Rest 2:00
// INT 7   Sprint:    1 × 25m Unknown @ 17.4s            (adjacent to INT 5 glitch → unverified)
// INT 8   Rest 2:00
// INT 9   Sprint:    1 × 25m Unknown @ 16.9s            (clean — should be best 25m)
// INT 10  Rest 2:00
// INT 11  Sprint:    1 × 25m Unknown @ 17.0s            (clean)

// ──────────────────────────────────────────────────────────────────────────
// CSV tokenizer

test('parseCsv handles quoted fields and "" escapes', () => {
  const text = '"a","b,c","d""e"\n1,2,3\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows, [['a', 'b,c', 'd"e'], ['1', '2', '3']]);
});

test('parseCsv normalises CRLF line endings', () => {
  const rows = parseCsv('a,b\r\n1,2\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

// ──────────────────────────────────────────────────────────────────────────
// Time parsing

test('parseTimeToSeconds handles ss, m:ss.s, and h:mm:ss.s', () => {
  assert.equal(parseTimeToSeconds('17.4'), 17.4);
  assert.equal(parseTimeToSeconds('0:17.4'), 17.4);
  assert.equal(parseTimeToSeconds('1:33.2'), 93.2);
  assert.equal(parseTimeToSeconds('3:29.2'), 209.2);
  assert.equal(parseTimeToSeconds('1:00:00'), 3600);
});

test('parseTimeToSeconds returns null for missing/garbage', () => {
  assert.equal(parseTimeToSeconds(null), null);
  assert.equal(parseTimeToSeconds(''), null);
  assert.equal(parseTimeToSeconds('--'), null);
  assert.equal(parseTimeToSeconds('abc'), null);
});

test('formatPacePer100m rounds to whole seconds', () => {
  assert.equal(formatPacePer100m(1600, 1416), '1:29');
  assert.equal(formatPacePer100m(0, 100), null);
  assert.equal(formatPacePer100m(100, 0), null);
});

// ──────────────────────────────────────────────────────────────────────────
// End-to-end parse of synthetic activity

test('parseGarminCsv extracts intervals and lengths', () => {
  const out = parseGarminCsv(fixture);
  // 6 swim intervals (1,3,5,7,9,11) + 5 rests (2,4,6,8,10) = 11 total
  assert.equal(out.intervals.length, 11);
  assert.equal(out.intervals.filter(i => !i.is_rest).length, 6);
  assert.equal(out.intervals.filter(i => i.is_rest).length, 5);
  // Lengths: 4 (warm-up) + 2 (drill) + 1×4 (sprints) = 10
  assert.equal(out.lengths.length, 10);
});

test('Unknown stroke is treated as freestyle', () => {
  const out = parseGarminCsv(fixture);
  const warmupLengths = out.lengths.filter(l => l.interval_number === 1);
  assert.ok(warmupLengths.every(l => l.is_freestyle));
  assert.ok(warmupLengths.every(l => !l.is_drill));
  assert.ok(warmupLengths.every(l => l.glitches.length === 0 || l.glitches.every(g => g === 'adjacent_to_glitch')));
});

test('Drill stroke is flagged is_drill and excluded from best 25m', () => {
  const out = parseGarminCsv(fixture);
  const drillLengths = out.lengths.filter(l => l.interval_number === 3);
  assert.equal(drillLengths.length, 2);
  assert.ok(drillLengths.every(l => l.is_drill));
  // INT 3.1 is 14.0s — would otherwise be the best 25m. Must not be picked.
  assert.notEqual(out.summary.best_25m_context, 'INT 3.1');
});

test('parseGarminCsv flags implausibly-fast length (INT 5.1, 12.5s)', () => {
  const out = parseGarminCsv(fixture);
  const int5 = out.intervals.find(i => i.interval_number === 5);
  const len = int5.lengths[0];
  assert.ok(len.glitches.includes('implausibly_fast'),
    `expected 'implausibly_fast' in glitches, got: ${JSON.stringify(len.glitches)}`);
  assert.ok(out.glitches.some(g => g.kind === 'implausibly_fast' && g.interval === 5));
});

test('parseGarminCsv propagates adjacent_to_glitch flag', () => {
  // Lengths in order: 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 5.1, 7.1, 9.1, 11.1
  // Glitched: 5.1 (implausibly_fast).
  // Adjacent in the lengths array sequence: 3.2 and 7.1.
  const out = parseGarminCsv(fixture);
  const find = (i, l) => out.lengths.find(x => x.interval_number === i && x.length_in_interval === l);
  assert.ok(find(3, 2).glitches.includes('adjacent_to_glitch'));
  assert.ok(find(7, 1).glitches.includes('adjacent_to_glitch'));
});

test('best_25m_split_s picks fastest clean freestyle, ignoring drill and glitches', () => {
  const out = parseGarminCsv(fixture);
  // Candidates after filtering:
  //   INT 1.1-1.4 (23-24s)         — clean but slow
  //   INT 3.1-3.2 drill            — EXCLUDED (drill)
  //   INT 5.1 12.5s                — EXCLUDED (implausibly_fast)
  //   INT 7.1 17.4s                — adjacent_to_glitch → unverified
  //   INT 9.1 16.9s                — CLEAN, fastest
  //   INT 11.1 17.0s               — clean
  assert.equal(out.summary.best_25m_split_s, 16.9);
  assert.equal(out.summary.best_25m_context, 'INT 9.1');
  // Unverified best is INT 7.1
  assert.equal(out.summary.best_25m_unverified_s, 17.4);
});

test('best_25m_split_s ignores flying splits (L2 of a 50m), keeps standing starts', () => {
  // INT 1: a 50m rep — L1 17.2s (standing start), L2 15.0s (flying, turn-aided,
  //        the fastest length in the session and ABOVE the 13.0s glitch floor).
  // INT 3: a standalone 25m sprint @ 16.5s (standing start, clean).
  // The 15.0s flying split must NOT win — it's not a from-a-push 25m. The
  // standing-start 16.5s sprint is the true best.
  const csv = [
    '"","Intervals","Swim Stroke","Lengths","Distance","Time","Cumulative Time","Avg Pace","Best Pace","Avg. Swolf","Avg HR","Max HR","Total Strokes","Avg Strokes","Calories"',
    '"","1","Unknown","2","50","0:32.2","0:32.2","1:04","1:00","24","150","170","18","9.0","6"',
    '"","1.1","Unknown","--","25","0:17.2","--","--","--","--","--","--","9","--","--"',
    '"","1.2","Unknown","--","25","0:15.0","--","--","--","--","--","--","9","--","--"',
    '"","2","Rest","--","--","2:00.0","2:32.2","--","--","--","--","--","--","--","--"',
    '"","3","Unknown","1","25","0:16.5","2:48.7","1:06","1:06","24","160","170","7","7.0","3"',
    '"","3.1","Unknown","--","25","0:16.5","--","--","--","--","--","--","7","--","--"',
  ].join('\n') + '\n';

  const out = parseGarminCsv(csv);
  // Sanity: the 15.0s flying split is a clean freestyle length (the OLD parser
  // would have wrongly picked it as the best 25m).
  const flying = out.lengths.find(l => l.interval_number === 1 && l.length_in_interval === 2);
  assert.equal(flying.time_s, 15.0);
  assert.ok(flying.is_freestyle && !flying.is_drill && flying.glitches.length === 0);
  // The best 25m is the standing-start sprint, not the faster flying split.
  assert.equal(out.summary.best_25m_split_s, 16.5);
  assert.equal(out.summary.best_25m_context, 'INT 3.1');
});

test('best_threshold_pace_per_100m: picks the fastest sustained same-distance set (≥3 reps, avg rest ≤60s)', () => {
  // INT 1-4: 4×100m sustained at 1:32/100m (92s reps, 33s rest) → SHOULD WIN
  // INT 5-7: 3×50m race-pace at 1:08/100m BUT 3-min rest → EXCLUDED by rest filter
  const csv = [
    '"","Intervals","Swim Stroke","Lengths","Distance","Time","Cumulative Time","Avg Pace","Best Pace","Avg. Swolf","Avg HR","Max HR","Total Strokes","Avg Strokes","Calories"',
    '"","1","Unknown","4","100","1:32.0","1:32.0","1:32","1:28","32","150","160","40","10","18"',
    '"","1.1","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","1.2","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","1.3","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","1.4","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","","Rest","0","0","0:33.0","2:05.0","--","--","--","--","--","--","--","--"',
    '"","2","Unknown","4","100","1:32.0","3:37.0","1:32","1:28","32","150","160","40","10","18"',
    '"","2.1","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","2.2","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","2.3","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","2.4","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","","Rest","0","0","0:33.0","4:10.0","--","--","--","--","--","--","--","--"',
    '"","3","Unknown","4","100","1:32.0","5:42.0","1:32","1:28","32","150","160","40","10","18"',
    '"","3.1","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","3.2","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","3.3","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","3.4","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","","Rest","0","0","0:33.0","6:15.0","--","--","--","--","--","--","--","--"',
    '"","4","Unknown","4","100","1:32.0","7:47.0","1:32","1:28","32","150","160","40","10","18"',
    '"","4.1","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","4.2","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","4.3","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","4.4","Unknown","--","25","0:23.0","--","--","--","--","--","--","10","--","--"',
    '"","","Rest","0","0","3:00.0","10:47.0","--","--","--","--","--","--","--","--"',
    // 3×50m race-pace: faster pace, 3-min rest — must NOT count
    '"","5","Unknown","2","50","0:34.0","11:21.0","1:08","1:00","27","145","155","18","9","6"',
    '"","5.1","Unknown","--","25","0:18.0","--","--","--","--","--","--","9","--","--"',
    '"","5.2","Unknown","--","25","0:16.0","--","--","--","--","--","--","9","--","--"',
    '"","","Rest","0","0","3:00.0","14:21.0","--","--","--","--","--","--","--","--"',
    '"","6","Unknown","2","50","0:34.0","14:55.0","1:08","1:00","27","145","155","18","9","6"',
    '"","6.1","Unknown","--","25","0:18.0","--","--","--","--","--","--","9","--","--"',
    '"","6.2","Unknown","--","25","0:16.0","--","--","--","--","--","--","9","--","--"',
    '"","","Rest","0","0","3:00.0","17:55.0","--","--","--","--","--","--","--","--"',
    '"","7","Unknown","2","50","0:34.0","18:29.0","1:08","1:00","27","145","155","18","9","6"',
    '"","7.1","Unknown","--","25","0:18.0","--","--","--","--","--","--","9","--","--"',
    '"","7.2","Unknown","--","25","0:16.0","--","--","--","--","--","--","9","--","--"',
  ].join('\n') + '\n';
  const out = parseGarminCsv(csv);
  // 4×100m sustained at 1:32 wins. Race-pace 3×50m excluded by 3min rest filter.
  assert.equal(out.summary.best_threshold_pace_per_100m, '1:32');
});

test('best_threshold_pace_per_100m is null when no qualifying sustained set exists', () => {
  // Pure sprint session: only single-length 25m reps (multi-length filter excludes them).
  const csv = [
    '"","Intervals","Swim Stroke","Lengths","Distance","Time","Cumulative Time","Avg Pace","Best Pace","Avg. Swolf","Avg HR","Max HR","Total Strokes","Avg Strokes","Calories"',
    '"","1","Unknown","1","25","0:17.0","0:17.0","1:08","1:08","24","140","150","7","7","2"',
    '"","1.1","Unknown","--","25","0:17.0","--","--","--","--","--","--","7","--","--"',
    '"","","Rest","0","0","2:00.0","2:17.0","--","--","--","--","--","--","--","--"',
    '"","2","Unknown","1","25","0:16.8","2:34.0","1:07","1:07","24","140","150","7","7","2"',
    '"","2.1","Unknown","--","25","0:16.8","--","--","--","--","--","--","7","--","--"',
  ].join('\n') + '\n';
  const out = parseGarminCsv(csv);
  assert.equal(out.summary.best_threshold_pace_per_100m, null);
});

test('best_50m_split_s / best_100m_split_s pick the fastest full-distance reps', () => {
  // INT 1: a 100m rep (4 lengths, 96.0s). INT 3: a 50m rep (2 lengths, 33.0s).
  const csv = [
    '"","Intervals","Swim Stroke","Lengths","Distance","Time","Cumulative Time","Avg Pace","Best Pace","Avg. Swolf","Avg HR","Max HR","Total Strokes","Avg Strokes","Calories"',
    '"","1","Unknown","4","100","1:36.0","1:36.0","1:36","1:30","32","120","140","40","10.0","12"',
    '"","1.1","Unknown","--","25","0:24.0","--","--","--","--","--","--","10","--","--"',
    '"","1.2","Unknown","--","25","0:24.0","--","--","--","--","--","--","10","--","--"',
    '"","1.3","Unknown","--","25","0:24.0","--","--","--","--","--","--","10","--","--"',
    '"","1.4","Unknown","--","25","0:24.0","--","--","--","--","--","--","10","--","--"',
    '"","2","Rest","--","--","2:00.0","3:36.0","--","--","--","--","--","--","--","--"',
    '"","3","Unknown","2","50","0:33.0","4:09.0","1:06","1:00","24","150","165","18","9.0","6"',
    '"","3.1","Unknown","--","25","0:17.5","--","--","--","--","--","--","9","--","--"',
    '"","3.2","Unknown","--","25","0:15.5","--","--","--","--","--","--","9","--","--"',
  ].join('\n') + '\n';

  const out = parseGarminCsv(csv);
  assert.equal(out.summary.best_50m_split_s, 33.0);
  assert.equal(out.summary.best_50m_context, 'INT 3');
  assert.equal(out.summary.best_100m_split_s, 96.0);
  assert.equal(out.summary.best_100m_context, 'INT 1');
});

test('session-level aggregates compute correctly', () => {
  const out = parseGarminCsv(fixture);
  // 6 swim intervals: 100 + 50 + 25 + 25 + 25 + 25 = 250m
  assert.equal(out.summary.total_distance_m, 250);
  // Avg HR across swim intervals: (120+130+160+165+168+166)/6 = 151.5 → 152
  assert.equal(out.summary.avg_hr, 152);
  // Max HR across swim intervals: max(135,140,170,175,178,176) = 178
  assert.equal(out.summary.max_hr, 178);
});

test('synthetic-format numbered Rest intervals attribute rest_after_s', () => {
  const out = parseGarminCsv(fixture);
  // INT 1 (warm-up) is followed by INT 2 (Rest, 2:00 = 120s).
  const int1 = out.intervals.find(i => i.interval_number === 1);
  assert.equal(int1.rest_after_s, 120);
});

test('parser throws on file without Intervals column', () => {
  assert.throws(() => parseGarminCsv('foo,bar\n1,2\n'),
    /missing "Intervals" column/);
});
