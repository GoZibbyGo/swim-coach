import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { auditRun, takeawayOpeners, STOCK_OPENER } from '../scripts/eval-audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────────────────────
// The detector must actually DETECT. A metric that silently always reports 0
// is worse than no metric — it would have told us the opener fix worked.

test('STOCK_OPENER catches the frame, including with a word inserted', () => {
  assert.ok(STOCK_OPENER.test('This session was clearly focused on technique'));
  assert.ok(STOCK_OPENER.test('This re-entry session was a resounding success'),
    'a word between "this" and "session" is the same tic');
  assert.ok(STOCK_OPENER.test('This sprint session delivered on its purpose'));
  assert.ok(STOCK_OPENER.test('Overall, a strong showing across the main set'));
  assert.ok(STOCK_OPENER.test('Great work on the descending set'));
});

test('STOCK_OPENER does NOT fire on a genuine, specific opener', () => {
  // Real opener from the 2026-08-28 run — note it contains the word "session"
  // later in the sentence, which a naive substring check would trip on.
  assert.ok(!STOCK_OPENER.test(
    'Achieving a new 50m personal best of 35.5s in your first sprint session back is an outstanding start'));
  assert.ok(!STOCK_OPENER.test('35.2s off the push — 0.7s under your old best, and the back half held.'));
  assert.ok(!STOCK_OPENER.test('Your stroke count climbed from 7 to 9 across the main set.'));
});

test('takeawayOpeners pulls the first real line of each Takeaways section', () => {
  const doc = [
    '## 🎯 Coaching Takeaways', '', 'First finding here.', '- bullet',
    '## Something Else', 'noise',
    '## 🎯 Coaching Takeaways', '', 'Second finding here.',
  ].join('\n');
  assert.deepEqual(takeawayOpeners(doc), ['First finding here.', 'Second finding here.']);
  assert.deepEqual(takeawayOpeners(null), []);
  assert.deepEqual(takeawayOpeners('no takeaways at all'), []);
});

test('auditRun flags regressions and stays quiet on a clean run', () => {
  const bad = auditRun([{
    feedback: '## 🎯 Coaching Takeaways\n\nThis session was solid.\n',
    planMd: '- 8×25m max — 2 min rest\n- 4×50m easy — no rest, continuous\n',
  }]);
  assert.equal(bad.metrics.stock_openers, 1);
  assert.equal(bad.metrics.ambiguous_continuous, 1);
  assert.match(bad.markdown, /⚠️ REGRESSION/);

  const clean = auditRun([{
    feedback: '## 🎯 Coaching Takeaways\n\n16.6s on INT 9 — your fastest of the block.\n',
    planMd: '- 8×25m max — 2 min rest\n',
  }]);
  assert.equal(clean.metrics.stock_openers, 0);
  assert.ok(!/REGRESSION/.test(clean.markdown));
});

test('auditRun handles an empty / fallback-only run without crashing', () => {
  const r = auditRun([]);
  assert.equal(r.metrics.total_openers, 0);
  assert.match(r.markdown, /No debriefs in this run/);
  assert.equal(auditRun(null).metrics.stock_openers, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// Ground truth: the 2026-08-27 eval was manually counted as 7/7 formulaic
// openers. If the detector ever stops scoring it 7/7, the detector broke.

const groundTruth = join(__dirname, '..', 'fixtures', 'known-formulaic-openers.md');

test('detector scores the known-bad 2026-08-27 openers 7/7 (manual ground truth)', () => {
  // Fixture rather than the live eval-output file: eval-output/ is gitignored,
  // so pointing at it made this guard silently SKIP on a fresh clone — and a
  // detector that stops detecting would have reported the opener fix as
  // working when it was not.
  const openers = takeawayOpeners(readFileSync(groundTruth, 'utf8'));
  assert.equal(openers.length, 7, 'the fixture holds 7 real openers from that run');
  const stock = openers.filter(o => STOCK_OPENER.test(o));
  assert.equal(stock.length, 7,
    `expected all 7 to be formulaic; detector found ${stock.length}: ${JSON.stringify(openers.map(o => o.slice(0, 50)))}`);
});
