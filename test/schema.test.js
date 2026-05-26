import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSession,
  validateCatalogue,
  nextSessionId,
  appendSession,
  drylandSlotForBlock,
  migrateCatalogue,
  SESSION_TYPES,
  POOL_SUBTYPES,
} from '../src/schema.js';

test('SESSION_TYPES and POOL_SUBTYPES are frozen', () => {
  assert.throws(() => { SESSION_TYPES.push('x'); }, TypeError);
  assert.throws(() => { POOL_SUBTYPES.push('x'); }, TypeError);
});

test('drylandSlotForBlock rotates 1→S1, 2→S2, 3→S3, 4→S4, 5→S1', () => {
  // block_number % 4 → 0=S1, 1=S2, 2=S3, 3=S4
  assert.equal(drylandSlotForBlock(4), 1);   // 4 % 4 = 0 → S1
  assert.equal(drylandSlotForBlock(1), 2);   // 1 % 4 = 1 → S2
  assert.equal(drylandSlotForBlock(2), 3);   // 2 % 4 = 2 → S3
  assert.equal(drylandSlotForBlock(3), 4);   // 3 % 4 = 3 → S4
  assert.equal(drylandSlotForBlock(5), 2);   // 5 % 4 = 1 → S2
});

test('validateSession accepts a minimal pool session', () => {
  const s = {
    id: 1, date: '2026-05-19', type: 'pool', subtype: 'sprint',
    distance_m: 1600, phase_at_time: 1,
  };
  const r = validateSession(s);
  assert.equal(r.valid, true, `errors: ${r.errors.join('; ')}`);
});

test('validateSession rejects pool session without distance_m', () => {
  const s = { id: 1, date: '2026-05-19', type: 'pool', subtype: 'sprint' };
  const r = validateSession(s);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /distance_m/.test(e)));
});

test('validateSession rejects bad date format', () => {
  const s = { id: 1, date: '19/05/2026', type: 'pool', subtype: 'sprint', distance_m: 1600 };
  const r = validateSession(s);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /YYYY-MM-DD/.test(e)));
});

test('validateSession warns (does not fail) on unknown pool subtype', () => {
  const s = { id: 1, date: '2026-05-19', type: 'pool', subtype: 'aerobic', distance_m: 1600 };
  const r = validateSession(s);
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some(w => /subtype/.test(w)));
});

test('validateSession requires dryland.exercises array for dryland sessions', () => {
  const s = { id: 2, date: '2026-05-19', type: 'dryland', subtype: 'strength' };
  const r = validateSession(s);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /dryland/.test(e)));
});

test('validateSession accepts dryland with exercises', () => {
  const s = {
    id: 2, date: '2026-05-19', type: 'dryland', subtype: 'strength',
    dryland: { exercises: [{ name: 'Pull-Ups', sets: 4, reps_per_set: [8,5,5,4] }] },
  };
  const r = validateSession(s);
  assert.equal(r.valid, true, `errors: ${r.errors.join('; ')}`);
});

test('nextSessionId returns 1 for empty catalogue, max+1 otherwise', () => {
  assert.equal(nextSessionId({ sessions: [] }), 1);
  assert.equal(nextSessionId({}), 1);
  assert.equal(nextSessionId({ sessions: [{ id: 5 }, { id: 17 }, { id: 12 }] }), 18);
});

test('appendSession prepends and validates', () => {
  const cat = { sessions: [{ id: 1, date: '2026-05-19', type: 'pool', subtype: 'sprint', distance_m: 1600 }] };
  const out = appendSession(cat, {
    id: 2, date: '2026-05-20', type: 'pool', subtype: 'threshold', distance_m: 2500,
  });
  assert.equal(out.sessions.length, 2);
  assert.equal(out.sessions[0].id, 2); // most-recent-first
  assert.throws(() => appendSession(cat, { id: 3, type: 'pool' }), /failed validation/);
});

// ──────────────────────────────────────────────────────────────────────────
// One-time standing-start 25m scrub (migrateCatalogue)

function pollutedCatalogue() {
  return {
    rolling_bests: {
      // Polluted by a flying L2 split of a 50m rep.
      best_25m_sprint_protocol_s: 15.0,
      best_25m_sprint_protocol_date: '2026-05-22',
      best_25m_sprint_protocol_session_id: 20,
      best_25m_split_s: 15.0,
      best_avg_swolf: 27, // must be left untouched
    },
    training_phase: { current: 1 },
    weekly_block_tracking: {},
    sessions: [
      {
        id: 20, date: '2026-05-22', type: 'pool', subtype: 'sprint',
        metrics: { best_25m_split_s: 15.0, best_25m_split_context: 'INT 33.2' },
        breakdown: [
          { n: 5, is_drill: true, splits_s: [12.8] },          // drill push-off — excluded
          { n: 13, is_drill: false, splits_s: [25.6] },         // standing 25m, slow
          { n: 17, is_drill: false, splits_s: [16.6] },         // standing 25m, fastest = true best
          { n: 33, is_drill: false, splits_s: [19.3, 15.0] },   // 50m: L1 standing, L2 15.0 flying
        ],
      },
      {
        // Hand-authored, no breakdown — its stored standing-start best is kept.
        id: 17, date: '2026-05-18', type: 'pool', subtype: 'threshold',
        metrics: { best_25m_split_s: 16.8, best_25m_split_context: 'INT 20, sprint finish' },
      },
      {
        // Known-bad early reading — must be excluded from the rolling recompute.
        id: 10, date: '2026-04-08', type: 'pool', subtype: 'sprint',
        metrics: { best_25m_split_s: 16.1 },
      },
    ],
  };
}

