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
    training_phase: {
      current: 1,
      phase_goals: { swolf_target: 30, best_25m_target_s: 14.0, best_50m_target_s: 30.0 },
    },
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
  assert.equal(t.phase_25m_target_s, 14.0);
});

// ──────────────────────────────────────────────────────────────────────────
// Threshold targets

test('threshold targets: sustainable-pace best -3s/100m, swolf stepped toward phase goal', () => {
  const t = computeTargets(catalogue(), 'threshold');
  // best threshold pace 1:36 = 96s → -3 = 93s = 1:33 (matches Block 2 plan)
  assert.equal(t.main_set_pace_target, '1:33');
  assert.equal(t.main_set_pace_basis, '1:36');
  // swolf best 31 - 1 = 30, which equals phase floor (30) → 30
  assert.equal(t.swolf_target, 30);
});

test('swolf target never undershoots the phase goal', () => {
  const cat = catalogue();
  cat.rolling_bests.best_avg_swolf = 30; // already at goal
  const t = computeTargets(cat, 'threshold');
  // 30 - 1 = 29, but phase floor is 30 → clamped to 30
  assert.equal(t.swolf_target, 30);
});

// ──────────────────────────────────────────────────────────────────────────
// Race-pace targets

test('race_pace targets: 50m best -1s', () => {
  const t = computeTargets(catalogue(), 'race_pace');
  assert.equal(t.beat_50m_s, 38.0);
  assert.equal(t.stretch_50m_s, 37.0);
  assert.equal(t.phase_50m_target_s, 30.0);
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
    const sprint = computeTargets(cat, 'sprint');
    assert.equal(sprint.beat_25m_s, 16.8);       // current sprint protocol best
    assert.equal(sprint.stretch_25m_s, 16.5);    // stretch
    assert.equal(sprint.sprint_swolf_target, 23); // 24 - 1
    const thresh = computeTargets(cat, 'threshold');
    assert.equal(thresh.main_set_pace_target, '1:33'); // 1:36 seed - 3s
  });
} else {
  test('real catalogue not found — skipping targets integration', { skip: true }, () => {});
}
