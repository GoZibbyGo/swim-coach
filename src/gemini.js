// Gemini API caller.
//
// Thin wrapper over the Gemini REST API with the error categorisation the
// UI popup needs: offline, per-minute rate limit, daily quota, auth, generic.
// `fetch` is injectable so this is fully testable without a live key, and the
// API key never ships in code — it's passed in (stored client-side / synced
// via the user's private repo).
//
// Free tier: ~15 req/min, ~1500 req/day, 1M tokens/min — far above this app's
// ~12 calls/week. NOTE: model availability on the free tier changes over time.
// As of this build, gemini-2.0-flash has a free-tier limit of 0 for new keys,
// while `gemini-flash-latest` (currently → Gemini 3.5 Flash) is available free.
const DEFAULT_MODEL = 'gemini-flash-latest';
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/**
 * @param {object} args
 *   - apiKey (required)
 *   - systemPrompt, userPrompt (strings)
 *   - model? (default gemini-2.0-flash)
 *   - temperature?, maxOutputTokens?
 *   - fetchFn? (injectable; defaults to globalThis.fetch)
 *   - isOnline? (optional boolean; if false, short-circuits to offline)
 * @returns {Promise<{ ok: boolean, text?: string, error?: object, raw?: object }>}
 */
export async function callGemini(args) {
  const {
    apiKey,
    systemPrompt = '',
    userPrompt = '',
    model = DEFAULT_MODEL,
    temperature = 0.7,
    // Generous budget: gemini-flash-latest (3.5 Flash) is a *thinking* model —
    // it spends output tokens reasoning before the JSON, so a small cap
    // truncates the session mid-structure. 8192 comfortably fits both.
    maxOutputTokens = 8192,
    // 'application/json' for structured generation; 'text/plain' for prose
    // (e.g. session-analysis feedback).
    responseMimeType = 'application/json',
    fetchFn = globalThis.fetch,
    isOnline,
    // 5xx responses are transient server overload (esp. 503 "model is busy" —
    // common on the free tier at peak demand). Retry up to N times with
    // exponential backoff before falling through to the catch-all api_error,
    // which the caller turns into the deterministic fallback.
    maxRetries5xx = 2,
    baseBackoffMs = 1000,
    sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = args ?? {};

  if (isOnline === false) {
    return offline('Device is offline.');
  }
  if (!apiKey) {
    return err('auth', 'No Gemini API key configured. Add one in settings.');
  }
  if (typeof fetchFn !== 'function') {
    return err('api', 'No fetch implementation available.');
  }

  const body = {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature, maxOutputTokens, responseMimeType },
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchFn(`${ENDPOINT(model)}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // fetch throws on network failure → treat as offline/network.
      return offline(`Network error: ${e?.message ?? 'request failed'}`);
    }
    // Retry 5xx with exponential backoff (server is overloaded, not us). Stop
    // when we have a non-5xx response or we've exhausted the retry budget.
    if (res.status >= 500 && res.status <= 599 && attempt < maxRetries5xx) {
      await sleepFn(baseBackoffMs * Math.pow(2, attempt));
      continue;
    }
    break;
  }

  if (res.status === 429) {
    return categorizeRateLimit(await safeJson(res));
  }
  if (res.status === 401 || res.status === 403) {
    return err('auth', 'Gemini rejected the API key (401/403). Check the key in settings.');
  }
  if (!res.ok) {
    const j = await safeJson(res);
    return err('api', `Gemini API error ${res.status}: ${j?.error?.message ?? res.statusText ?? 'unknown'}`);
  }

  const json = await safeJson(res);
  const text = extractText(json);
  if (text == null) {
    return err('parse', 'Gemini returned no usable text content.', json);
  }
  return { ok: true, text, raw: json };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

function extractText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.map(p => p?.text ?? '').join('').trim();
  return text.length ? text : null;
}

function offline(message) {
  return { ok: false, error: { kind: 'offline', message } };
}

function err(kind, message, raw) {
  return { ok: false, error: { kind, message }, raw };
}

// Distinguish per-minute vs daily quota from the 429 body, and pull a retry
// delay if present.
function categorizeRateLimit(json) {
  const details = json?.error?.details ?? [];
  let retrySeconds = null;
  let isDaily = false;

  for (const d of details) {
    const type = String(d?.['@type'] ?? '');
    if (type.includes('RetryInfo') && typeof d.retryDelay === 'string') {
      const m = d.retryDelay.match(/([\d.]+)s/);
      if (m) retrySeconds = Math.ceil(Number(m[1]));
    }
    if (type.includes('QuotaFailure') && Array.isArray(d.violations)) {
      for (const v of d.violations) {
        const id = String(v?.quotaId ?? v?.subject ?? '');
        if (/per ?day|daily|PerDay/i.test(id)) isDaily = true;
      }
    }
  }
  const msg = String(json?.error?.message ?? '');
  if (/per ?day|daily/i.test(msg)) isDaily = true;

  if (isDaily) {
    return {
      ok: false,
      error: {
        kind: 'rate_limit_daily',
        retry_after_iso: nextPacificMidnightISO(),
        message: 'Gemini daily free-tier quota reached. Resets at midnight Pacific Time.',
      },
    };
  }
  return {
    ok: false,
    error: {
      kind: 'rate_limit_minute',
      retry_after_seconds: retrySeconds ?? 60,
      message: `Gemini per-minute rate limit hit. Retry in ~${retrySeconds ?? 60}s.`,
    },
  };
}

// Next 00:00 America/Los_Angeles as an ISO string (approximate; the UI can
// localise the countdown). Computed without a tz library by using the known
// offset is unreliable across DST, so we return the next UTC instant that is
// midnight Pacific using Intl.
export function nextPacificMidnightISO(now = new Date()) {
  // Get current Pacific date parts.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  // Build a Date for "tomorrow 00:00 Pacific" by stepping a day and probing.
  // Simpler robust approach: find the smallest future instant whose Pacific
  // hour is 0 by scanning hour-by-hour (cheap, <=24 iterations).
  const probe = new Date(now.getTime());
  for (let i = 0; i < 48; i++) {
    probe.setTime(probe.getTime() + 3600 * 1000);
    const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false }).formatToParts(probe).find(p => p.type === 'hour')?.value;
    if (h === '00') {
      // Zero the sub-hour component.
      probe.setMinutes(0, 0, 0);
      return probe.toISOString();
    }
  }
  void parts;
  return new Date(now.getTime() + 6 * 3600 * 1000).toISOString();
}

export { DEFAULT_MODEL };
