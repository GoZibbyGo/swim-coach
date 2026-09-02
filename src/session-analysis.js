// Session analysis — LLM-written coaching feedback on the most recent logged
// session, modelled on the rich debrief format (Records → Session Breakdown →
// Coach Flags → Coaching Takeaways). Needs wifi; falls back to a structured
// deterministic debrief (tables + records + flags, minus the narrative) when
// the LLM is unavailable. The deterministic data is always correct; the LLM
// only adds interpretation.

import { callGemini } from './gemini.js';
import { buildPlanReconciliation } from './flags.js';

// The session's PRESCRIBED plan, rendered verbatim for the prompt. Without
// this the LLM only ever saw a flat interval list and had to reconstruct the
// plan from it — which is where "you did X but the plan said Y" came from.
function planText(session) {
  const blocks = session?.plan?.blocks;
  if (!Array.isArray(blocks) || !blocks.length) return null;
  return blocks.map(b => {
    const sets = Array.isArray(b.sets) ? b.sets : [];
    const setStr = sets.map(s =>
      `${Number(s.reps) || 1}×${Number(s.distance_m) || 0}m`
      + `${s.effort ? ` ${s.effort}` : ''}`
      + `${s.rest_s != null ? ` @${s.rest_s}s rest` : ''}`
      + `${s.drill ? ` (${s.drill})` : ''}`
      + `${s.equipment ? ` [${s.equipment}]` : ''}`
    ).join(' + ');
    return `- ${b.name ?? '(block)'} (${b.volume_m ?? '?'}m): ${setStr || '—'}`
      + `${b.cue ? ` — cue: ${b.cue}` : ''}${b.target ? ` — target: ${b.target}` : ''}`;
  }).join('\n');
}

function fmtT(s) { return s == null ? '—' : `${s}s`; }
function metricsLine(s) {
  const m = s?.metrics ?? {};
  const bits = [];
  if (m.best_25m_split_s != null) bits.push(`best 25m ${m.best_25m_split_s}s`);
  if (m.avg_swolf != null) bits.push(`avg SWOLF ${m.avg_swolf}`);
  if (m.avg_pace_per_100m) bits.push(`avg pace ${m.avg_pace_per_100m}/100m`);
  if (m.avg_hr != null) bits.push(`avg HR ${m.avg_hr}`);
  if (m.max_hr != null) bits.push(`max HR ${m.max_hr}`);
  if (m.avg_dps_m != null) bits.push(`DPS ${m.avg_dps_m} m/stroke`);
  if (m.avg_stroke_rate_spm != null) bits.push(`rate ${m.avg_stroke_rate_spm} spm`);
  if (m.perceived_effort != null) bits.push(`RPE ${m.perceived_effort}`);
  if (m.self_eval) bits.push(`self-eval ${m.self_eval}`);
  return bits.join(', ');
}

// Compact, LLM-readable rendering of the per-interval breakdown.
function breakdownText(session) {
  const rows = session.breakdown;
  if (Array.isArray(rows) && rows.length) {
    return rows.map(r => {
      const splits = (r.splits_s ?? []).filter(x => x != null);
      const splitStr = splits.length > 1 ? ` splits[${splits.join('/')}]` : '';
      return `INT ${r.n}: ${r.distance_m}m ${fmtT(r.time_s)}${r.swolf != null ? ` SWOLF ${r.swolf}` : ''}${r.max_hr != null ? ` HRmax ${r.max_hr}` : ''}${r.is_drill ? ' (drill)' : ''}${r.rest_after_s ? ` rest ${Math.round(r.rest_after_s)}s` : ''}${splitStr}`;
    }).join('\n');
  }
  // Dryland
  if (session.dryland?.exercises?.length) {
    return session.dryland.exercises.map(e => {
      const v = e.reps_per_set ?? e.duration_s_per_set ?? e.prescription ?? '';
      return `${e.name}: ${Array.isArray(v) ? v.join('/') : v}`;
    }).join('\n');
  }
  return '(no per-interval data — session logged without a Garmin CSV)';
}

