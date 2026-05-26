import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  phaseDef, phasePriority, phaseHasSprintFinish, volumeTargetsForPhase,
  checkPhaseAdvancement, applyPhaseAdvancement, phaseProgress,
} from '../src/phases.js';

function cat(phase, blocksInPhase, bests = {}) {
  return { training_phase: { current: phase, blocks_in_phase: blocksInPhase }, rolling_bests: bests };
}

test('phase definitions: priorities, sprint-finish, block durations', () => {
  assert.deepEqual(phasePriority(1), ['sprint', 'technique', 'threshold']);
  assert.deepEqual(phasePriority(2), ['race_pace', 'sprint', 'technique']);
  assert.deepEqual(phasePriority(3), ['race_pace', 'sprint', 'recovery']);
  assert.equal(phaseHasSprintFinish(1), true);
  assert.equal(phaseHasSprintFinish(3), false);
  assert.equal(phaseDef(1).blocks, 6);
  assert.equal(phaseDef(2).blocks, 6);
  assert.equal(phaseDef(3).blocks, 4);
  assert.throws(() => phaseDef(4), /not defined/);
});

test('phase-specific volume targets', () => {
  assert.deepEqual(volumeTargetsForPhase(1, 'sprint'), { min: 1600, max: 1800 });
  assert.deepEqual(volumeTargetsForPhase(2, 'race_pace'), { min: 1800, max: 2000 });
  assert.deepEqual(volumeTargetsForPhase(3, 'race_pace'), { min: 1400, max: 1600 });
  assert.deepEqual(volumeTargetsForPhase(3, 'sprint'), { min: 1200, max: 1400 });
  assert.equal(volumeTargetsForPhase(3, 'threshold'), null); // not part of phase 3
});

test('advancement is block-based: not until the block quota is met', () => {
  assert.equal(checkPhaseAdvancement(cat(1, 5)).advance, false); // 5/6
  const at6 = checkPhaseAdvancement(cat(1, 6));
  assert.equal(at6.advance, true);
  assert.equal(at6.to, 2);
  assert.equal(at6.blocks_done, 6);
});

test('applyPhaseAdvancement advances and resets the block counter', () => {
  const r = applyPhaseAdvancement(cat(1, 6), '2026-06-01');
  assert.equal(r.advanced, true);
  assert.equal(r.catalogue.training_phase.current, 2);
  assert.equal(r.catalogue.training_phase.name, 'Speed Integration');
  assert.equal(r.catalogue.training_phase.blocks_in_phase, 0);
  assert.equal(r.catalogue.training_phase.previous_phase, 1);
});

test('phase 2 → 3 after 6 blocks; phase 3 is terminal', () => {
  const r = applyPhaseAdvancement(cat(2, 6), '2026-07-01');
  assert.equal(r.catalogue.training_phase.current, 3);
  // Phase 3 never advances regardless of blocks.
  const t = applyPhaseAdvancement(cat(3, 99), '2026-08-01');
  assert.equal(t.advanced, false);
  assert.equal(t.catalogue.training_phase.current, 3);
});

test('phaseProgress reports block progress + target tracking', () => {
  const p = phaseProgress(cat(1, 3, { best_25m_sprint_protocol_s: 16.6, best_avg_swolf: 27, best_50m_equiv_s: 33.0 }));
  assert.equal(p.phase, 1);
  assert.equal(p.blocks_done, 3);
  assert.equal(p.blocks_total, 6);
  assert.equal(p.pct, 50);
  // P1 targets: 25m 15.5, SWOLF 27, 50m 33.0. SWOLF met (27<=27); 50m met (33<=33);
  // 25m not met (16.6>15.5).
  const swolf = p.targets.find(t => t.metric === 'best_avg_swolf');
  const s25 = p.targets.find(t => t.metric === 'best_25m_sprint_protocol_s');
  const s50 = p.targets.find(t => t.metric === 'best_50m_equiv_s');
  assert.equal(swolf.met, true);
  assert.equal(s50.met, true);
  assert.equal(s25.met, false);
});

test('phase targets step monotonically toward the sub-30 goal', () => {
  const tgt = (phase, metric) => phaseDef(phase).targets.find(t => t.metric === metric)?.target;
  // 25m sprint tightens each phase: 15.5 → 14.5 → 14.0
  assert.ok(tgt(1, 'best_25m_sprint_protocol_s') > tgt(2, 'best_25m_sprint_protocol_s'));
  assert.ok(tgt(2, 'best_25m_sprint_protocol_s') > tgt(3, 'best_25m_sprint_protocol_s'));
  // 50m tightens each phase and lands on the sub-30 goal: 33 → 31 → 30
  assert.ok(tgt(1, 'best_50m_equiv_s') > tgt(2, 'best_50m_equiv_s'));
  assert.ok(tgt(2, 'best_50m_equiv_s') > tgt(3, 'best_50m_equiv_s'));
  assert.equal(tgt(3, 'best_50m_equiv_s'), 30.0);
  // SWOLF tightens each phase: 27 → 25 → 23
  assert.ok(tgt(1, 'best_avg_swolf') > tgt(2, 'best_avg_swolf'));
  assert.ok(tgt(2, 'best_avg_swolf') > tgt(3, 'best_avg_swolf'));
});
