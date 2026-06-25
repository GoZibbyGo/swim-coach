import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderSessionMarkdown } from '../src/renderer.js';
import { buildFallbackSession } from '../src/fallback-library.js';

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

test('renders a pool session with tally, blocks, cues and tracking', () => {
  const decision = { type: 'pool', subtype: 'sprint', block_number: 2, session_in_block: 3, active_flags: [] };
  const { session } = buildFallbackSession(decision, catalogue(), { date: '2026-05-20' });
  const md = renderSessionMarkdown(session);

  assert.match(md, /# Block 2 · Session 3 — Sprint/);
  assert.match(md, /## Distance Tally/);
  assert.match(md, /\*\*Total\*\* \| \| \*\*\d+m\*\*/);
  assert.match(md, /Coach cue:/);
  assert.match(md, /What to track this session/);
  assert.match(md, /Phase 1 Progress/);
  assert.match(md, /log it using the Session Logger/);
});

test('renders a dryland session with exercises and rationale', () => {
  const decision = { type: 'dryland', subtype: 'pulling_strength', block_number: 2, session_in_block: 2, active_flags: ['right_quad_pre_cramp'] };
  const { session } = buildFallbackSession(decision, catalogue(), { date: '2026-05-20' });
  const md = renderSessionMarkdown(session);

  assert.match(md, /# Block 2 · Session 2 — Dryland/);
  assert.match(md, /Block A — Core/);
  assert.match(md, /Block D — Controlled Leg/);
  assert.match(md, /Quad flag active/);
  assert.match(md, /Pull-ups/);
  assert.match(md, /Any PRs/);
});

test('single-rep blocks (warm-ups / continuous swims) omit rest_s in the rendered card', () => {
  const session = {
    type: 'pool', subtype: 'technique', block_number: 1, session_in_block: 1, phase: 1,
    total_volume_m: 400, date: '2026-05-20',
    blocks: [
      // 1×400 with rest_s set → must NOT render "0s rest" or "30s rest"
      { name: 'Warm-up', volume_m: 400, sets: [{ reps: 1, distance_m: 400, effort: 'easy', rest_s: 30 }] },
      // 4×100 with rest_s set → MUST still render the rest
      { name: 'Main', volume_m: 400, sets: [{ reps: 4, distance_m: 100, effort: 'moderate', rest_s: 20 }] },
    ],
  };
  const md = renderSessionMarkdown(session);
  // Single-rep warm-up: head shows "1×400m" but no "rest" suffix.
  const wuLine = md.split('\n').find(l => /1×400m/.test(l));
  assert.ok(wuLine, 'expected a warm-up line');
  assert.ok(!/rest/.test(wuLine), `single-rep warm-up should not show rest, got: "${wuLine}"`);
  // Multi-rep main set still shows rest.
  const mainLine = md.split('\n').find(l => /4×100m/.test(l));
  assert.match(mainLine, /20s rest/);
});

test('quad-flag warning appears in rendered push-off cue', () => {
  const decision = { type: 'pool', subtype: 'sprint', block_number: 2, session_in_block: 3, active_flags: ['left_quad_cramp'] };
  const { session } = buildFallbackSession(decision, catalogue(), { date: '2026-05-20', recentTemplateIds: ['sprint_speed_endurance', 'sprint_volume'] });
  const md = renderSessionMarkdown(session);
  assert.match(md, /no dolphin kick/i);
  assert.match(md, /Quad flag active/);
});
