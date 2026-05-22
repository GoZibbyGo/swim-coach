import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBlockReportMarkdown } from '../src/block-report.js';

function catalogue() {
  return {
    athlete: { name: 'Julian', goal: 'Sub-30s 50m freestyle' },
    training_phase: { current: 1, name: 'Sprint Development' },
    rolling_bests: { best_25m_sprint_protocol_s: 16.8, best_avg_swolf: 31 },
    sessions: [
      {
        id: 5, date: '2026-05-15', type: 'pool', subtype: 'sprint', source: 'app_generated', generator: 'llm',
        block_number: 2, distance_m: 1600,
        metrics: { best_25m_split_s: 17.4, avg_swolf: 31 },
        breakdown: [{ n: 1, distance_m: 25, time_s: 17.4, swolf: 24, is_drill: false, rest_after_s: 120 }],
        coach_flags: ['NEW BEST sprint SWOLF 24'], athlete_feedback: 'Felt strong.',
        plan: {
          total_volume_m: 1600, generator: 'llm', blocks: [
            { name: 'Sprint Main Set', volume_m: 250, cue: 'Max effort', target: 'beat 16.8s', sets: [{ reps: 10, distance_m: 25, effort: 'max', rest_s: 120 }] },
          ],
        },
      },
      { id: 4, date: '2026-05-13', type: 'pool', subtype: 'technique', source: 'app_generated', block_number: 1, distance_m: 2050, metrics: { avg_swolf: 33 }, plan: null },
    ],
  };
}

test('buildBlockReportMarkdown includes only the block, with plan + performance', () => {
  const md = buildBlockReportMarkdown(catalogue(), 2);
  assert.match(md, /Block 2 analysis/);
  assert.match(md, /Session 5/);
  assert.doesNotMatch(md, /Session 4 —/);   // different block, excluded
  assert.match(md, /Prescribed plan/);
  assert.match(md, /Sprint Main Set/);
  assert.match(md, /beat 16\.8s/);
  assert.match(md, /Actual performance/);
  assert.match(md, /best 25m 17\.4s/);
  assert.match(md, /Felt strong/);
  assert.match(md, /```json/);               // machine-readable copy embedded
});

test('buildBlockReportMarkdown notes when a plan was not recorded', () => {
  assert.match(buildBlockReportMarkdown(catalogue(), 1), /plan not recorded/);
});