// Deterministic pick of what THIS debrief should open with. Without it every
// session opens on whichever flag the model happens to latch onto — in practice
// the same one or two every time, which is what made the debriefs feel
// interchangeable. Ordered most- to least-newsworthy.
export function leadAngle(session, recordFlags, otherFlags) {
  const has = re => otherFlags.some(f => re.test(f));
  if (recordFlags.some(f => /NEW /i.test(f))) return 'the new record — what produced it, and whether it is repeatable';
  if (has(/^Data quality:/)) return 'the data-quality caveat, so the athlete knows what the numbers do and do not cover';
  if (has(/^Turn conversion:/)) return 'the turn not converting — the one genuinely coachable wall finding';
  if (has(/Dryland (PR|regression)/i)) return 'the dryland result against its baseline';
  if (has(/Sprint rest too short/)) return 'the rest discipline on the max reps and what it cost';
  if (has(/Stroke drift/)) return 'the stroke-count drift under fatigue';
  if (has(/Cool-down HR elevated/)) return 'the CO2 / cool-down HR picture';
  if (has(/^Split imbalance:/)) return 'the split imbalance and which end of the rep it comes from';
  if (has(/Sprint pacing inconsistent|Velocity fade/)) return 'the consistency across the max reps';
  if (recordFlags.length) return 'the matched best and what it says about consistency';
  // No headline flag. Measured in the 2026-08-28 eval: this is exactly where
  // the debrief falls back on a stock "This session…" wrapper — a topic alone
  // gives it nothing concrete to open on. Hand it an actual NUMBER from the
  // session so there is something specific to lead with.
  const m = session?.metrics ?? {};
  const figure =
    m.best_25m_split_s != null ? `the ${m.best_25m_split_s}s best 25m`
    : m.avg_swolf != null ? `the ${m.avg_swolf} average SWOLF`
    : m.avg_dps_m != null ? `the ${m.avg_dps_m} m/stroke`
    : m.avg_pace_per_100m ? `the ${m.avg_pace_per_100m}/100m average pace`
    : null;
  return figure
    ? `${figure} — open on that number and what it says about the session's stated purpose`
    : 'the single most useful pattern in the per-interval data — open on a specific rep or number, never a general statement about the session';
}

// Compact history of the last few same-type/subtype sessions, so cross-session
// trend claims are grounded in numbers rather than invented.
function recentTrendText(catalogue, session, n = 3) {
  const prior = (catalogue?.sessions ?? [])
    .filter(s => s && s.id !== session.id && s.type === session.type && s.subtype === session.subtype)
    .slice(0, n);
  if (!prior.length) return '';
  return prior.map(s => {
    const m = s.metrics ?? {};
    const bits = [];
    if (m.best_25m_split_s != null) bits.push(`best 25m ${m.best_25m_split_s}s`);
    if (m.avg_swolf != null) bits.push(`avg SWOLF ${m.avg_swolf}`);
    if (m.avg_dps_m != null) bits.push(`DPS ${m.avg_dps_m}`);
    if (s.distance_m) bits.push(`${s.distance_m}m`);
    return `- ${s.date}: ${bits.length ? bits.join(', ') : 'no stored metrics'}`;
  }).join('\n');
}

