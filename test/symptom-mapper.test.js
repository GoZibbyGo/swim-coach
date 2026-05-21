import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapFeedback, FEEDBACK_SIGNALS } from '../src/symptom-mapper.js';

test('maps a quad cramp to the flag + recovery tilt + held intensity', () => {
  const { matched, resolved } = mapFeedback('my left quad cramped on the 6th rep');
  assert.ok(matched.some(m => m.id === 'left_quad_cramp'));
  assert.deepEqual(resolved.flags, ['left_quad_cramp']);
  assert.equal(resolved.recovery_tilt, true);
  assert.equal(resolved.intensity, 'hold');
});

test('maps "too easy" to an intensity + volume increase', () => {
  const { resolved } = mapFeedback('honestly that was too easy, could have done more');
  assert.equal(resolved.intensity, 'increase');
  assert.equal(resolved.volume, 'increase');
});

test('injury overrides a positive intensity signal (conservative)', () => {
  const { resolved } = mapFeedback('felt strong but my right quad nearly cramped');
  assert.ok(resolved.flags.includes('right_quad_pre_cramp'));
  // fresh_strong wants increase, but injury blocks it → hold
  assert.equal(resolved.intensity, 'hold');
  assert.equal(resolved.recovery_tilt, true);
});

test('decrease beats increase when both present', () => {
  const { resolved } = mapFeedback('parts felt too easy but overall too hard to keep up');
  assert.equal(resolved.intensity, 'decrease');
});

test('maps equipment phrases to an equipment constraint', () => {
  const { resolved } = mapFeedback('only had rings today', { context: 'dryland' });
  assert.equal(resolved.equipment, 'rings');
});

test('maps a cut-short report to a data-quality signal', () => {
  const { resolved } = mapFeedback('had to stop early, only did half the main set');
  assert.ok(resolved.data_quality.includes('partial'));
});

test('maps technique feedback to a focus theme', () => {
  const { resolved } = mapFeedback('my stroke felt short and choppy, spinning my arms');
  assert.ok(resolved.technique_focus.includes('dps'));
});

test('context scoping excludes pool-only signals for dryland', () => {
  const { matched } = mapFeedback("couldn't hold the pace", { context: 'dryland' });
  assert.ok(!matched.some(m => m.id === 'couldnt_hold_pace'));
});

test('poor sleep holds intensity and logs a note', () => {
  const { resolved } = mapFeedback('slept badly last night');
  assert.equal(resolved.intensity, 'hold');
  assert.ok(resolved.context_notes.includes('poor_sleep'));
});

test('no matches → normal/empty resolution', () => {
  const { matched, resolved } = mapFeedback('the water was a nice temperature and the session was fine');
  // "fine" / "nice temperature" shouldn't trip injury/intensity signals
  assert.equal(resolved.flags.length, 0);
  assert.equal(resolved.intensity, 'normal');
  assert.equal(resolved.recovery_tilt, false);
  void matched;
});

test('every signal has phrases and an effects object', () => {
  for (const s of FEEDBACK_SIGNALS) {
    assert.ok(Array.isArray(s.phrases) && s.phrases.length, `${s.id} missing phrases`);
    assert.ok(s.effects && typeof s.effects === 'object', `${s.id} missing effects`);
    assert.ok(s.decay != null, `${s.id} missing decay`);
  }
});
