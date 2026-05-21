import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSession,
  validateCatalogue,
  nextSessionId,
  appendSession,
  drylandSlotForBlock,
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
