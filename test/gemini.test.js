import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callGemini, nextPacificMidnightISO } from '../src/gemini.js';

// A fake fetch that returns a canned Response-like object.
function fakeFetch({ status = 200, json = {}, throwErr = false } = {}) {
  return async () => {
    if (throwErr) throw new TypeError('fetch failed');
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      json: async () => json,
    };
  };
}

const okBody = { candidates: [{ content: { parts: [{ text: '{"hello":"world"}' }] } }] };

test('returns text on a successful response', async () => {
  const r = await callGemini({ apiKey: 'k', userPrompt: 'hi', fetchFn: fakeFetch({ json: okBody }) });
  assert.equal(r.ok, true);
  assert.equal(r.text, '{"hello":"world"}');
});

test('offline when isOnline=false (no fetch attempted)', async () => {
  let called = false;
  const r = await callGemini({ apiKey: 'k', isOnline: false, fetchFn: async () => { called = true; } });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'offline');
  assert.equal(called, false);
});

test('offline when fetch throws a network error', async () => {
  const r = await callGemini({ apiKey: 'k', userPrompt: 'hi', fetchFn: fakeFetch({ throwErr: true }) });
  assert.equal(r.error.kind, 'offline');
});

test('auth error with no API key', async () => {
  const r = await callGemini({ userPrompt: 'hi', fetchFn: fakeFetch({ json: okBody }) });
  assert.equal(r.error.kind, 'auth');
});

test('auth error on 403', async () => {
  const r = await callGemini({ apiKey: 'bad', userPrompt: 'hi', fetchFn: fakeFetch({ status: 403, json: { error: { message: 'forbidden' } } }) });
  assert.equal(r.error.kind, 'auth');
});

test('categorises a per-minute rate limit with retry seconds', async () => {
  const body = { error: { code: 429, message: 'Resource exhausted', details: [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' },
  ] } };
  const r = await callGemini({ apiKey: 'k', userPrompt: 'hi', fetchFn: fakeFetch({ status: 429, json: body }) });
  assert.equal(r.error.kind, 'rate_limit_minute');
  assert.equal(r.error.retry_after_seconds, 17);
});

test('categorises a daily quota limit with a reset time', async () => {
  const body = { error: { code: 429, message: 'Quota exceeded for quota metric requests per day', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProject' }] },
  ] } };
  const r = await callGemini({ apiKey: 'k', userPrompt: 'hi', fetchFn: fakeFetch({ status: 429, json: body }) });
  assert.equal(r.error.kind, 'rate_limit_daily');
  assert.ok(typeof r.error.retry_after_iso === 'string');
});

test('generic api error on 500', async () => {
  const r = await callGemini({ apiKey: 'k', userPrompt: 'hi', fetchFn: fakeFetch({ status: 500, json: { error: { message: 'boom' } } }) });
  assert.equal(r.error.kind, 'api');
});

test('parse error when no candidates', async () => {
  const r = await callGemini({ apiKey: 'k', userPrompt: 'hi', fetchFn: fakeFetch({ json: { candidates: [] } }) });
  assert.equal(r.error.kind, 'parse');
});

test('nextPacificMidnightISO returns a future ISO instant', () => {
  const now = new Date();
  const iso = nextPacificMidnightISO(now);
  assert.ok(new Date(iso).getTime() > now.getTime());
});
