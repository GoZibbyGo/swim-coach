import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateSession } from '../src/orchestrator.js';

function catalogue() {
  return {
    training_phase: { current: 1, phase_goals: { swolf_target: 30, best_25m_target_s: 14, best_50m_target_s: 30 } },
    rolling_bests: {
      best_25m_sprint_protocol_s: 16.8, best_25m_split_s: 16.1,
      best_avg_swolf: 31, best_sprint_swolf: 24,
      best_threshold_pace_per_100m: '1:36', best_50m_equiv_s: 38.0,
    },
    weekly_block_tracking: {
      current_block_number: 2, current_block_pool_count: 1, current_block_dryland_count: 1,
      block_2_plan: [
        { session: 1, type: 'pool', subtype: 'threshold', status: 'completed' },
        { session: 2, type: 'dryland', subtype: 'pulling_strength', status: 'completed' },
        { session: 3, type: 'pool', subtype: 'sprint', status: 'upcoming' },
        { session: 4, type: 'pool', subtype: 'technique', status: 'upcoming' },
      ],
    },
    sessions: [],
  };
}

// A valid LLM session body (math correct) the orchestrator should accept.
const validLlmJson = JSON.stringify({
  blocks: [
    { name: 'Warm-Up', volume_m: 400, cue: 'Easy and long.', target: null, sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
    { name: 'Sprint Main Set', volume_m: 250, cue: 'Max effort, full rest.', target: 'beat 16.8s', sets: [{ reps: 10, distance_m: 25, effort: 'max', rest_s: 120 }] },
    { name: 'Sprint Finish', volume_m: 150, cue: 'Stay long.', target: null, sets: [{ reps: 6, distance_m: 25, effort: 'max', rest_s: 120 }] },
    { name: 'Race Simulation', volume_m: 300, cue: 'Race it.', target: null, sets: [{ reps: 6, distance_m: 50, effort: 'near-max', rest_s: 180 }] },
    { name: 'Cool-Down', volume_m: 200, cue: 'Every 5.', target: null, sets: [{ reps: 8, distance_m: 25, effort: 'easy', rest_s: 0, breathing: 'every-5' }] },
  ],
});

// LLM body with a stated-volume mismatch (999) — auto-repair should FIX this
// (recompute from sets) and the session should pass.
const badMathLlmJson = JSON.stringify({
  blocks: [
    { name: 'Warm-Up', volume_m: 999, cue: 'x', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
    { name: 'Sprint Main Set', volume_m: 1, cue: 'x', sets: [{ reps: 10, distance_m: 25, effort: 'max', rest_s: 120 }] },
    { name: 'Sprint Finish', volume_m: 1, cue: 'x', sets: [{ reps: 6, distance_m: 25, effort: 'max', rest_s: 120 }] },
    { name: 'Race Simulation', volume_m: 1, cue: 'x', sets: [{ reps: 6, distance_m: 50, effort: 'near-max', rest_s: 180 }] },
    { name: 'Cool-Down', volume_m: 200, cue: 'x', sets: [{ reps: 8, distance_m: 25, effort: 'easy', rest_s: 0 }] },
  ],
});

// LLM body with a REST violation (sprint reps at 30s) — auto-repair can't fix
// this; it stays an error → retry → fallback.
const badRestLlmJson = JSON.stringify({
  blocks: [
    { name: 'Warm-Up', cue: 'x', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
    { name: 'Sprint Main Set', cue: 'x', sets: [{ reps: 16, distance_m: 25, effort: 'max', rest_s: 30 }] },
    { name: 'Cool-Down', cue: 'x', sets: [{ reps: 8, distance_m: 25, effort: 'easy', rest_s: 0 }] },
  ],
});

function geminiReturning(text) {
  return async () => ({ ok: true, text });
}
function geminiError(error) {
  return async () => ({ ok: false, error });
}

// ──────────────────────────────────────────────────────────────────────────

test('no API key → fallback (source library, reason no_llm)', async () => {
  const r = await generateSession(catalogue(), {});
  assert.equal(r.status, 'fallback');
  assert.equal(r.source, 'library');
  assert.equal(r.fallback_reason, 'no_llm');
  assert.equal(r.validation.errors.length, 0);
  assert.equal(r.session.subtype, 'sprint'); // block plan session 3
});

test('valid LLM output → success (source llm)', async () => {
  const r = await generateSession(catalogue(), { apiKey: 'k', callGeminiFn: geminiReturning(validLlmJson) });
  assert.equal(r.status, 'success');
  assert.equal(r.source, 'llm');
  assert.equal(r.session.generator, 'llm');
  assert.equal(r.session.total_volume_m, 1300);
  assert.equal(r.session.subtype, 'sprint'); // deterministic, not from LLM
});

test('auto-repair fixes a stated-volume mismatch → success (no fallback)', async () => {
  const r = await generateSession(catalogue(), { apiKey: 'k', callGeminiFn: geminiReturning(badMathLlmJson) });
  assert.equal(r.status, 'success');
  assert.equal(r.source, 'llm');
  // Volumes recomputed from sets: 400 + 250 + 150 + 300 + 200 = 1300
  assert.equal(r.session.total_volume_m, 1300);
});

test('unfixable rest violation across all attempts → fallback (validation_failed)', async () => {
  const r = await generateSession(catalogue(), { apiKey: 'k', callGeminiFn: geminiReturning(badRestLlmJson) });
  assert.equal(r.status, 'fallback');
  assert.equal(r.fallback_reason, 'validation_failed');
  assert.equal(r.source, 'library');
  assert.equal(r.validation.errors.length, 0); // the fallback itself is valid
});

test('LLM recovers on a later attempt (correction)', async () => {
  let n = 0;
  const callFn = async () => { n += 1; return { ok: true, text: n === 1 ? badRestLlmJson : validLlmJson }; };
  const r = await generateSession(catalogue(), { apiKey: 'k', callGeminiFn: callFn });
  assert.equal(n, 2);
  assert.equal(r.status, 'success');
  assert.equal(r.source, 'llm');
});

test('offline error → fallback with offline reason', async () => {
  const r = await generateSession(catalogue(), { apiKey: 'k', callGeminiFn: geminiError({ kind: 'offline', message: 'no net' }) });
  assert.equal(r.fallback_reason, 'offline');
  assert.equal(r.source, 'library');
});

test('daily quota error → fallback carries the reset time', async () => {
  const r = await generateSession(catalogue(), {
    apiKey: 'k',
    callGeminiFn: geminiError({ kind: 'rate_limit_daily', retry_after_iso: '2026-05-21T07:00:00.000Z', message: 'daily' }),
  });
  assert.equal(r.fallback_reason, 'rate_limit_daily');
  assert.equal(r.retry_after_iso, '2026-05-21T07:00:00.000Z');
});

test('per-minute limit → fallback carries retry seconds', async () => {
  const r = await generateSession(catalogue(), {
    apiKey: 'k',
    callGeminiFn: geminiError({ kind: 'rate_limit_minute', retry_after_seconds: 20, message: 'slow down' }),
  });
  assert.equal(r.fallback_reason, 'rate_limit_minute');
  assert.equal(r.retry_after_seconds, 20);
});

test('non-JSON LLM response → retries then falls back', async () => {
  const r = await generateSession(catalogue(), { apiKey: 'k', callGeminiFn: geminiReturning('not json at all') });
  assert.equal(r.status, 'fallback');
  assert.equal(r.fallback_reason, 'validation_failed');
});
