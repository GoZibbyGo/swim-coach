// GitHub catalogue sync.
//
// Reads/writes the single catalogue JSON file in a private GitHub repo via the
// REST Contents API, so the phone and desktop share one source of truth.
// `fetch` is injectable for tests; the token never ships in code — it is passed
// in (stored client-side in localStorage, same pattern as the Gemini key).
//
// Conflict model: GitHub versions the file with a blob `sha`. A push must cite
// the sha it last saw; if the remote moved (the other device pushed first),
// GitHub returns 409 and we surface a `conflict` rather than clobbering work.
// First-time creation omits the sha; if a file already exists but no sha is
// supplied, GitHub returns 422 — also treated as a conflict so the UI reconciles.

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
}

function contentsUrl({ owner, repo, path }) {
  const segs = String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${segs}`;
}

// ── UTF-8-safe base64 (browser + Node 18+; no Buffer dependency) ──
// The catalogue contains non-ASCII (→, —, ✓, …), so a naive btoa(str) would
// throw. Round-trip through TextEncoder/TextDecoder, chunking the binary
// string so large catalogues don't blow the String.fromCharCode call stack.
export function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return globalThis.btoa(bin);
}

export function decodeBase64(b64) {
  // GitHub returns base64 wrapped with newlines — strip all whitespace first.
  const bin = globalThis.atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function normalizeConfig(config = {}) {
  return {
    token: String(config.token ?? '').trim(),
    owner: String(config.owner ?? '').trim(),
    repo: String(config.repo ?? '').trim(),
    path: String(config.path ?? '').trim() || 'catalogue.json',
    branch: String(config.branch ?? '').trim() || 'main',
  };
}

export function validateConfig(config) {
  const cfg = normalizeConfig(config);
  const missing = ['token', 'owner', 'repo'].filter(k => !cfg[k]);
  return { valid: missing.length === 0, missing };
}

// ── Result helpers (mirrors gemini.js error shape: { ok, error: { kind, message } }) ──
function offline(message) { return { ok: false, error: { kind: 'offline', message } }; }
function err(kind, message, raw) { return { ok: false, error: { kind, message }, raw }; }
async function safeJson(res) { try { return await res.json(); } catch { return null; } }

// Map a non-ok GitHub response to an error kind the UI can act on.
function categorize(res, json) {
  if (res.status === 401) return err('auth', 'GitHub rejected the token (401). Check it in Settings.');
  if (res.status === 403) {
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    if (remaining === '0') return err('rate_limit', 'GitHub API rate limit reached — try again shortly.');
    return err('auth', `GitHub denied the request (403): ${json?.message ?? 'check the token scope and repo access'}.`);
  }
  if (res.status === 404) return err('not_found', json?.message ?? 'Not found (check repo, path, or branch).');
  if (res.status === 409 || res.status === 422) {
    return err('conflict', json?.message ?? 'The catalogue on GitHub changed since this device last synced.');
  }
  return err('api', `GitHub API error ${res.status}: ${json?.message ?? res.statusText ?? 'unknown'}`);
}

/**
 * Verify the token can reach the repo (lightweight: GET the repo).
 * @returns {Promise<{ ok, repo?, error? }>}
 */
export async function checkRepo(config, { fetchFn = globalThis.fetch, isOnline } = {}) {
  const cfg = normalizeConfig(config);
  const v = validateConfig(cfg);
  if (!v.valid) return err('config', `Missing: ${v.missing.join(', ')}.`);
  if (isOnline === false) return offline('Device is offline.');
  if (typeof fetchFn !== 'function') return err('api', 'No fetch implementation available.');

  const url = `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
  let res;
  try { res = await fetchFn(url, { headers: headers(cfg.token) }); }
  catch (e) { return offline(`Network error: ${e?.message ?? 'request failed'}`); }

  if (!res.ok) return categorize(res, await safeJson(res));
  const json = await safeJson(res);
  return { ok: true, repo: { full_name: json?.full_name, private: json?.private, default_branch: json?.default_branch } };
}

/**
 * Pull the catalogue file from GitHub.
 * @returns {Promise<{ ok, catalogue?, sha?, error? }>}
 *   error.kind === 'not_found' means the file doesn't exist yet — push to create it.
 */
export async function pullCatalogue(config, { fetchFn = globalThis.fetch, isOnline } = {}) {
  const cfg = normalizeConfig(config);
  const v = validateConfig(cfg);
  if (!v.valid) return err('config', `Missing: ${v.missing.join(', ')}.`);
  if (isOnline === false) return offline('Device is offline.');
  if (typeof fetchFn !== 'function') return err('api', 'No fetch implementation available.');

  const url = `${contentsUrl(cfg)}?ref=${encodeURIComponent(cfg.branch)}`;
  let res;
  try { res = await fetchFn(url, { headers: headers(cfg.token) }); }
  catch (e) { return offline(`Network error: ${e?.message ?? 'request failed'}`); }

  if (!res.ok) return categorize(res, await safeJson(res));

  const json = await safeJson(res);
  if (json?.content == null) return err('parse', 'GitHub response had no file content.', json);
  let catalogue;
  try { catalogue = JSON.parse(decodeBase64(json.content)); }
  catch (e) { return err('parse', `The catalogue on GitHub is not valid JSON: ${e?.message ?? 'parse error'}`); }
  return { ok: true, catalogue, sha: json.sha };
}

/**
 * Push the catalogue file to GitHub. Supply the last-known `sha` when updating
 * an existing file; omit it to create the file for the first time.
 * @returns {Promise<{ ok, sha?, error? }>}  error.kind === 'conflict' = remote moved.
 */
export async function pushCatalogue(config, catalogue, { sha, message, fetchFn = globalThis.fetch, isOnline } = {}) {
  const cfg = normalizeConfig(config);
  const v = validateConfig(cfg);
  if (!v.valid) return err('config', `Missing: ${v.missing.join(', ')}.`);
  if (isOnline === false) return offline('Device is offline.');
  if (typeof fetchFn !== 'function') return err('api', 'No fetch implementation available.');

  const body = {
    message: message || `Update catalogue — ${new Date().toISOString()}`,
    content: encodeBase64(JSON.stringify(catalogue, null, 2)),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;

  let res;
  try {
    res = await fetchFn(contentsUrl(cfg), {
      method: 'PUT',
      headers: { ...headers(cfg.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) { return offline(`Network error: ${e?.message ?? 'request failed'}`); }

  if (!res.ok) return categorize(res, await safeJson(res));
  const json = await safeJson(res);
  return { ok: true, sha: json?.content?.sha };
}
