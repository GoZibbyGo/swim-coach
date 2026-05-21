import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateGeneratedSession } from '../src/validator.js';
import { guidanceForFlags, restrictionsForFlags } from '../src/flag-rules.js';

// A known-good sprint session, modelled on Block2_Session3_Sprint.md (1600m).
function validSprintSession(overrides = {}) {
  return structuredClone({
    date: '2026-05-20', type: 'pool', subtype: 'sprint', phase: 1,
    block_number: 2, session_in_block: 3,
    total_volume_m: 1600,
    blocks: [
      { name: 'Warm-Up', volume_m: 400, sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
      { name: 'Drill Block', volume_m: 200, sets: [
        { reps: 4, distance_m: 25, effort: 'drill', rest_s: 30 },
        { reps: 4, distance_m: 25, effort: 'drill', rest_s: 20 },
      ] },
      { name: 'Priming Set', volume_m: 100, sets: [{ reps: 4, distance_m: 25, effort: 'build', rest_s: 90 }] },
      { name: 'Sprint Main Set', volume_m: 250, sets: [{ reps: 10, distance_m: 25, effort: 'max', rest_s: 120 }] },
      { name: 'Race Simulation', volume_m: 300, sets: [{ reps: 6, distance_m: 50, effort: 'near-max', rest_s: 180 }] },
      { name: 'Sprint Finish', volume_m: 150, sets: [{ reps: 6, distance_m: 25, effort: 'max', rest_s: 120 }] },
      { name: 'Cool-Down', volume_m: 200, sets: [{ reps: 8, distance_m: 25, effort: 'easy', rest_s: 0 }] },
    ],
    targets: { beat_25m_s: 16.8, sprint_swolf_target: 23 },
    ...overrides,
  });
}

function validThresholdSession(overrides = {}) {
  return structuredClone({
    date: '2026-05-20', type: 'pool', subtype: 'threshold', phase: 1,
    total_volume_m: 2500,
    blocks: [
      { name: 'Warm-Up', volume_m: 400, sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
      { name: 'Drill Block', volume_m: 200, sets: [{ reps: 8, distance_m: 25, effort: 'drill', rest_s: 20 }] },
      { name: 'Main Set', volume_m: 1600, sets: [{ reps: 8, distance_m: 200, effort: '85%', rest_s: 40 }] },
      { name: 'Sprint Finish', volume_m: 150, sets: [{ reps: 6, distance_m: 25, effort: 'max', rest_s: 120 }] },
      { name: 'Cool-Down', volume_m: 150, sets: [{ reps: 6, distance_m: 25, effort: 'easy', rest_s: 0 }] },
    ],
    targets: { main_set_pace_target: '1:33' },
    ...overrides,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Happy path

test('valid sprint session passes with no errors', () => {
  const r = validateGeneratedSession(validSprintSession());
  assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
  assert.equal(r.computed_total_m, 1600);
});

test('valid threshold session passes', () => {
  const r = validateGeneratedSession(validThresholdSession());
  assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// Distance checks

test('flags total-volume mismatch', () => {
  const r = validateGeneratedSession(validSprintSession({ total_volume_m: 1700 }));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /Total volume 1700m ≠ sum of blocks 1600m/.test(e)));
});

test('flags block-volume mismatch', () => {
  const s = validSprintSession();
  s.blocks[0].volume_m = 500; // says 500, sets compute 400
  const r = validateGeneratedSession(s);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /Warm-Up.*stated volume 500m ≠ computed 400m/.test(e)));
});

// ──────────────────────────────────────────────────────────────────────────
// Rest checks

test('flags sprint rep with <2min rest', () => {
  const s = validSprintSession();
  s.blocks[3].sets[0].rest_s = 60; // Sprint Main Set
  const r = validateGeneratedSession(s);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /sprint reps need ≥120s/.test(e)));
});

test('flags threshold set >400m with <30s rest', () => {
  const s = validThresholdSession();
  // Replace main set with 4×500 at 20s rest (=2000m), rebalance total.
  s.blocks[2] = { name: 'Main Set', volume_m: 2000, sets: [{ reps: 4, distance_m: 500, effort: '80%', rest_s: 20 }] };
  s.total_volume_m = 400 + 200 + 2000 + 150 + 150; // 2900
  const r = validateGeneratedSession(s);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /sets >400m need ≥30s/.test(e)));
});

// ──────────────────────────────────────────────────────────────────────────
// Structure & volume

test('flags missing cool-down', () => {
  const s = validSprintSession();
  s.blocks = s.blocks.filter(b => b.name !== 'Cool-Down');
  s.total_volume_m = 1400;
  const r = validateGeneratedSession(s);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /missing a cool-down/.test(e)));
});

test('warns when total volume is outside subtype range', () => {
  const s = validSprintSession();
  // Make it 1200m (below sprint 1600-1800) with consistent maths.
  s.blocks = [
    { name: 'Warm-Up', volume_m: 400, sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
    { name: 'Main Set', volume_m: 600, sets: [{ reps: 24, distance_m: 25, effort: 'max', rest_s: 120 }] },
    { name: 'Cool-Down', volume_m: 200, sets: [{ reps: 8, distance_m: 25, effort: 'easy', rest_s: 0 }] },
  ];
  s.total_volume_m = 1200;
  const r = validateGeneratedSession(s);
  assert.equal(r.valid, true); // volume is a warning, not an error
  assert.ok(r.warnings.some(w => /outside the sprint target range 1600-1800m/.test(w)));
});

// ──────────────────────────────────────────────────────────────────────────
// Flag respect (warnings, negation-aware)

test('warns when active quad flag and session prescribes dolphin kick', () => {
  const s = validSprintSession();
  s.blocks[2].cue = 'Drive the dolphin kick hard off every wall';
  const r = validateGeneratedSession(s, { activeFlags: ['left_quad_cramp'] });
  assert.ok(r.warnings.some(w => /Left quad cramp.*dolphin kick/.test(w)),
    `warnings: ${JSON.stringify(r.warnings)}`);
});

test('does NOT warn when dolphin kick is explicitly negated', () => {
  const s = validSprintSession();
  s.blocks[2].cue = 'No dolphin kick today — push and glide only';
  const r = validateGeneratedSession(s, { activeFlags: ['left_quad_cramp'] });
  assert.ok(!r.warnings.some(w => /dolphin kick/.test(w)),
    `warnings: ${JSON.stringify(r.warnings)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// Flag rules helpers

test('guidanceForFlags returns guidance text for active flags', () => {
  const g = guidanceForFlags(['left_quad_cramp']);
  assert.match(g, /No dolphin kick/);
  assert.equal(guidanceForFlags([]), '');
  assert.equal(guidanceForFlags(['nonexistent_flag']), '');
});

test('restrictionsForFlags ignores unknown flags', () => {
  assert.equal(restrictionsForFlags(['left_quad_cramp', 'bogus']).length, 1);
});
