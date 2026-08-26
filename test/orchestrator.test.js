import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateSession, buildPrompt, recentTemplateIdsFrom } from '../src/orchestrator.js';

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

// ──────────────────────────────────────────────────────────────────────────
// Equipment availability (pre-session checkboxes)

const decision = { subtype: 'sprint', type: 'pool', block_number: 2, session_in_block: 3, active_flags: [] };

test('buildPrompt lists available equipment when given', () => {
  const { userPrompt } = buildPrompt(decision, catalogue(), {}, { equipmentAvailable: ['rings', 'paddles'] });
  assert.match(userPrompt, /Available equipment:/);
  assert.match(userPrompt, /gymnastic rings/);
  assert.match(userPrompt, /paddles/);
});

test('buildPrompt states "no equipment" explicitly for an empty list', () => {
  const { userPrompt } = buildPrompt(decision, catalogue(), {}, { equipmentAvailable: [] });
  assert.match(userPrompt, /No equipment available/);
});

test('buildPrompt omits the equipment line when availability is unspecified', () => {
  const { userPrompt } = buildPrompt(decision, catalogue(), {}, {});
  assert.doesNotMatch(userPrompt, /Available equipment|No equipment available/);
});

test('generateSession forwards equipment availability into the LLM prompt', async () => {
  let captured = '';
  const callFn = async (args) => { captured = args.userPrompt; return { ok: true, text: validLlmJson }; };
  await generateSession(catalogue(), { apiKey: 'k', callGeminiFn: callFn, equipmentAvailable: ['rings'] });
  assert.match(captured, /Available equipment:.*gymnastic rings/);
});

// ──────────────────────────────────────────────────────────────────────────
// Anti-repetition (workstream B: "lack of creativity")

test('recentTemplateIdsFrom reads template ids off logged sessions', () => {
  const cat = catalogue();
  cat.sessions = [
    { id: 3, date: '2026-05-20', plan: { template_id: 'sprint_broken_50s' } },
    { id: 2, date: '2026-05-18', template_id: 'sprint_descending_25s' }, // legacy shape
    { id: 1, date: '2026-05-15', plan: {} },                            // no id → skipped
  ];
  assert.deepEqual(recentTemplateIdsFrom(cat), ['sprint_broken_50s', 'sprint_descending_25s']);
});

test('fallback does NOT repeat a template the athlete just swam', async () => {
  const cat = catalogue();
  // Force the library path, then check the chosen template isn't the recent one.
  const first = await generateSession(cat, { forceFallback: true, date: '2026-05-22' });
  const justUsed = first.session.template_id;
  assert.ok(justUsed, 'fallback sessions must carry a template_id');
  cat.sessions = [{ id: 99, date: '2026-05-22', plan: { template_id: justUsed } }];
  const second = await generateSession(cat, { forceFallback: true, date: '2026-05-24' });
  assert.notEqual(second.session.template_id, justUsed,
    'the library must exclude a template used in the last few sessions');
});

test('prompt cites the last THREE same-subtype main sets, not just one', () => {
  const cat = catalogue();
  const mk = (id, date, shape) => ({
    id, date, type: 'pool', subtype: 'sprint',
    plan: { blocks: [{ name: 'Main Set', sets: [{ reps: shape[0], distance_m: shape[1], effort: 'max' }] }] },
  });
  cat.sessions = [
    mk(3, '2026-05-20', [8, 25]), mk(2, '2026-05-17', [6, 50]), mk(1, '2026-05-14', [10, 25]),
  ];
  const decision = { type: 'pool', subtype: 'sprint', block_number: 2, session_in_block: 3, active_flags: [] };
  const { userPrompt } = buildPrompt(decision, cat, {});
  assert.match(userPrompt, /8×25m max/);
  assert.match(userPrompt, /6×50m max/);
  assert.match(userPrompt, /10×25m max/);
  assert.match(userPrompt, /structurally DIFFERENT from ALL of them/);
});

// ──────────────────────────────────────────────────────────────────────────
// Main-set archetypes (workstream B1/B2)

test('prompt carries the archetype menu and marks recently-used ones off-limits', () => {
  const cat = catalogue();
  cat.sessions = [
    { id: 2, date: '2026-05-20', type: 'pool', subtype: 'sprint', plan: { archetype_id: 'alactic_25s' } },
    { id: 1, date: '2026-05-17', type: 'pool', subtype: 'sprint', plan: { archetype_id: 'broken_50s' } },
  ];
  const decision = { type: 'pool', subtype: 'sprint', block_number: 2, session_in_block: 3, active_flags: [] };
  const { userPrompt, systemPrompt } = buildPrompt(decision, cat, {});
  assert.match(userPrompt, /MAIN-SET ARCHETYPE MENU/);
  assert.match(userPrompt, /ALREADY USED[\s\S]*alactic_25s/);
  assert.match(userPrompt, /ALREADY USED[\s\S]*broken_50s/);
  // A fresh archetype is still offered.
  assert.match(userPrompt, /speed_endurance_50s/);
  assert.match(systemPrompt, /ARCHETYPE SELECTION/);
  assert.match(systemPrompt, /COVER THE SPEED-ENDURANCE MIDDLE/);
});

test('a declared archetype_id is recorded on the generated session', async () => {
  const body = JSON.parse(validLlmJson);
  body.blocks[1].archetype_id = 'broken_50s';
  const callGeminiFn = async () => ({ ok: true, text: JSON.stringify(body) });
  const r = await generateSession(catalogue(), { apiKey: 'k', callGeminiFn, date: '2026-05-22' });
  assert.equal(r.status, 'success');
  assert.equal(r.session.archetype_id, 'broken_50s');
});

test('a hallucinated archetype_id is discarded rather than poisoning the rotation', async () => {
  const body = JSON.parse(validLlmJson);
  body.blocks[1].archetype_id = 'super_mega_sprint_set';
  const callGeminiFn = async () => ({ ok: true, text: JSON.stringify(body) });
  const r = await generateSession(catalogue(), { apiKey: 'k', callGeminiFn, date: '2026-05-22' });
  assert.equal(r.status, 'success');
  assert.equal(r.session.archetype_id, null);
});
