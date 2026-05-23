import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  determineNextSession,
  pickPoolSubtype,
  activeFlags,
  isBlockComplete,
} from '../src/block-state.js';

// ──────────────────────────────────────────────────────────────────────────
// Synthetic catalogue helpers — keep rule tests self-contained so they don't
// drift as the real catalogue changes over time.
// ──────────────────────────────────────────────────────────────────────────

function makeCatalogue({
  phase = 1,
  blockNumber = 1,
  poolCount = 0,
  drylandCount = 0,
  plan = null,
  sessions = [],
} = {}) {
  const tracking = {
    current_block_number: blockNumber,
    current_block_pool_count: poolCount,
    current_block_dryland_count: drylandCount,
  };
  if (plan) tracking[`block_${blockNumber}_plan`] = plan;
  return {
    training_phase: { current: phase },
    weekly_block_tracking: tracking,
    sessions,
  };
}

function poolSession(id, date, subtype, extra = {}) {
  return { id, date, type: 'pool', subtype, distance_m: 1600, phase_at_time: 1, ...extra };
}

// ──────────────────────────────────────────────────────────────────────────
// isBlockComplete

test('isBlockComplete is true only at 3 pool + 1 dryland', () => {
  assert.equal(isBlockComplete({ pool: 3, dryland: 1 }), true);
  assert.equal(isBlockComplete({ pool: 3, dryland: 0 }), false);
  assert.equal(isBlockComplete({ pool: 2, dryland: 1 }), false);
  assert.equal(isBlockComplete({ pool: 4, dryland: 1 }), true);
});

// ──────────────────────────────────────────────────────────────────────────
// Anti-repetition subtype selection

test('pickPoolSubtype follows Phase 1 priority when nothing recent', () => {
  const cat = makeCatalogue({ sessions: [] });
  const r = pickPoolSubtype(cat, 1);
  assert.equal(r.subtype, 'sprint'); // top of Sprint > Technique > Threshold
  assert.equal(r.anti_repetition_warning, null);
});

test('pickPoolSubtype does not repeat the immediately previous subtype', () => {
  const cat = makeCatalogue({
    sessions: [
      poolSession(2, '2026-05-15', 'sprint'),     // previous session
      poolSession(1, '2026-05-13', 'technique'),
    ],
  });
  const r = pickPoolSubtype(cat, 1);
  // Previous was sprint → not sprint; technique outranks threshold → technique.
  assert.equal(r.subtype, 'technique');
});

test('pickPoolSubtype weights frequency toward higher phase priority', () => {
  // Self-play the picker, feeding each pick back as the most-recent session.
  const picks = [];
  let sessions = [];
  for (let i = 0; i < 6; i++) {
    const r = pickPoolSubtype(makeCatalogue({ sessions }), 1);
    picks.push(r.subtype);
    sessions = [poolSession(100 + i, `2026-05-1${i}`, r.subtype), ...sessions];
  }
  const n = s => picks.filter(p => p === s).length;
  assert.ok(n('sprint') > n('technique'), `sprint(${n('sprint')}) should exceed technique(${n('technique')})`);
  assert.ok(n('technique') >= n('threshold'), `technique(${n('technique')}) should be ≥ threshold(${n('threshold')})`);
  for (let i = 1; i < picks.length; i++) assert.notEqual(picks[i], picks[i - 1], 'no back-to-back repeat');
});

test('pickPoolSubtype flags repetition on an override that repeats the previous', () => {
  const cat = makeCatalogue({ sessions: [poolSession(3, '2026-05-15', 'sprint')] });
  const r = pickPoolSubtype(cat, 1, 'sprint');
  assert.equal(r.subtype, 'sprint');
  assert.match(r.anti_repetition_warning, /Repeats/);
});

// ──────────────────────────────────────────────────────────────────────────
// Block plan following

test('determineNextSession follows the block plan (Block 2 → session 3 sprint)', () => {
  const plan = [
    { session: 1, type: 'pool', subtype: 'threshold', status: 'completed' },
    { session: 2, type: 'dryland', subtype: 'pulling_strength', status: 'completed' },
    { session: 3, type: 'pool', subtype: 'sprint', status: 'upcoming' },
    { session: 4, type: 'pool', subtype: 'technique', status: 'upcoming' },
  ];
  const cat = makeCatalogue({ blockNumber: 2, poolCount: 1, drylandCount: 1, plan });
  const d = determineNextSession(cat);
  assert.equal(d.type, 'pool');
  assert.equal(d.subtype, 'sprint');
  assert.equal(d.session_in_block, 3);
  assert.equal(d.is_new_block, false);
  assert.match(d.rationale, /Following Block 2 plan/);
});

