// Demo: end-to-end deterministic generation of the next session from the
// real catalogue, with NO LLM (fallback library only). Shows the pipeline:
// catalogue → block-state decision → fallback session → validator → markdown.
//
// Run:  node scripts/demo-generate.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { migrateCatalogue } from '../src/schema.js';
import { determineNextSession } from '../src/block-state.js';
import { buildFallbackSession } from '../src/fallback-library.js';
import { validateGeneratedSession } from '../src/validator.js';
import { renderSessionMarkdown } from '../src/renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catPath = join(__dirname, '..', '..', 'Swimming Coach_code', 'athlete_catalogue.json');

const catalogue = migrateCatalogue(JSON.parse(readFileSync(catPath, 'utf8')));

const decision = determineNextSession(catalogue);
console.log('=== BLOCK-STATE DECISION ===');
console.log(`type=${decision.type} subtype=${decision.subtype} block=${decision.block_number} session=${decision.session_in_block}`);
console.log(`active_flags: ${decision.active_flags.join(', ') || 'none'}`);
console.log(`rationale: ${decision.rationale}`);
console.log('');

const { session } = buildFallbackSession(decision, catalogue, { date: '2026-05-20' });

const v = validateGeneratedSession(session, { activeFlags: decision.active_flags });
console.log('=== VALIDATION ===');
console.log(`valid=${v.valid}  errors=${v.errors.length}  warnings=${v.warnings.length}`);
if (v.errors.length) console.log('errors:', v.errors);
if (v.warnings.length) console.log('warnings:', v.warnings);
console.log('');

console.log('=== RENDERED SESSION ===');
console.log('');
console.log(renderSessionMarkdown(session));