// Block-level trend, computed by the ENGINE.
//
// "Close the block with the recurring limiter and its per-session values" has
// been asked for after blocks 4, 5 and 6 and shipped as a prompt instruction
// three times without landing. The lesson from the plan-reconciliation fix
// applies: if the model has to derive it, it won't reliably do it — so derive
// it here and hand over the finished sentence.
//
// Returns '' unless this session closes a block.
export function blockSynthesis(session, catalogue) {
  const sessions = catalogue?.sessions ?? [];
  const block = session?.block_number ?? session?.plan?.block_number ?? null;
  if (block == null) return '';
  const inBlock = sessions.filter(s => s?.type === 'pool' && (s?.block_number ?? s?.plan?.block_number) === block);
  // Only synthesise once the block's pool sessions are complete.
  if (inBlock.length < 3) return '';

  // Oldest → newest so a trend reads in the direction it happened.
  const ordered = [...inBlock].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const series = (label, pick, unit = 's', lowerIsBetter = true) => {
    const vals = ordered.map(s => ({ date: s.date, v: pick(s) })).filter(x => x.v != null);
    if (vals.length < 2) return null;
    const first = vals[0].v, last = vals[vals.length - 1].v;
    if (first === last) return null;
    const better = lowerIsBetter ? last < first : last > first;
    return {
      label,
      spread: Math.abs(last - first),
      text: `${label} ${vals.map(x => `${x.v}${unit}`).join(' → ')} across the block — ${better ? 'improving' : 'WORSENING'}`,
      better,
    };
  };

  const candidates = [
    series('best 25m', s => s.metrics?.best_25m_split_s),
    series('avg SWOLF', s => s.metrics?.avg_swolf, ''),
    series('distance per stroke', s => s.metrics?.avg_dps_m, ' m/stroke', false),
  ].filter(Boolean);
  if (!candidates.length) return '';

  // Lead with something that got WORSE if anything did — that's the limiter.
  const worsening = candidates.filter(c => !c.better);
  const pick = worsening.length
    ? worsening.sort((a, b) => b.spread - a.spread)[0]
    : candidates.sort((a, b) => b.spread - a.spread)[0];
  return `BLOCK ${block} CLOSES WITH THIS SESSION. Engine-computed block trend (use it verbatim for the "🎯 Top priority for next block" line — do not recompute): ${pick.text}.`;
}

