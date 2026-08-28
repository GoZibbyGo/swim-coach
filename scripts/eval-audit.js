// Self-audit for a training-camp eval run.
//
// Every metric here corresponds to a defect the athlete actually reported and
// a fix that shipped, so a run can answer "did that stay fixed?" by itself
// instead of depending on someone remembering to grep the output.
//
// Kept in its own module (no side effects) so it is unit-testable —
// eval-batch.js calls main() at import time, and an earlier attempt to verify
// the detector by scraping the regex out of that file with eval() produced a
// false "0/7" twice because of shell escaping. Test the real thing instead.

// Stock opening frames. Validated against the 2026-08-27 eval run, which was
// manually counted as 7/7 formulaic openers. A looser `^this session` variant
// scored it 6/7 — it missed "This RE-ENTRY session was…", the identical tic
// with a word inserted — hence the `(\S+\s+){0,2}` allowance.
export const STOCK_OPENER =
  /^(this\s+(\S+\s+){0,2}session|this was|your session|overall|great (work|job)|well done|solid session|strong session|in summary|to summar)/i;

/**
 * The first real line of each "Coaching Takeaways" section in a debrief.
 */
export function takeawayOpeners(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const chunk of text.split(/##\s*🎯?\s*Coaching Takeaways/i).slice(1)) {
    const line = chunk.split('\n').map(s => s.trim()).find(s => s && !s.startsWith('#'));
    if (line) out.push(line);
  }
  return out;
}

/**
 * @param {object[]} records - eval-batch record objects ({ feedback, planMd, … })
 * @returns {{ markdown: string, console: string, metrics: object }}
 */
export function auditRun(records) {
  const feedbacks = (records ?? []).map(r => r?.feedback ?? '').filter(Boolean);
  const plans = (records ?? []).map(r => r?.planMd ?? '').filter(Boolean);
  const all = [...feedbacks, ...plans].join('\n');

  const openers = feedbacks.flatMap(takeawayOpeners);
  const stockOpeners = openers.filter(o => STOCK_OPENER.test(o));
  const count = re => (all.match(re) ?? []).length;

  const metrics = {
    stock_openers: stockOpeners.length,
    total_openers: openers.length,
    l1l2_nagging: count(/first-length gap|wall push-off is the gap/gi),
    turn_split_flags: count(/turn conversion:|split imbalance:/gi),
    ambiguous_continuous: count(/no rest, continuous/gi),
    distinct_set_shapes: new Set(plans.flatMap(p => p.match(/\d+×\d+m/g) ?? [])).size,
  };

  const rows = [
    ['Stock-frame Takeaways openers ("This session…")', `${metrics.stock_openers}/${metrics.total_openers}`, metrics.stock_openers > 0],
    ['L1/L2 push-off nagging (normal-band physics)', metrics.l1l2_nagging, metrics.l1l2_nagging > 0],
    ['Turn conversion / Split imbalance flags', metrics.turn_split_flags, false],
    ['Ambiguous "no rest, continuous" notation', metrics.ambiguous_continuous, metrics.ambiguous_continuous > 0],
    ['Distinct main-set shapes across the run', metrics.distinct_set_shapes, false],
  ];

  const markdown = [
    '## 🔍 Automated run audit',
    '',
    'Measured on this run\'s own output. Each row is a defect the athlete reported and a fix that shipped — a flagged row is a regression, not a nuance.',
    '',
    '| Check | Count | |',
    '|---|---|---|',
    ...rows.map(([label, value, bad]) => `| ${label} | ${value} | ${bad ? '⚠️ REGRESSION' : 'ok'} |`),
    '',
    openers.length
      ? `**Takeaways openers this run:**\n${openers.map(o => `- ${STOCK_OPENER.test(o) ? '⚠️ ' : ''}${o.slice(0, 110)}`).join('\n')}`
      : '_No debriefs in this run to audit._',
  ].join('\n');

  const consoleOut = [
    'Run audit:',
    ...rows.map(([label, value, bad]) => `  ${String(value).padStart(6)}  ${label}${bad ? '   ⚠️ REGRESSION' : ''}`),
  ].join('\n');

  return { markdown, console: consoleOut, metrics };
}
