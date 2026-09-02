import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeSession, buildAnalysisPrompt, leadAngle, blockSynthesis } from '../src/session-analysis.js';

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
  assert.match(systemPrompt, /AUTHORITATIVE/);
  assert.match(systemPrompt, /never assert a deviation the table does not show/i);
  assert.match(systemPrompt, /NORMAL PHYSICS/);
  assert.ok(!/ALWAYS compare each rep's first length/.test(systemPrompt),
    'the mandatory push-off callout rule must be gone');
});

test('system prompt is split into a data contract, constraints, and a positive brief', () => {
  // A flat wall of NEVER/ALWAYS bullets is itself a cause of formulaic
  // debriefs — the three-part split is the fix, so guard it.
  const { systemPrompt } = buildAnalysisPrompt(catWithSession().sessions[0], catWithSession());
  assert.match(systemPrompt, /PART A: DATA CONTRACT/);
  assert.match(systemPrompt, /PART B: THIS ATHLETE'S FIXED CONSTRAINTS/);
  assert.match(systemPrompt, /PART C: WHAT A GOOD DEBRIEF DOES/);
  assert.ok(systemPrompt.indexOf('PART A') < systemPrompt.indexOf('PART C'));
});

test('a session with no plan still builds a prompt (external / hand-logged)', () => {
  const { userPrompt } = buildAnalysisPrompt(catWithSession({ breakdown: BREAKDOWN }).sessions[0], catWithSession());
  assert.ok(!/PRESCRIBED PLAN/.test(userPrompt));
  assert.ok(!/PLAN vs ACTUAL/.test(userPrompt));
  assert.match(userPrompt, /Per-interval data:/);
});


// ──────────────────────────────────────────────────────────────────────────
// Workstream C — responsiveness

test('leadAngle varies with what actually happened this session', () => {
  const s = catWithSession().sessions[0];
  assert.match(leadAngle(s, ['NEW SPRINT PROTOCOL BEST: 16.6s'], []), /new record/);
  assert.match(leadAngle(s, [], ['Turn conversion: across 4×50m …']), /turn not converting/);
  assert.match(leadAngle(s, [], ['Data quality: tracking dropout — 400m untracked']), /data-quality/);
  assert.match(leadAngle(s, [], ['Cool-down HR elevated: peak 170 bpm']), /CO2/);
  assert.match(leadAngle(s, [], ['Stroke drift detected: 7 early → 9 late']), /stroke-count drift/);
  // Nothing notable → still directive, and now names a concrete figure.
  assert.match(leadAngle(s, [], []), /16\.6s best 25m/);
});

test('leadAngle prioritises a record over a lesser flag', () => {
  const s = catWithSession().sessions[0];
  const angle = leadAngle(s, ['NEW 25M BEST (raw): 16.2s'], ['Cool-down HR elevated: peak 170 bpm']);
  assert.match(angle, /new record/);
});

test('prompt carries the opening angle and a grounded trend history', () => {
  const cat = catWithSession();
  cat.sessions.push(
    { id: 18, date: '2026-05-17', type: 'pool', subtype: 'sprint', distance_m: 1700, metrics: { best_25m_split_s: 16.9, avg_swolf: 31 } },
    { id: 17, date: '2026-05-14', type: 'pool', subtype: 'sprint', distance_m: 1650, metrics: { best_25m_split_s: 17.1, avg_swolf: 32 } },
    { id: 16, date: '2026-05-12', type: 'pool', subtype: 'threshold', distance_m: 2000, metrics: { avg_swolf: 33 } },
  );
  const { userPrompt } = buildAnalysisPrompt(cat.sessions[0], cat);
  assert.match(userPrompt, /SUGGESTED OPENING ANGLE/);
  assert.match(userPrompt, /Recent sprint pool sessions/);
  assert.match(userPrompt, /2026-05-17: best 25m 16\.9s, avg SWOLF 31/);
  // Only same-subtype history — the threshold session must not be listed.
  assert.ok(!/2026-05-12/.test(userPrompt), 'trend history must be same-subtype only');
});

test('trend history is omitted when there is no comparable history', () => {
  const { userPrompt } = buildAnalysisPrompt(catWithSession().sessions[0], catWithSession());
  assert.ok(!/Recent sprint pool sessions/.test(userPrompt));
});

test('system prompt bans the "This session…" stock opener', () => {
  // Measured in the 2026-08-27 eval: 6 of 7 Coaching Takeaways opened with the
  // literal words "This session", so the debriefs read identically even though
  // leadAngle was correctly varying the SUBJECT.
  const { systemPrompt } = buildAnalysisPrompt(catWithSession().sessions[0], catWithSession());
  assert.match(systemPrompt, /OPEN WITH THE FINDING, NOT A FRAME/);
  assert.match(systemPrompt, /Never begin a section with "This session/);
});

test('with no headline flag, leadAngle hands over a concrete NUMBER not just a topic', () => {
  // Measured in the 2026-08-28 eval: the "This session…" wrapper reappeared on
  // the one debrief with no PR — a topic alone gives nothing specific to open
  // on. The fallback angle must name a real figure from the session.
  const s = catWithSession().sessions[0];   // best 25m 16.6s, avg SWOLF 30
  const angle = leadAngle(s, [], []);
  assert.match(angle, /16\.6s best 25m/, `expected a concrete number, got: ${angle}`);
  assert.match(angle, /open on that number/);
});

test('leadAngle falls back through the available metrics, then to a safe generic', () => {
  const withSwolf = { metrics: { avg_swolf: 29 } };
  assert.match(leadAngle(withSwolf, [], []), /29 average SWOLF/);
  const withDps = { metrics: { avg_dps_m: 3.4 } };
  assert.match(leadAngle(withDps, [], []), /3\.4 m\/stroke/);
  const bare = { metrics: {} };
  assert.match(leadAngle(bare, [], []), /never a general statement about the session/);
});

test('blockSynthesis computes the block trend and leads with what WORSENED', () => {
  const cat = { sessions: [
    { id: 3, date: '2026-08-30', type: 'pool', block_number: 6, metrics: { best_25m_split_s: 17.4, avg_swolf: 30 } },
    { id: 2, date: '2026-08-27', type: 'pool', block_number: 6, metrics: { best_25m_split_s: 17.1, avg_swolf: 29 } },
    { id: 1, date: '2026-08-26', type: 'pool', block_number: 6, metrics: { best_25m_split_s: 16.8, avg_swolf: 28 } },
  ] };
  const line = blockSynthesis(cat.sessions[0], cat);
  assert.match(line, /BLOCK 6 CLOSES WITH THIS SESSION/);
  // Picks the LARGEST worsening spread — SWOLF (2) over best 25m (0.6).
  assert.match(line, /avg SWOLF 28 → 29 → 30/, 'values must read oldest → newest');
  assert.match(line, /WORSENING/);
  assert.match(line, /do not recompute/);
});

test('blockSynthesis stays silent mid-block', () => {
  const cat = { sessions: [
    { id: 2, date: '2026-08-27', type: 'pool', block_number: 6, metrics: { best_25m_split_s: 17.1 } },
    { id: 1, date: '2026-08-26', type: 'pool', block_number: 6, metrics: { best_25m_split_s: 16.8 } },
  ] };
  assert.equal(blockSynthesis(cat.sessions[0], cat), '');
  assert.equal(blockSynthesis({}, cat), '');
});

test('the block line reaches the prompt so the LLM cannot skip it', () => {
  const cat = { rolling_bests: {}, sessions: [
    { id: 3, date: '2026-08-30', type: 'pool', subtype: 'sprint', block_number: 6, coach_flags: [], metrics: { best_25m_split_s: 17.4 } },
    { id: 2, date: '2026-08-27', type: 'pool', subtype: 'sprint', block_number: 6, metrics: { best_25m_split_s: 17.1 } },
    { id: 1, date: '2026-08-26', type: 'pool', subtype: 'sprint', block_number: 6, metrics: { best_25m_split_s: 16.8 } },
  ] };
  const { userPrompt, systemPrompt } = buildAnalysisPrompt(cat.sessions[0], cat);
  assert.match(userPrompt, /BLOCK 6 CLOSES WITH THIS SESSION/);
  assert.match(systemPrompt, /NAUSEA \/ BREATHLESSNESS IS THE CO2 STORY/);
});