export function buildAnalysisPrompt(session, catalogue, knowledge) {
  const rb = catalogue?.rolling_bests ?? {};
  // Separate the engine's record flags from other flags so the prompt can
  // constrain "Records" strictly to what the engine actually detected.
  const allFlags = session.coach_flags ?? [];
  const recordFlags = allFlags.filter(f => /\bBEST\b|matched|\bPR\b|record|PHASE ADVANCED/i.test(f));
  const otherFlags = allFlags.filter(f => !recordFlags.includes(f));
  const hasPerf = (Array.isArray(session.breakdown) && session.breakdown.length > 0)
    || (session.dryland?.exercises?.length > 0);
  // Treat blank notes and the eval's synthetic placeholder as "no notes".
  const rawNotes = (session.athlete_feedback ?? '').trim();
  const hasNotes = rawNotes && !/auto-synthesised|training-camp eval/i.test(rawNotes);
  const prescribed = planText(session);
  const reconciliation = buildPlanReconciliation(session.plan, session.breakdown).text;
  const trend = recentTrendText(catalogue, session);
  const blockLine = blockSynthesis(session, catalogue);

  // Prompt structure note (v32): this used to be ~22 flattened bullets all
  // phrased as NEVER/ALWAYS. That volume of undifferentiated prohibition is
  // itself a cause of formulaic, low-insight debriefs — the model spends its
  // attention on compliance and produces the same hedged paragraphs every
  // session. Split into three clearly-scoped parts: a terse data contract, the
  // athlete's fixed constraints, and a POSITIVE brief for what good looks like.
  const systemPrompt = [
    'You are an expert sprint-freestyle swim coach writing a post-session debrief for the athlete.',
    '',
    'STRUCTURE — markdown, ## headings, in this order:',
    '## 🏆 Records — only what the "Records this session" list contains, with context vs the previous best. Empty list → "No new records this session."',
    '## 📊 Session Breakdown — block by block, following the Prescribed plan\'s own block names. Build a rep table only from per-interval data that is actually provided.',
    '## 🚩 Coach Flags — data-quality notes, HR/CO2 observations, anything to watch.',
    '## 🎯 Coaching Takeaways — what the data says about where speed is coming from and what limits it, tied to the phase, ending in 1–2 concrete actions.',
    'Add a "Response to your notes" section ONLY if the athlete left notes.',
    '',
    '── PART A: DATA CONTRACT (hard constraints — a breach makes the debrief worthless) ──',
    'A1. Every number you write must come from the data below. Never invent or estimate a split, HR, SWOLF, stroke count or pace. No data → no table, and say plainly there is nothing to analyse.',
    'A2. The provided metrics ARE the source of truth. Never dismiss them as a device glitch or substitute your own figures.',
    'A3. Report only the records in "Records this session". "Rolling bests" is prior-history context — never present one as achieved today, and never coin a new PR (including derived 50m times).',
    'A4. Never report a PR from an equipment-assisted (pull buoy, paddles, fins) or drill rep. The engine emits "… NOT written as PR (assisted rep …)" — reflect that, naming the assistance.',
    'A5. The "Prescribed plan" and the engine-computed "Plan vs actual" table are AUTHORITATIVE. Restate the plan in its own numbers; never paraphrase a set into different reps/distances/rest. Do not do your own plan-vs-actual matching, and never assert a deviation the table does not show. "Swum as prescribed" means it was.',
    'A5b. NEVER claim the athlete reordered, swapped, or moved sets between blocks. You cannot see order — you see a per-block table the engine built. If a block reads oddly, report what the table says for that block and stop. A reordering claim the athlete did not make is the single most irritating error this debrief can contain, because it accuses them of not following the session they just followed.',
    'A6. Compute pacing spread and velocity fade only across reps of the SAME rep_class. Mixing a 16.5s max_alactic rep with a 19.1s build rep into "2.5s spread across 11 max reps" is a misclassification, not a finding.',
    'A7. Never emit internal classifier tags (`Feedback: <token>`, bare `lowercase_with_underscores`). Rewrite them as coaching sentences or drop them.',
    '',
    '── PART B: THIS ATHLETE\'S FIXED CONSTRAINTS ──',
    'B1. L1 vs L2 IS NOT A DEFECT. In a 25m pool the first length of any 50m+ rep is a push start from a DEAD STOP; later lengths are turn-aided and entered with speed. L2 being ~0.5–1.2s faster is NORMAL PHYSICS. Never present it as a fault, a "gap to attack", or an action item. Raise the turn ONLY when the engine emits a "Turn conversion:" or "Split imbalance:" flag — those fire only outside the normal band. No such flag → do not mention the topic at all.',
    'B2. Left-quad cramp history: never prescribe dolphin kick or ballistic/explosive wall drives. Wall work is streamline tightness and breakout timing only.',
    'B3. Lagging CO2 tolerance: treat an elevated cool-down HR as work to do; never praise a fast HR drop as a win.',
    'B4. The ≥120s rest rule applies only to reps the plan labels max/sprint. Build and easy reps are not violations.',
    'B5. Before asserting any safety or compliance failure, read the athlete\'s note. If they explained it (mislogged rep, early stop, nausea), either omit the flag or name their explanation. If the note says the session was completed and the watch stopped, the metres are UNTRACKED, not skipped — never write "cut short".',
    '',
    '── PART C: WHAT A GOOD DEBRIEF DOES (this is the part that makes it worth reading) ──',
    'C1. Lead with what actually mattered THIS session. A suggested opening angle is given below — use it unless the data points somewhere more interesting.',
    'C2. OPEN WITH THE FINDING, NOT A FRAME. Never begin a section with "This session…", "This was a…", "Overall…", "Great work on…" or any similar stock wrapper — measured across a block of debriefs, that construction made every one read identically even when the content differed. Start on the concrete thing: a number, the rep it came from, the pattern you spotted. "35.2s off the push — 0.7s under your old best, and the back half held." beats "This session marks a significant milestone with your new 50m best."',
    'C3. Use the recent-session history below to make trend claims real: "second sprint session this block under 17.0s", "SWOLF 31 → 30 → 28 across the block". Cite the numbers. Don\'t treat each result as isolated.',
    'C4. Qualify every "best" split you cite — was it a clean max effort in a dedicated sprint set, or a build / sprint-finish / drill-adjacent rep? Position in the session and stroke count tell you. An unqualified PR the reader over-credits is worse than no PR.',
    'C5. Judge the session against ITS OWN stated purpose (a technique session on technique execution, not on threshold pace).',
    'C6. Respond to the athlete\'s note directly and specifically — acknowledge what they reported, reflect injury/recovery updates, react to any plan modification they made. Never leave a note unaddressed.',
    'C7. For dryland, report EVERY exercise the engine flagged — PRs, holds, regressions, first baselines, and any "progression due" line. The engine now emits one finding per logged exercise, so a dryland debrief with no findings means you dropped them. Name the exercise and the numbers.',
    'C7b. NAUSEA / BREATHLESSNESS IS THE CO2 STORY. If the athlete reports nausea, dizziness, or needing to stop for breath, say it IN THE SAME BREATH as the cool-down HR / CO2 observation — one problem, not two independent notes. This has now ended three sessions across three blocks; if it recurs, say that it is recurring and prescribe for it rather than logging it again.',
    'C8. When the input contains a "BLOCK n CLOSES WITH THIS SESSION" line, finish with the "🎯 Top priority for next block" line built from the engine-computed trend it gives you. Use those numbers verbatim; do not recompute or substitute a different limiter.',
    'C9. Finish every section and every sentence. Specific, direct, encouraging coach voice. No preamble before the first heading.',
    knowledge ? `\nDomain context:\n${knowledge.slice(0, 5000)}` : '',
  ].filter(Boolean).join('\n');

  const userPrompt = [
    `SESSION ${session.id} — ${session.type}/${session.subtype} on ${session.date}${session.source === 'external' ? ' (EXTERNAL — pull performance, do not critique structure)' : ''}.`,
    `Session purpose: this is a ${session.subtype} ${session.type} session — judge it on that intent.`,
    session.distance_m ? `Volume ${session.distance_m}m.` : '',
    hasPerf ? '' : 'NO PERFORMANCE DATA was recorded for this session — do not analyse or invent any swim/rep results.',
    metricsLine(session) ? `Session metrics (source of truth): ${metricsLine(session)}.` : '',
    `Rolling bests for comparison (prior history, NOT this-session records): 25m sprint ${rb.best_25m_sprint_protocol_s}s, avg SWOLF ${rb.best_avg_swolf}, sprint SWOLF ${rb.best_sprint_swolf}, threshold pace ${rb.best_threshold_pace_per_100m}/100m, 50m ${rb.best_50m_equiv_s}s.`,
    `Phase ${session.phase_at_time ?? catalogue?.training_phase?.current ?? 1}.`,
    prescribed ? `PRESCRIBED PLAN (authoritative — restate these numbers exactly, never paraphrase):\n${prescribed}` : '',
    reconciliation ? `PLAN vs ACTUAL (engine-computed — authoritative, do NOT recompute this yourself):\n${reconciliation}` : '',
    `Per-interval data:\n${breakdownText(session)}`,
    recordFlags.length ? `Records this session (report ONLY these):\n- ${recordFlags.join('\n- ')}` : 'Records this session: NONE — do not report any records.',
    otherFlags.length ? `Other engine flags (incorporate these):\n- ${otherFlags.join('\n- ')}` : '',
    hasNotes ? `Athlete's own notes (respond to these directly): "${rawNotes}"` : 'Athlete left no notes — OMIT any notes-response section.',
    trend ? `Recent ${session.subtype} ${session.type} sessions (for grounded trend claims — cite these numbers, don't invent a trend):\n${trend}` : '',
    blockLine,
    `SUGGESTED OPENING ANGLE for this debrief: ${leadAngle(session, recordFlags, otherFlags)}. Override it only if the data genuinely points somewhere more interesting.`,
  ].filter(Boolean).join('\n');

  return { systemPrompt, userPrompt };
}

