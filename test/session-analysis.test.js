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
