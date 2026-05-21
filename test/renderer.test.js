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

test('quad-flag warning appears in rendered push-off cue', () => {
  const decision = { type: 'pool', subtype: 'sprint', block_number: 2, session_in_block: 3, active_flags: ['left_quad_cramp'] };
  const { session } = buildFallbackSession(decision, catalogue(), { date: '2026-05-20', recentTemplateIds: ['sprint_speed_endurance', 'sprint_volume'] });
  const md = renderSessionMarkdown(session);
  assert.match(md, /no dolphin kick/i);
  assert.match(md, /Quad flag active/);
});