test('migrateCatalogue scrub: flying split no longer sets the 25m best', () => {
  const out = migrateCatalogue(pollutedCatalogue());
  // The affected session is corrected to its real standing-start best.
  const recent = out.sessions.find(s => s.id === 20);
  assert.equal(recent.metrics.best_25m_split_s, 16.6);
  assert.match(recent.metrics.best_25m_split_context, /corrected/);
  // Rolling bests recomputed to the true standing-start PR (16.6, not 15.0).
  assert.equal(out.rolling_bests.best_25m_sprint_protocol_s, 16.6);
  assert.equal(out.rolling_bests.best_25m_split_s, 16.6);
  assert.equal(out.rolling_bests.best_25m_sprint_protocol_date, '2026-05-22');
  assert.equal(out.rolling_bests.best_25m_sprint_protocol_session_id, 20);
  // Unrelated bests are untouched.
  assert.equal(out.rolling_bests.best_avg_swolf, 27);
  assert.ok(out.migrations_applied.includes('standing_start_25m_v1'));
});

test('migrateCatalogue scrub: known-bad early reading (16.1) is excluded', () => {
  const out = migrateCatalogue(pollutedCatalogue());
  // 16.1 (2026-04-08) is faster than 16.6 but pre-cutoff — must not win.
  assert.notEqual(out.rolling_bests.best_25m_sprint_protocol_s, 16.1);
  assert.equal(out.rolling_bests.best_25m_sprint_protocol_s, 16.6);
  // The early session's own metric is left as-is (no breakdown to re-derive).
  assert.equal(out.sessions.find(s => s.id === 10).metrics.best_25m_split_s, 16.1);
});

test('migrateCatalogue scrub runs once and never re-stomps later bests', () => {
  const once = migrateCatalogue(pollutedCatalogue());
  // Simulate a genuine later PR set by the normal logging path.
  once.rolling_bests.best_25m_sprint_protocol_s = 16.0;
  once.rolling_bests.best_25m_split_s = 16.0;
  const twice = migrateCatalogue(once);
  assert.equal(twice.rolling_bests.best_25m_sprint_protocol_s, 16.0);
  assert.equal(twice.rolling_bests.best_25m_split_s, 16.0);
  assert.equal(twice.migrations_applied.filter(k => k === 'standing_start_25m_v1').length, 1);
});

test('migrateCatalogue backfills 50m/100m bests from breakdowns (improve-only)', () => {
  const c = {
    rolling_bests: { best_50m_equiv_s: 38.0, best_100m_split_s: 92.0 },
    training_phase: { current: 1 }, weekly_block_tracking: {},
    sessions: [
      {
        id: 30, date: '2026-05-22', type: 'pool', subtype: 'sprint',
        metrics: { best_25m_split_s: 16.6 },
        breakdown: [
          { n: 1, is_drill: false, time_s: 96.0, splits_s: [24.0, 24.0, 24.0, 24.0] }, // 100m, slower than 92 → ignored
          { n: 3, is_drill: false, time_s: 34.3, splits_s: [19.3, 15.0] },             // 50m, faster than 38 → wins
          { n: 7, is_drill: false, time_s: 16.6, splits_s: [16.6] },                   // standing 25m (keeps the scrub a no-op)
          { n: 5, is_drill: true,  time_s: 12.8, splits_s: [12.8] },                   // drill, ignored
        ],
      },
    ],
  };
  const out = migrateCatalogue(c);
  assert.equal(out.rolling_bests.best_50m_equiv_s, 34.3);
  assert.equal(out.rolling_bests.best_50m_equiv_session_id, 30);
  assert.equal(out.rolling_bests.best_50m_equiv_date, '2026-05-22');
  // The 100m rep (96.0) is slower than the existing 92.0 → not raised.
  assert.equal(out.rolling_bests.best_100m_split_s, 92.0);
  assert.ok(out.migrations_applied.includes('track_50m_100m_v1'));
});

test('50m/100m backfill is improve-only and runs once', () => {
  const c = {
    rolling_bests: { best_50m_equiv_s: 30.0 },
    training_phase: { current: 1 }, weekly_block_tracking: {},
    sessions: [
      { id: 31, date: '2026-05-23', type: 'pool', subtype: 'sprint',
        breakdown: [{ n: 1, is_drill: false, time_s: 34.3, splits_s: [19.3, 15.0] }] },
    ],
  };
  const out = migrateCatalogue(c);
  assert.equal(out.rolling_bests.best_50m_equiv_s, 30.0); // 34.3 must not raise a better 30.0
  const again = migrateCatalogue(out);
  assert.equal(again.migrations_applied.filter(k => k === 'track_50m_100m_v1').length, 1);
});

test('validateCatalogue catches duplicate session ids', () => {
  const cat = {
    athlete: {}, training_phase: {}, rolling_bests: {}, weekly_block_tracking: {},
    sessions: [
      { id: 1, date: '2026-05-19', type: 'pool', subtype: 'sprint', distance_m: 1600 },
      { id: 1, date: '2026-05-20', type: 'pool', subtype: 'threshold', distance_m: 2500 },
    ],
  };
  const r = validateCatalogue(cat);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /duplicate/.test(e)));
});
