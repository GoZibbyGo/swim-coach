import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeBase64, decodeBase64, normalizeConfig, validateConfig,
  pullCatalogue, pushCatalogue, checkRepo,
} from '../src/github-sync.js';

const CONFIG = { token: 't', owner: 'me', repo: 'swim', path: 'catalogue.json', branch: 'main' };

// A fake fetch returning a canned Response-like object. Records the last call
// so push tests can assert on the request body / method / URL.
function fakeFetch({ status = 200, json = {}, headers = {}, throwErr = false } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (throwErr) throw new TypeError('fetch failed');
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => json,
    };
  };
  fn.calls = calls;
  return fn;
}

// ── base64 round-trip ──
test('encode/decode base64 round-trips ASCII and non-ASCII (→ — ✓)', () => {
  const s = 'sprint → threshold — done ✓ 50m';
  assert.equal(decodeBase64(encodeBase64(s)), s);
});

test('decodeBase64 tolerates GitHub-style newline-wrapped content', () => {
  const b64 = encodeBase64('{"a":1}');
  const wrapped = b64.replace(/(.{4})/g, '$1\n'); // inject newlines
  assert.equal(decodeBase64(wrapped), '{"a":1}');
});

// ── config ──
test('validateConfig flags missing required fields', () => {
  assert.deepEqual(validateConfig({ token: 't' }).missing.sort(), ['owner', 'repo']);
  assert.equal(validateConfig(CONFIG).valid, true);
});

test('normalizeConfig defaults path and branch', () => {
  const c = normalizeConfig({ token: 't', owner: 'o', repo: 'r' });
  assert.equal(c.path, 'catalogue.json');
  assert.equal(c.branch, 'main');
});

// ── pull ──
test('pullCatalogue decodes content and returns the sha', async () => {
  const cat = { athlete: { name: 'Julian' }, sessions: [] };
  const ff = fakeFetch({ json: { content: encodeBase64(JSON.stringify(cat)), sha: 'abc123' } });
  const r = await pullCatalogue(CONFIG, { fetchFn: ff });
  assert.equal(r.ok, true);
  assert.deepEqual(r.catalogue, cat);
  assert.equal(r.sha, 'abc123');
  // Read uses the contents URL with a ref query.
  assert.match(ff.calls[0].url, /\/repos\/me\/swim\/contents\/catalogue\.json\?ref=main$/);
});

test('pullCatalogue returns not_found when the file is missing (404)', async () => {
  const r = await pullCatalogue(CONFIG, { fetchFn: fakeFetch({ status: 404, json: { message: 'Not Found' } }) });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'not_found');
});

test('pullCatalogue returns parse error on non-JSON content', async () => {
  const ff = fakeFetch({ json: { content: encodeBase64('not json'), sha: 'x' } });
  const r = await pullCatalogue(CONFIG, { fetchFn: ff });
  assert.equal(r.error.kind, 'parse');
});

test('pullCatalogue is offline when fetch throws', async () => {
  const r = await pullCatalogue(CONFIG, { fetchFn: fakeFetch({ throwErr: true }) });
  assert.equal(r.error.kind, 'offline');
});

test('pull/push short-circuit to offline when isOnline=false (no fetch)', async () => {
  const ff = fakeFetch({});
  const r = await pullCatalogue(CONFIG, { fetchFn: ff, isOnline: false });
  assert.equal(r.error.kind, 'offline');
  assert.equal(ff.calls.length, 0);
});

test('pullCatalogue config error when required fields missing', async () => {
  const r = await pullCatalogue({ token: 't' }, { fetchFn: fakeFetch({}) });
  assert.equal(r.error.kind, 'config');
});

// ── push ──
test('pushCatalogue creates a file without a sha and returns the new sha', async () => {
  const ff = fakeFetch({ status: 201, json: { content: { sha: 'new1' } } });
  const r = await pushCatalogue(CONFIG, { sessions: [] }, { fetchFn: ff, message: 'init' });
  assert.equal(r.ok, true);
  assert.equal(r.sha, 'new1');
  const body = JSON.parse(ff.calls[0].opts.body);
  assert.equal(ff.calls[0].opts.method, 'PUT');
  assert.equal(body.message, 'init');
  assert.equal(body.branch, 'main');
  assert.equal(body.sha, undefined); // create → no sha
  assert.deepEqual(JSON.parse(decodeBase64(body.content)), { sessions: [] });
});

test('pushCatalogue sends the sha when updating', async () => {
  const ff = fakeFetch({ json: { content: { sha: 'new2' } } });
  await pushCatalogue(CONFIG, { sessions: [] }, { fetchFn: ff, sha: 'old' });
  assert.equal(JSON.parse(ff.calls[0].opts.body).sha, 'old');
});

test('pushCatalogue surfaces a conflict on 409', async () => {
  const r = await pushCatalogue(CONFIG, { sessions: [] }, { fetchFn: fakeFetch({ status: 409, json: { message: 'does not match' } }), sha: 'stale' });
  assert.equal(r.error.kind, 'conflict');
});

test('pushCatalogue treats a 422 (sha required) as a conflict', async () => {
  const r = await pushCatalogue(CONFIG, { sessions: [] }, { fetchFn: fakeFetch({ status: 422, json: { message: 'sha wasn\'t supplied' } }) });
  assert.equal(r.error.kind, 'conflict');
});

// ── auth / rate limit ──
test('auth error on 401', async () => {
  const r = await pullCatalogue(CONFIG, { fetchFn: fakeFetch({ status: 401, json: { message: 'Bad credentials' } }) });
  assert.equal(r.error.kind, 'auth');
});

test('403 with remaining=0 is a rate limit; otherwise auth', async () => {
  const limited = await pullCatalogue(CONFIG, { fetchFn: fakeFetch({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }) });
  assert.equal(limited.error.kind, 'rate_limit');
  const denied = await pullCatalogue(CONFIG, { fetchFn: fakeFetch({ status: 403, json: { message: 'forbidden' } }) });
  assert.equal(denied.error.kind, 'auth');
});

// ── checkRepo ──
test('checkRepo returns repo info on success', async () => {
  const ff = fakeFetch({ json: { full_name: 'me/swim', private: true, default_branch: 'main' } });
  const r = await checkRepo(CONFIG, { fetchFn: ff });
  assert.equal(r.ok, true);
  assert.equal(r.repo.full_name, 'me/swim');
  assert.equal(r.repo.private, true);
  assert.match(ff.calls[0].url, /\/repos\/me\/swim$/);
});

test('checkRepo maps a missing repo to not_found', async () => {
  const r = await checkRepo(CONFIG, { fetchFn: fakeFetch({ status: 404, json: { message: 'Not Found' } }) });
  assert.equal(r.error.kind, 'not_found');
});
