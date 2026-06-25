// Direct Gemini diagnostic.
//
// Bypasses the app entirely: hits Google's API with your key and reports
// (a) which models the key can list, (b) which models actually respond to a
// minimal generateContent call, with HTTP status and a short body excerpt
// per model. Helps tell apart these failure modes:
//   - bad / restricted key       → all calls 401/403
//   - wrong model name           → that model 404s
//   - region / country block     → 403 / "consumer not enabled"
//   - real transient overload    → all candidates 503 across multiple seconds
//   - one model down, others up  → switch the app to a working model
//
// Run:
//   GEMINI_API_KEY=your_key node scripts/gemini-diagnose.js
// or with the .env file (gitignored) at the app root:
//   node --env-file=.env scripts/gemini-diagnose.js

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Set GEMINI_API_KEY (env or .env). Aborting.');
  process.exit(1);
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Models worth probing — the app's default plus the obvious alternatives.
const MODELS = [
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
];

const ok = (b) => b >= 200 && b < 300;
const colour = (s, c) => `\x1b[${c}m${s}\x1b[0m`;
const green = (s) => colour(s, 32);
const red = (s) => colour(s, 31);
const yellow = (s) => colour(s, 33);
const dim = (s) => colour(s, 2);

function tag(status) {
  if (ok(status)) return green(`✓ ${status}`);
  if (status === 503) return yellow(`⚠ ${status}`);
  if (status === 429) return yellow(`⚠ ${status}`);
  if (status === 401 || status === 403) return red(`✗ ${status} (auth)`);
  if (status === 404) return red(`✗ ${status} (not found)`);
  return red(`✗ ${status}`);
}

async function safeBody(res) {
  try {
    const j = await res.json();
    return JSON.stringify(j).slice(0, 240);
  } catch {
    try { return (await res.text()).slice(0, 240); } catch { return ''; }
  }
}

async function listModels() {
  console.log(dim('\n[1/2] Listing models visible to this key …'));
  let res;
  try {
    res = await fetch(`${BASE}/models?key=${encodeURIComponent(apiKey)}`);
  } catch (e) {
    console.log(red(`  network error: ${e.message}`));
    return null;
  }
  if (!ok(res.status)) {
    const body = await safeBody(res);
    console.log(`  ${tag(res.status)}  ${dim(body)}`);
    return null;
  }
  const j = await res.json();
  const names = (j?.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
  console.log(`  ${green('OK')}  ${names.length} model(s) support generateContent:`);
  for (const n of names) console.log(`    - ${n}`);
  return names;
}

async function ping(model) {
  const url = `${BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Say "ok" and nothing else.' }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 16 },
  };
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { model, status: 0, ms: Date.now() - started, body: `network error: ${e.message}` };
  }
  return { model, status: res.status, ms: Date.now() - started, body: await safeBody(res) };
}

console.log(dim(`Key: ${apiKey.slice(0, 6)}…${apiKey.slice(-4)}  (length ${apiKey.length})`));
const listed = await listModels();

console.log(dim('\n[2/2] Pinging candidate models with a 1-token prompt …'));
for (const m of MODELS) {
  const r = await ping(m);
  const dur = `${r.ms}ms`.padStart(7);
  console.log(`  ${dur}  ${tag(r.status)}  ${m}`);
  if (!ok(r.status)) console.log(`         ${dim(r.body)}`);
}

// Summary heuristics.
console.log(dim('\nWhat the result means:'));
console.log(dim('  • All ✓ → Gemini is healthy for you. The earlier 503 was a true transient spike — try again.'));
console.log(dim('  • All 401/403 → key is bad or restricted. Regenerate at https://aistudio.google.com/apikey'));
console.log(dim('  • All 503 across all models, sustained → real Google-side overload; wait it out.'));
console.log(dim('  • Mixed (some ✓, some 503/404) → switch the app default to a working model (sw.js + gemini.js DEFAULT_MODEL).'));
if (listed && !listed.includes('gemini-flash-latest')) {
  console.log(yellow(`\n  ⚠ Your key does NOT list "gemini-flash-latest" — Google may have removed the alias for your region.`));
  console.log(yellow(`     Try setting MODEL to one of the listed models above in the app Settings.`));
}