// Deterministic fallback — same sections, real data, no narrative prose.
function deterministicSummary(session, catalogue) {
  const out = [];
  out.push(`## Session ${session.id} — ${session.type}/${session.subtype} (${session.date})`);
  const m = metricsLine(session);
  if (m) out.push(`**Summary:** ${m}.`);

  const allFlags = session.coach_flags ?? [];
  const records = allFlags.filter(f => /BEST|matched|PHASE ADVANCED/i.test(f));
  out.push('## 🏆 Records');
  out.push(records.length ? records.map(r => `- ${r}`).join('\n') : '_No new records this session._');

  // Build each table as ONE block (rows joined with single newlines) — the
  // whole summary is later joined with blank lines, which would otherwise break
  // a markdown table by inserting a blank line between every row.
  if (Array.isArray(session.breakdown) && session.breakdown.length) {
    const rows = ['| INT | Dist | Time | SWOLF | HRmax | Rest |', '|---|---|---|---|---|---|'];
    for (const r of session.breakdown) {
      rows.push(`| ${r.n}${r.is_drill ? ' (drill)' : ''} | ${r.distance_m}m | ${fmtT(r.time_s)} | ${r.swolf ?? '—'} | ${r.max_hr ?? '—'} | ${r.rest_after_s ? Math.round(r.rest_after_s) + 's' : '—'} |`);
    }
    out.push('## 📊 Session Breakdown', rows.join('\n'));
  } else if (session.dryland?.exercises?.length) {
    const lines = session.dryland.exercises.map(e => {
      const v = e.reps_per_set ?? e.duration_s_per_set ?? e.prescription ?? '';
      return `- **${e.name}**: ${Array.isArray(v) ? v.join(' / ') : v}`;
    });
    out.push('## 📊 Session Breakdown', lines.join('\n'));
  }

  // Plan vs actual — deterministic, so the offline debrief is just as faithful
  // to the prescription as the LLM one.
  const recon = buildPlanReconciliation(session.plan, session.breakdown).text;
  if (recon) out.push('## 📋 Plan vs actual', recon);

  const other = allFlags.filter(f => !/BEST|matched|PHASE ADVANCED/i.test(f));
  out.push('## 🚩 Coach Flags');
  out.push(other.length ? other.map(f => `- ${f}`).join('\n') : '_None._');

  // Surface the key actionable flags as short takeaways so the offline debrief
  // is useful, not just a data dump.
  const takeaways = [];
  // Only surface push-off/turn work when the engine judged the split gap
  // ANOMALOUS. A normal dead-stop-L1 vs turn-aided-L2 difference is physics,
  // and auto-appending this takeaway every session is what made the athlete
  // tune the finding out entirely.
  if (other.some(f => /^Turn conversion:/i.test(f))) takeaways.push('- The turn isn\'t paying — tighten the streamline and hold it longer before the breakout.');
  if (other.some(f => /^Split imbalance:/i.test(f))) takeaways.push('- Your first length is drifting off your standing-start best — attack L1 rather than pacing it.');
  if (other.some(f => /cool-down hr/i.test(f))) takeaways.push('- Hold the every-5 / hypoxic breathing through the cool-down — CO2 tolerance is the limiter.');
  if (other.some(f => /rest too short/i.test(f))) takeaways.push('- Take the full ≥120s rest on max reps — it protects speed quality and the quad.');
  const rawNotes = (session.athlete_feedback ?? '').trim();
  if (rawNotes && !/auto-synthesised|training-camp eval/i.test(rawNotes)) takeaways.push(`- Re your note: "${rawNotes}".`);
  out.push('## 🎯 Coaching Takeaways');
  out.push(takeaways.length ? takeaways.join('\n') : '_Log more sessions for trend-based takeaways._');
  out.push('_Connect Gemini in Settings + wifi for a full narrative coaching debrief on top of this data._');
  return out.join('\n\n');
}

