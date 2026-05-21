// Live Gemini test — verifies the real API + the full orchestrator path.
// The API key is read from the GEMINI_API_KEY environment variable; it is
// NEVER written to a file. Run:
//   $env:GEMINI_API_KEY="..."; node scripts/live-gemini-test.js   (PowerShell)
//
// This calls the real Gemini API once, validates the result, and prints the
// rendered session. If the key is bad / offline / rate-limited, it shows the
// fallback path instead.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { migrateCatalogue } from '../src/schema.js';
import { generateSession } from '../src/orchestrator.js';
import { renderSessionMarkdown } from '../src/renderer.js';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Set GEMINI_API_KEY in the environment first.');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalogue = migrateCatalogue(
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'Swimming Coach_code', 'athlete_catalogue.json'), 'utf8'))
);
// Give Gemini the pool KB as grounding context.
const knowledge = readFileSync(join(__dirname, '..', 'knowledge', 'swimming-coaching-kb.md'), 'utf8');

const r = await generateSession(catalogue, { apiKey, knowledge, date: '2026-05-20' });

console.log('=== ORCHESTRATOR RESULT ===');
console.log(`status=${r.status}  source=${r.source}  reason=${r.fallback_reason ?? '-'}`);
console.log(`message: ${r.message}`);
console.log(`validation: ${r.validation.errors.length} errors, ${r.validation.warnings.length} warnings`);
if (r.validation.errors.length) console.log('errors:', r.validation.errors);
console.log('');
console.log('=== RENDERED SESSION ===\n');
console.log(renderSessionMarkdown(r.session));