test('determineNextSession honours override but flags plan deviation', () => {
  const plan = [
    { session: 1, type: 'pool', subtype: 'threshold', status: 'completed' },
    { session: 2, type: 'dryland', subtype: 'pulling_strength', status: 'completed' },
    { session: 3, type: 'pool', subtype: 'sprint', status: 'upcoming' },
    { session: 4, type: 'pool', subtype: 'technique', status: 'upcoming' },
  ];
  const cat = makeCatalogue({ blockNumber: 2, poolCount: 1, drylandCount: 1, plan });
  const d = determineNextSession(cat, { explicit_subtype: 'technique' });
  assert.equal(d.subtype, 'technique');
  assert.equal(d.deviates_from_plan, true);
  assert.match(d.rationale, /overrode/);
});

test('advisory plan is ignored (external session diverged the block)', () => {
  const plan = [
    { session: 1, type: 'pool', subtype: 'threshold', status: 'completed' },
    { session: 2, type: 'dryland', subtype: 'pulling_strength', status: 'completed' },
    { session: 3, type: 'pool', subtype: 'sprint', status: 'upcoming' },
    { session: 4, type: 'pool', subtype: 'technique', status: 'upcoming' },
  ];
  const cat = makeCatalogue({
    blockNumber: 2, poolCount: 1, drylandCount: 1, plan,
    sessions: [
      poolSession(99, '2026-05-18', 'technique'), // external session, recent
      poolSession(98, '2026-05-16', 'sprint'),
    ],
  });
  cat.weekly_block_tracking.current_block_plan_advisory = true;
  const d = determineNextSession(cat);
  // Plan said session 3 = sprint, but advisory → priority-weighted scheduling.
  // Previous pool session was technique → avoid it; sprint (top priority) wins.
  assert.equal(d.block_plan, null);
  assert.equal(d.subtype, 'sprint');
  assert.match(d.rationale, /priority/);
});

// ──────────────────────────────────────────────────────────────────────────
// New block rollover

test('determineNextSession starts a new block when current is complete', () => {
  const cat = makeCatalogue({
    blockNumber: 2, poolCount: 3, drylandCount: 1,
    sessions: [
      poolSession(4, '2026-05-15', 'threshold'),
      poolSession(3, '2026-05-13', 'sprint'),
    ],
  });
  const d = determineNextSession(cat);
  assert.equal(d.is_new_block, true);
  assert.equal(d.block_number, 3);
  assert.equal(d.session_in_block, 1);
  // sprint + threshold recent → technique should be picked
  assert.equal(d.subtype, 'technique');
});

// ──────────────────────────────────────────────────────────────────────────
// Dryland forcing

test('determineNextSession forces dryland when pool quota met but dryland not', () => {
  const cat = makeCatalogue({ blockNumber: 3, poolCount: 3, drylandCount: 0 });
  const d = determineNextSession(cat);
  assert.equal(d.type, 'dryland');
  assert.match(d.rationale, /only remaining session/);
});

test('dryland subtype alternates block-to-block', () => {
  // No prior dryland → the pull-focused family.
  const d1 = determineNextSession(makeCatalogue({ blockNumber: 3, poolCount: 3, drylandCount: 0 }));
  assert.equal(d1.type, 'dryland');
  assert.equal(d1.subtype, 'pulling_strength');
  // Last dryland was pulling_strength → next dryland is the complementary one.
  const d2 = determineNextSession(makeCatalogue({
    blockNumber: 3, poolCount: 3, drylandCount: 0,
    sessions: [{ id: 9, date: '2026-05-18', type: 'dryland', subtype: 'pulling_strength' }],
  }));
  assert.equal(d2.type, 'dryland');
  assert.equal(d2.subtype, 'push_core_legs');
});

// ──────────────────────────────────────────────────────────────────────────
// Rotating dryland slot (option 1: block_number % 4)