/**
 * Analyze the most recent logged session.
 * @returns {Promise<{ ok, source:'llm'|'fallback'|'none', text, reason?, error? }>}
 */
export async function analyzeSession(catalogue, opts = {}) {
  const session = catalogue?.sessions?.[0];
  if (!session) return { ok: false, source: 'none', text: 'No logged session to analyze yet.' };

  if (!opts.apiKey) {
    return { ok: true, source: 'fallback', reason: 'no_llm', text: deterministicSummary(session, catalogue), session_id: session.id };
  }

  const { systemPrompt, userPrompt } = buildAnalysisPrompt(session, catalogue, opts.knowledge);
  const callFn = opts.callGeminiFn ?? callGemini;
  const res = await callFn({
    apiKey: opts.apiKey, model: opts.model, systemPrompt, userPrompt,
    // Analysis emits PROSE, not schema-validated JSON — there is no validator
    // to fail, so the only cost of a higher temperature is stylistic variation,
    // which is exactly what "the debriefs read the same every week" needs. The
    // Part-A data contract does the factual guarding, not the temperature.
    responseMimeType: 'text/plain', temperature: opts.temperature ?? 0.85, maxOutputTokens: 16384,
    fetchFn: opts.fetchFn, isOnline: opts.isOnline,
  });

  if (!res.ok) {
    return { ok: true, source: 'fallback', reason: res.error?.kind, error: res.error,
      text: deterministicSummary(session, catalogue), session_id: session.id };
  }
  return { ok: true, source: 'llm', text: res.text, session_id: session.id };
}
