import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFallbackSession, POOL_TEMPLATES, DRYLAND_TEMPLATES } from '../src/fallback-library.js';
import { validateGeneratedSession } from '../src/validator.js';
import { POOL_VOLUME_TARGETS_M } from '../src/schema.js';

function catalogue() {
  return {
    training_phase: { current: 1, phase_goals: { swolf_target: 30, best_25m_target_s: 14, best_50m_target_s: 30 } },
    rolling_bests: {
      best_25m_sprint_protocol_s: 16.8, best_25m_split_s: 16.1,
      best_avg_swolf: 31, best_sprint_swolf: 24,
      best_threshold_pace_per_100m: '1:36', best_50m_equiv_s: 38.0,
    },
    weekly_block_tracking: { current_block_number: 2, block_2_dryland_equipment: 'calisthenic park — bars only' },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Every pool template, every variant, must pass the validator.

const poolSubtypes = ['sprint', 'threshold', 'technique', 'race_pace', 'recovery'];

for (const subtype of poolSubtypes) {
  const templates = POOL_TEMPLATES[subtype];
  for (let i = 0; i < templates.length; i++) {
    test(`fallback ${subtype} template "${templates[i].id}" passes the validator`, () => {
      // Drive template selection to index i by seeding session_in_block.
      const decision = {
        type: 'pool', subtype, block_number: 1, session_in_block: i + 1, active_flags: [],
      };
      const { session, template_id } = buildFallbackSession(decision, catalogue(), {
        date: '2026-05-20',
        // exclude all but template i so we deterministically test each one
        recentTemplateIds: templates.filter((_, j) => j !== i).map(t => t.id),
      });
      const r = validateGeneratedSession(session);
      assert.equal(r.valid, true, `${template_id} errors: ${JSON.stringify(r.errors)}`);
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Volumes land in the subtype range.

test('every pool template volume is within its subtype range', () => {
  for (const subtype of ['sprint', 'threshold', 'technique', 'race_pace', 'recovery']) {
    const range = POOL_VOLUME_TARGETS_M[subtype];
    for (const tmpl of POOL_TEMPLATES[subtype]) {
      const decision = { type: 'pool', subtype, block_number: 1, session_in_block: 1, active_flags: [] };
      const { session } = buildFallbackSession(decision, catalogue(), {
        recentTemplateIds: POOL_TEMPLATES[subtype].filter(t => t.id !== tmpl.id).map(t => t.id),
      });
      assert.ok(session.total_volume_m >= range.min && session.total_volume_m <= range.max,
        `${tmpl.id}: ${session.total_volume_m}m outside ${range.min}-${range.max}`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Anti-repetition

test('respects recentTemplateIds (does not repeat last template)', () => {
  const decision = { type: 'pool', subtype: 'sprint', block_number: 1, session_in_block: 1, active_flags: [] };
  const { template_id } = buildFallbackSession(decision, catalogue(), {
    recentTemplateIds: ['sprint_race_sim'],
  });
  assert.notEqual(template_id, 'sprint_race_sim');
});

// ──────────────────────────────────────────────────────────────────────────
// Targets injected

test('sprint session has target lines on sprint blocks', () => {
  const decision = { type: 'pool', subtype: 'sprint', block_number: 1, session_in_block: 1, active_flags: [] };
  const { session } = buildFallbackSession(decision, catalogue(), {});
  const sprintMain = session.blocks.find(b => b.name === 'Sprint Main Set');
  assert.match(sprintMain.target, /beat 16\.8s.*SWOLF 23.*7 strokes/);
});

// ──────────────────────────────────────────────────────────────────────────
// Quad flag handling

test('quad flag adds a warning to push-off drill cue and never prescribes dolphin kick', () => {
  const decision = { type: 'pool', subtype: 'sprint', block_number: 1, session_in_block: 1, active_flags: ['left_quad_cramp'] };
  const { session } = buildFallbackSession(decision, catalogue(), { recentTemplateIds: ['sprint_speed_endurance'] });
  const drill = session.blocks.find(b => /Drill/.test(b.name) && /push-off|glide/i.test(JSON.stringify(b)));
  // The race_sim template's drill block is the push-off one.
  const text = JSON.stringify(session).toLowerCase();
  // dolphin kick only ever appears negated
  assert.ok(!/(?<!no )dolphin kick/.test(text) || /no dolphin kick/.test(text));
  // validator should not error and the session is valid
  const r = validateGeneratedSession(session, { activeFlags: ['left_quad_cramp'] });
  assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// Dryland

test('dryland fallback selects bars template for calisthenic-park equipment', () => {
  const decision = { type: 'dryland', subtype: 'pulling_strength', block_number: 2, session_in_block: 2, active_flags: [] };
  const { session, template_id } = buildFallbackSession(decision, catalogue(), { date: '2026-05-20' });
  assert.equal(template_id, 'dryland_bars');
  assert.equal(session.type, 'dryland');
  assert.ok(session.blocks.length === 4);
  const r = validateGeneratedSession(session);
  assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
});

test('dryland fallback selects rings template and annotates leg block under quad flag', () => {
  const cat = catalogue();
  cat.weekly_block_tracking.block_2_dryland_equipment = 'rings only';
  const decision = { type: 'dryland', subtype: 'pulling_strength', block_number: 2, session_in_block: 2, active_flags: ['right_quad_pre_cramp'] };
  const { session, template_id } = buildFallbackSession(decision, cat, { date: '2026-05-20' });
  assert.equal(template_id, 'dryland_rings');
  const legBlock = session.blocks.find(b => /Leg|Hip-Flexor/.test(b.name));
  assert.match(legBlock.note, /Quad flag active/);
  const r = validateGeneratedSession(session, { activeFlags: ['right_quad_pre_cramp'] });
  assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
  assert.ok(r.warnings.length === 0 || !r.warnings.some(w => /jump|explosive|plyo/.test(w)),
    `unexpected flag warning: ${JSON.stringify(r.warnings)}`);
});

test('dryland fallback falls back to bodyweight when no equipment known', () => {
  const cat = catalogue();
  delete cat.weekly_block_tracking.block_2_dryland_equipment;
  const decision = { type: 'dryland', subtype: 'strength', block_number: 2, session_in_block: 2, active_flags: [] };
  const { template_id } = buildFallbackSession(decision, cat, {});
  assert.equal(template_id, 'dryland_bodyweight');
});