test('fresh block 4 puts dryland on session 1 (slot S1)', () => {
  // drylandSlotForBlock(4): 4 % 4 = 0 → S1
  const cat = makeCatalogue({ blockNumber: 4, poolCount: 0, drylandCount: 0 });
  const d = determineNextSession(cat);
  assert.equal(d.dryland_slot, 1);
  assert.equal(d.type, 'dryland');
  assert.equal(d.session_in_block, 1);
  assert.match(d.rationale, /Dryland slot this block is session 1/);
});

test('fresh block 3 puts dryland on session 4, pool first', () => {
  // drylandSlotForBlock(3): 3 % 4 = 3 → S4
  const empty = makeCatalogue({ blockNumber: 3, poolCount: 0, drylandCount: 0 });
  const first = determineNextSession(empty);
  assert.equal(first.dryland_slot, 4);
  assert.equal(first.type, 'pool'); // session 1 ≠ slot 4 → pool
  assert.equal(first.dryland_still_due, true);

  // After 3 pool sessions, session 4 should be the dryland slot.
  const atSlot = makeCatalogue({ blockNumber: 3, poolCount: 3, drylandCount: 0 });
  const fourth = determineNextSession(atSlot);
  assert.equal(fourth.type, 'dryland');
  assert.equal(fourth.session_in_block, 4);
});

test('athlete can override the rotating dryland slot to pool, with a note', () => {
  // Block 4, slot S1 wants dryland on session 1 — athlete asks for pool.
  const cat = makeCatalogue({ blockNumber: 4, poolCount: 0, drylandCount: 0 });
  const d = determineNextSession(cat, { explicit_type: 'pool' });
  assert.equal(d.type, 'pool');
  assert.match(d.rationale, /dryland slot is session 1 this block — athlete chose pool/);
});

// ──────────────────────────────────────────────────────────────────────────
// Active flags

test('activeFlags pulls injury flags from most recent session', () => {
  const cat = makeCatalogue({
    sessions: [
      poolSession(17, '2026-05-18', 'threshold', {
        injury_flags: { left_quad_cramp: { onset: 'rep 6' } },
      }),
    ],
  });
  assert.deepEqual(activeFlags(cat), ['left_quad_cramp']);
});

test('activeFlags includes prior session flag if within 7 days', () => {
  const cat = makeCatalogue({
    sessions: [
      poolSession(18, '2026-05-19', 'technique'),
      poolSession(17, '2026-05-18', 'threshold', {
        injury_flags: { left_quad_cramp: {} },
      }),
    ],
  });
  assert.deepEqual(activeFlags(cat), ['left_quad_cramp']);
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 2/3 stub

test('phase 2 uses race-pace priority (Speed Integration)', () => {
  const cat = makeCatalogue({ phase: 2 });
  const d = determineNextSession(cat);
  assert.equal(d.type, 'pool');
  assert.equal(d.subtype, 'race_pace'); // top of Race-Pace > Sprint > Technique
});

test('phase 3 uses race-pace priority (Race Sharpening)', () => {
  const cat = makeCatalogue({ phase: 3 });
  const d = determineNextSession(cat);
  assert.equal(d.subtype, 'race_pace'); // top of Race Simulation > Sprint > Recovery
});

test('determineNextSession throws for a genuinely undefined phase', () => {
  const cat = makeCatalogue({ phase: 4 });
  assert.throws(() => determineNextSession(cat), /Phase 4 is not defined/);
});

// ──────────────────────────────────────────────────────────────────────────
// Real catalogue snapshot (integration) — guarded so it skips if file moved.

const realCataloguePath = join(
  __dirnameSafe(),
  '..', '..', 'Swimming Coach_code', 'athlete_catalogue.json'
);

function __dirnameSafe() {
  return dirname(fileURLToPath(import.meta.url));
}

if (existsSync(realCataloguePath)) {
  test('real catalogue → next session is Block 2 Session 3 Sprint', () => {
    const cat = JSON.parse(readFileSync(realCataloguePath, 'utf8'));
    const d = determineNextSession(cat);
    assert.equal(d.block_number, 2);
    assert.equal(d.session_in_block, 3);
    assert.equal(d.type, 'pool');
    assert.equal(d.subtype, 'sprint');
  });
} else {
  test('real catalogue not found — skipping integration test', { skip: true }, () => {});
}
