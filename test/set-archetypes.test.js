import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SET_ARCHETYPES, REP_CLASSES, archetypeById, archetypesFor,
  recentArchetypeIds, archetypeMenuText,
} from '../src/set-archetypes.js';

// ──────────────────────────────────────────────────────────────────────────
// Catalogue integrity

test('every archetype is well-formed and uses a known rep_class', () => {
  const ids = new Set();
  for (const a of SET_ARCHETYPES) {
    assert.ok(a.id && !ids.has(a.id), `duplicate or missing id: ${a.id}`);
    ids.add(a.id);
    assert.ok(a.name && a.shape && a.trains, `${a.id} is missing descriptive fields`);
    assert.ok(REP_CLASSES.includes(a.rep_class), `${a.id} has unknown rep_class ${a.rep_class}`);
    assert.ok(Array.isArray(a.subtype_fit) && a.subtype_fit.length, `${a.id} has no subtype_fit`);
    assert.ok(Array.isArray(a.phase_fit) && a.phase_fit.length, `${a.id} has no phase_fit`);
  }
});

test('archetypeById round-trips and rejects unknown ids', () => {
  assert.equal(archetypeById('broken_50s').name, 'Broken 50s');
  assert.equal(archetypeById('not_a_real_archetype'), null);
});

// ──────────────────────────────────────────────────────────────────────────
// Coverage — the point of the module is that each subtype has real choice

test('every pool subtype has at least three Phase-1 archetypes to rotate through', () => {
  for (const subtype of ['sprint', 'technique', 'threshold']) {
    const n = archetypesFor(subtype, 1).length;
    assert.ok(n >= 3, `${subtype} only has ${n} Phase-1 archetype(s) — not enough to rotate`);
  }
});

test('the speed-endurance gap is covered for sprint sessions', () => {
  // The KB research finding: the programme was alactic + threshold with
  // nothing in the 30-35s glycolytic middle that the 50m actually is.
  const se = archetypesFor('sprint', 1).filter(a => a.rep_class === 'speed_endurance');
  assert.ok(se.length >= 3, `expected several speed_endurance sprint archetypes, got ${se.length}`);
});

test('kick work exists and never prescribes dolphin kick', () => {
  const kick = SET_ARCHETYPES.filter(a => a.id.startsWith('kick_'));
  assert.ok(kick.length >= 2, 'kick is ~30% of propulsive force — needs real options');
  for (const a of SET_ARCHETYPES) {
    assert.ok(!/dolphin/i.test(`${a.shape} ${a.trains}`) || /no dolphin/i.test(a.trains),
      `${a.id} must not prescribe dolphin kick (quad-cramp history)`);
  }
});

test('archetypesFor filters by phase as well as subtype', () => {
  assert.ok(archetypesFor('race_pace', 3).some(a => a.id === 'time_trial_50'));
  assert.ok(!archetypesFor('race_pace', 1).some(a => a.id === 'time_trial_50'),
    'a 50m time trial is a Phase-3 benchmark, not Phase-1 work');
});

// ──────────────────────────────────────────────────────────────────────────
// Rotation

test('recentArchetypeIds reads ids off same-subtype sessions only', () => {
  const cat = { sessions: [
    { subtype: 'sprint', plan: { archetype_id: 'broken_50s' } },
    { subtype: 'threshold', plan: { archetype_id: 'descending_200s' } },
    { subtype: 'sprint', plan: { archetype_id: 'alactic_25s' } },
    { subtype: 'sprint', plan: {} },
  ] };
  assert.deepEqual(recentArchetypeIds(cat, 'sprint'), ['broken_50s', 'alactic_25s']);
  assert.deepEqual(recentArchetypeIds(cat, 'threshold'), ['descending_200s']);
});

test('menu separates fresh archetypes from ones already used this rotation', () => {
  const menu = archetypeMenuText('sprint', 1, ['alactic_25s', 'broken_50s']);
  assert.match(menu, /ALREADY USED/);
  assert.match(menu, /alactic_25s \(Straight max 25s\)/);
  assert.match(menu, /do NOT pick these again/);
  // A fresh one still appears in the available list with its full description.
  assert.match(menu, /race_pace_25s — Race-pace 25s at goal tempo/);
});

test('menu is empty for an unknown subtype so the caller can omit the line', () => {
  assert.equal(archetypeMenuText('nonsense', 1, []), '');
});
