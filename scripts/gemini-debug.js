// Debug: show Gemini's raw output and exactly why it passed/failed validation.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { migrateCatalogue } from '../src/schema.js';
import { determineNextSession } from '../src/block-state.js';
import { computeTargets } from '../src/targets.js';
import { buildPrompt } from '../src/orchestrator.js';
import { callGemini } from '../src/gemini.js';
import { validateGeneratedSession } from '../src/validator.js';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('Set GEMINI_API_KEY'); process.exit(1); }

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalogue = migrateCatalogue(JSON.parse(readFileSync(join(__dirname, '..', '..', 'Swimming Coach_code', 'athlete_catalogue.json'), 'utf8')));
const knowledge = readFileSync(join(__dirname, '..', 'knowledge', 'swimming-coaching-kb.md'), 'utf8');

const decision = determineNextSession(catalogue);
const targets = computeTargets(catalogue, decision.subtype);
const { systemPrompt, userPrompt } = buildPrompt(decision, catalogue, targets, { knowledge });

const res = await callGemini({ apiKey, systemPrompt, userPrompt });
console.log('callGemini ok=', res.ok, res.error ?? '');
if (!res.ok) process.exit(0);

console.log('\n=== RAW TEXT ===\n');
console.log(res.text.slice(0, 2000));

let parsed;
try { parsed = JSON.parse(res.text); } catch (e) { console.log('\nJSON parse error:', e.message); process.exit(0); }

const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
const total = blocks.reduce((s, b) => s + (Number(b.volume_m) || 0), 0);
const session = {
  date: '2026-05-20', type: decision.type, subtype: decision.subtype,
  phase: 1, block_number: decision.block_number, session_in_block: decision.session_in_block,
  total_volume_m: total, blocks, targets, active_flags: decision.active_flags,
};
const v = validateGeneratedSession(session, { activeFlags: decision.active_flags });
console.log('\n=== VALIDATION ===');
console.log('valid=', v.valid, 'computed_total=', v.computed_total_m, 'stated_total=', total);
console.log('errors:', v.errors);
console.log('warnings:', v.warnings);
console.log('\nblock volumes:', blocks.map(b => `${b.name}=${b.volume_m}(${(b.sets||[]).reduce((s,x)=>s+(x.reps||1)*(x.distance_m||0),0)})`));
