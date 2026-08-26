import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  computeTargets,
  paceToSeconds,
  secondsToPace,
  TARGET_STEPS,
} from '../src/targets.js';
import { migrateCatalogue } from '../src/schema.js';

// ──────────────────────────────────────────────────────────────────────────
// Pace conversion

test('paceToSeconds and secondsToPace round-trip', () => {
  assert.equal(paceToSeconds('1:36'), 96);
  assert.equal(secondsToPace(96), '1:36');
  assert.equal(secondsToPace(93), '1:33');
  assert.equal(secondsToPace(60), '1:00');
  assert.equal(secondsToPace(119.6), '2:00'); // rounds up cleanly
});

// ──────────────────────────────────────────────────────────────────────────
// Synthetic catalogue mirroring the real rolling_bests as of session 17/18.

function catalogue() {
  return {
    // Phase milestones now come live from phases.js, not a static phase_goals.
    training_phase: { current: 1 },
    rolling_bests: {
      best_25m_split_s: 16.1,
      best_25m_sprint_protocol_s: 16.8,
      best_avg_swolf: 31,
      best_sprint_swolf: 24,
      best_avg_pace_per_100m: '1:27',
      best_threshold_pace_per_100m: '1:36',
      best_50m_equiv_s: 38.0,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Sprint targets

test('sprint targets: beat current best, stretch -0.3s, swolf best -1', () => {
  const t = computeTargets(catalogue(), 'sprint');
  assert.equal(t.beat_25m_s, 16.8);
  assert.equal(t.stretch_25m_s, 16.5);          // 16.8 - 0.3
  assert.equal(t.sprint_swolf_target, 23);       // 24 - 1
  assert.equal(t.stroke_count_target, 7);
  assert.equal(t.phase_25m_target_s, 15.5);      // Phase-1 25m milestone (live from phases.js)
});

test('sprint targets: implied_50m_from_stretch is arithmetically possible (>2×stretch)', () => {
  const t = computeTargets(catalogue(), 'sprint');
  // stretch 16.5 → implied 50m = 2 × 16.5 + 1.0 (turn_cost) = 34.0s.
  // Round-5 fix: was 2×stretch − 1.5 which gave an IMPOSSIBLE 29.9 vs 31.4
  // (a 50m can't be faster than 2 unassisted 25s at max effort).
  assert.equal(t.implied_50m_from_stretch_s, 34.0);
  assert.ok(t.implied_50m_from_stretch_s > 2 * t.stretch_25m_s,
    `implied_50m must exceed 2×stretch, got ${t.implied_50m_from_stretch_s} vs ${2 * t.stretch_25m_s}`);
});

test('sprint targets: phase_goal_50m_s is a separate long-horizon field', () => {
  const t = computeTargets(catalogue(), 'sprint');
  assert.equal(t.phase_goal_50m_s, 33.0); // Phase-1 50m milestone
  assert.notEqual(t.phase_goal_50m_s, t.implied_50m_from_stretch_s,
    'phase_goal_50m_s (long-horizon) must not be conflated with today\'s implied_50m');
});

test('sprint targets: re-entry flag + de-rated anchor when last pool > 10 days ago', () => {
  const cat = catalogue();
  // Simulate a 20-day layoff by inserting a stale pool session as the most recent.
  cat.sessions = [{ id: 1, date: '2026-01-01', type: 'pool', subtype: 'sprint' }];
  const t = computeTargets(cat, 'sprint', { date: '2026-01-25' });
  assert.equal(t.re_entry, true);
  assert.ok(t.days_since_last_pool >= 10);
  // Anchor de-rated from 16.8 by 2.5% → 17.2.
  assert.ok(t.beat_25m_s > 16.8, `expected de-rated anchor > 16.8, got ${t.beat_25m_s}`);
  assert.equal(t.pre_layoff_beat_25m_s, 16.8);
});

test('sprint targets: no re-entry when the last pool was recent', () => {
  const cat = catalogue();
  cat.sessions = [{ id: 1, date: '2026-01-24', type: 'pool', subtype: 'sprint' }];
  const t = computeTargets(cat, 'sprint', { date: '2026-01-25' });
  assert.equal(t.re_entry, false);
});

// ──────────────────────────────────────────────────────────────────────────
// Threshold targets

test('threshold targets: effort-based (no /100m pace target), swolf stepped toward phase goal', () => {
  const t = computeTargets(catalogue(), 'threshold');
  // No /100m pace target — the watch shows no live pace, so threshold is
  // prescribed by effort + stroke-count + SWOLF.
  assert.equal(t.main_set_pace_target, undefined);
  assert.match(t.effort, /RPE/);
  assert.equal(t.stroke_count_target, 9);
  assert.equal(t.pace_context_per_100m, '1:36'); // kept as analysis context only
  // swolf best 31 - 1 = 30; Phase-1 SWOLF milestone (floor) is 27; 30 ≥ 27 → 30
  assert.equal(t.swolf_target, 30);
});

test('swolf target never undershoots the current phase milestone', () => {
  const cat = catalogue();
  cat.rolling_bests.best_avg_swolf = 27; // sitting at the Phase-1 milestone
  const t = computeTargets(cat, 'threshold');
  // 27 - 1 = 26, but the Phase-1 SWOLF milestone (floor) is 27 → clamped to 27
  assert.equal(t.swolf_target, 27);
});

// ──────────────────────────────────────────────────────────────────────────
// Race-pace targets

test('race_pace targets: 50m best -1s', () => {
  const t = computeTargets(catalogue(), 'race_pace');
  assert.equal(t.beat_50m_s, 38.0);
  assert.equal(t.stretch_50m_s, 37.0);
  assert.equal(t.phase_50m_target_s, 33.0);      // Phase-1 50m milestone (live from phases.js)
});

test('phase target references follow the CURRENT phase, not a static goal', () => {
  const cat = catalogue();
  cat.training_phase.current = 2;
  assert.equal(computeTargets(cat, 'sprint').phase_25m_target_s, 14.5);   // P2 25m milestone
  assert.equal(computeTargets(cat, 'race_pace').phase_50m_target_s, 31.0); // P2 50m milestone
  // SWOLF floor also tightens with the phase: P2 milestone is 25.
  cat.rolling_bests.best_avg_swolf = 25;
  assert.equal(computeTargets(cat, 'threshold').swolf_target, 25);         // 25-1=24 < 25 → clamp to 25
});

// ──────────────────────────────────────────────────────────────────────────
// Recovery + unknown

test('recovery returns no performance targets', () => {
  const t = computeTargets(catalogue(), 'recovery');
  assert.equal(t.swolf_target, null);
  assert.match(t.note, /Recovery/);
});

test('missing rolling_bests yields null targets, not crashes', () => {
  const t = computeTargets({ training_phase: { current: 1 }, rolling_bests: {} }, 'sprint');
  assert.equal(t.beat_25m_s, null);
  assert.equal(t.stretch_25m_s, null);
});

// ──────────────────────────────────────────────────────────────────────────
// Real catalogue snapshot

const realPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'Swimming Coach_code', 'athlete_catalogue.json'
);

test('migrateCatalogue seeds best_threshold_pace_per_100m only when absent', () => {
  const seeded = migrateCatalogue({ rolling_bests: {} });
  assert.equal(seeded.rolling_bests.best_threshold_pace_per_100m, '1:36');
  // Does not overwrite an existing value.
  const existing = migrateCatalogue({ rolling_bests: { best_threshold_pace_per_100m: '1:30' } });
  assert.equal(existing.rolling_bests.best_threshold_pace_per_100m, '1:30');
});

if (existsSync(realPath)) {
  test('real catalogue (migrated) → sprint + threshold targets correct', () => {
    const raw = JSON.parse(readFileSync(realPath, 'utf8'));
    const cat = migrateCatalogue(raw);
    // Pin to a date within 10 days of the most recent pool session so the
    // round-5 layoff de-rating doesn't perturb the base-target assertions.
    // The catalogue's most-recent pool date drifts as sessions get logged;
    // pull it from the data rather than hardcoding.
    const mostRecentPool = (cat.sessions ?? [])
      .filter(s => s?.type === 'pool' && s?.date)
      .map(s => s.date)
      .sort()
      .pop();
    const sprint = computeTargets(cat, 'sprint', { date: mostRecentPool });
    assert.equal(sprint.beat_25m_s, 16.8);       // current sprint protocol best
    assert.equal(sprint.stretch_25m_s, 16.5);    // stretch
    assert.equal(sprint.sprint_swolf_target, 23); // 24 - 1
    const thresh = computeTargets(cat, 'threshold', { date: mostRecentPool });
    assert.equal(thresh.main_set_pace_target, undefined); // no /100m pace target
    assert.match(thresh.effort, /RPE/);                   // effort-based instead
  });
} else {
  test('real catalogue not found — skipping targets integration', { skip: true }, () => {});
}
