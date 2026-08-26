import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeSession, buildAnalysisPrompt } from '../src/session-analysis.js';

function catWithSession(extra = {}) {
  return {
    rolling_bests: { best_25m_sprint_protocol_s: 16.8, best_avg_swolf: 31, best_sprint_swolf: 24, best_50m_equiv_s: 38 },
    sessions: [{
      id: 19, date: '2026-05-20', type: 'pool', subtype: 'sprint', distance_m: 1600,
      metrics: { best_25m_split_s: 16.6, avg_swolf: 30, avg_dps_m: 3.5, avg_stroke_rate_spm: 26, max_hr: 170 },
      coach_flags: ['NEW SPRINT PROTOCOL BEST: 16.6s', 'Cool-down HR elevated: max 170 bpm'],
      athlete_feedback: 'felt strong, main set was a touch easy',
      source: 'app_generated',
      ...extra,
    }],
  };
}

test('no session → none', async () => {
  const r = await analyzeSession({ sessions: [] });
  assert.equal(r.source, 'none');
});

test('no api key → deterministic fallback referencing the data', async () => {
  const r = await analyzeSession(catWithSession());
  assert.equal(r.source, 'fallback');
  assert.match(r.text, /NEW SPRINT PROTOCOL BEST/);
  assert.match(r.text, /felt strong/);
});

test('LLM success returns prose', async () => {
  const callGeminiFn = async ({ responseMimeType }) => {
    assert.equal(responseMimeType, 'text/plain'); // prose, not JSON
    return { ok: true, text: 'Strong sprint session. Your 16.6 is a new best...' };
  };
  const r = await analyzeSession(catWithSession(), { apiKey: 'k', callGeminiFn });
  assert.equal(r.source, 'llm');
  assert.match(r.text, /new best/);
});

test('LLM failure falls back to deterministic with reason', async () => {
  const callGeminiFn = async () => ({ ok: false, error: { kind: 'rate_limit_daily', message: 'quota' } });
  const r = await analyzeSession(catWithSession(), { apiKey: 'k', callGeminiFn });
  assert.equal(r.source, 'fallback');
  assert.equal(r.reason, 'rate_limit_daily');
  assert.match(r.text, /Session 19/);
});

test('prompt includes metrics, bests, flags and athlete notes', () => {
  const { systemPrompt, userPrompt } = buildAnalysisPrompt(catWithSession().sessions[0], catWithSession());
  assert.match(systemPrompt, /post-session debrief/);
  assert.match(userPrompt, /best 25m 16\.6s/);
  assert.match(userPrompt, /felt strong/);
  assert.match(userPrompt, /NEW SPRINT PROTOCOL BEST/);
});

// ──────────────────────────────────────────────────────────────────────────
// Plan fidelity — the LLM used to receive only a flat interval list and had to
// reconstruct the plan itself, which is where "you did X but the plan said Y"
// came from on correctly-swum sessions.

const PLANNED = {
  total_volume_m: 700,
  blocks: [
    { name: 'Warm-up', volume_m: 400, sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 20 }] },
    { name: 'Main Set — Sprints', volume_m: 200, sets: [{ reps: 8, distance_m: 25, effort: 'max', rest_s: 120 }] },
    { name: 'Cool-down', volume_m: 100, sets: [{ reps: 4, distance_m: 25, effort: 'easy', rest_s: 15 }] },
  ],
};
const BREAKDOWN = [
  ...Array.from({ length: 4 }, (_, i) => ({ n: i + 1, distance_m: 100, time_s: 100 })),
  ...Array.from({ length: 8 }, (_, i) => ({ n: i + 5, distance_m: 25, time_s: 17 })),
  ...Array.from({ length: 4 }, (_, i) => ({ n: i + 13, distance_m: 25, time_s: 22 })),
];

test('prompt carries the PRESCRIBED PLAN verbatim', () => {
  const s = catWithSession({ plan: PLANNED, breakdown: BREAKDOWN }).sessions[0];
  const { userPrompt } = buildAnalysisPrompt(s, catWithSession());
  assert.match(userPrompt, /PRESCRIBED PLAN/);
  assert.match(userPrompt, /Main Set — Sprints/);
  assert.match(userPrompt, /8×25m max @120s rest/);
});

test('prompt carries the engine-computed plan-vs-actual reconciliation', () => {
  const s = catWithSession({ plan: PLANNED, breakdown: BREAKDOWN }).sessions[0];
  const { userPrompt } = buildAnalysisPrompt(s, catWithSession());
  assert.match(userPrompt, /PLAN vs ACTUAL \(engine-computed/);
  assert.match(userPrompt, /INT 5–12, actually swam 8×25m/);
  assert.match(userPrompt, /swum as prescribed/);
});

test('system prompt forbids self-computed deviations and normal-band L1/L2 talk', () => {
  const { systemPrompt } = buildAnalysisPrompt(catWithSession().sessions[0], catWithSession());
  assert.match(systemPrompt, /PLAN FIDELITY/);
  assert.match(systemPrompt, /NEVER assert a deviation the reconciliation does not show/);
  assert.match(systemPrompt, /NORMAL PHYSICS/);
  assert.ok(!/ALWAYS compare each rep's first length/.test(systemPrompt),
    'the mandatory push-off callout rule must be gone');
});

test('a session with no plan still builds a prompt (external / hand-logged)', () => {
  const { userPrompt } = buildAnalysisPrompt(catWithSession({ breakdown: BREAKDOWN }).sessions[0], catWithSession());
  assert.ok(!/PRESCRIBED PLAN/.test(userPrompt));
  assert.ok(!/PLAN vs ACTUAL/.test(userPrompt));
  assert.match(userPrompt, /Per-interval data:/);
});

