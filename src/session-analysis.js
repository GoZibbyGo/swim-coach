// Session analysis — LLM-written coaching feedback on the most recent logged
// session, modelled on the rich debrief format (Records → Session Breakdown →
// Coach Flags → Coaching Takeaways). Needs wifi; falls back to a structured
// deterministic debrief (tables + records + flags, minus the narrative) when
// the LLM is unavailable. The deterministic data is always correct; the LLM
// only adds interpretation.

import { callGemini } from './gemini.js';

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

  const systemPrompt = [
    'You are an expert sprint-freestyle swim coach writing a detailed post-session debrief for the athlete.',
    'Write in markdown with these sections, in this order, using ## headings:',
    '## 🏆 Records — list ONLY the records in the "Records this session" list below (with context vs the previous best). If that list is empty, write "No new records this session." — do not invent any.',
    '## 📊 Session Breakdown — go block by block (warm-up, drills, main set, sprint finish, cool-down as applicable). Build a rep table ONLY from per-interval data that is actually provided; if only summary data exists, describe it without a fabricated table.',
    '## 🚩 Coach Flags — data-quality notes, HR/CO2 observations, anything to watch.',
    '## 🎯 Coaching Takeaways — what the data reveals about where speed/limits come from, how it relates to the phase, and 1–2 concrete action items.',
    'Only add a "Response to your notes" section if the athlete actually left notes (see below) — otherwise omit it entirely.',
    '',
    'CRITICAL DATA RULES — violating these makes the debrief useless:',
    '- Use ONLY the numbers in "Session metrics", the per-interval data, and the flags below. NEVER invent or estimate per-rep splits, HR, SWOLF, or paces. No data → no table.',
    '- If there is NO performance data (e.g. a dryland session with no exercises, or "no per-interval data"), say plainly there is nothing to analyse for performance. NEVER fabricate a swim, splits, reps, or results that did not happen.',
    '- The provided summary IS the source of truth. Do NOT dismiss it as a device/Garmin glitch or substitute your own numbers.',
    '- Report ONLY the records in the "Records this session" list. The "Rolling bests" line is prior-history CONTEXT for comparison only — never present any of those figures as a record/PR achieved THIS session, and never coin a new PR (including derived 50m times).',
    '- When per-length split data exists, ALWAYS compare each rep\'s first length to its later length(s) and explicitly call out the wall push-off / first-length gap.',
    '- WALL PUSH-OFF must be coached through streamline tightness and breakout timing ONLY. NEVER prescribe dolphin kicks or ballistic/explosive wall drives — this athlete has a left-quad cramp history and the rest of the system bans them.',
    '- Cool-down HR: this athlete has lagging CO2 tolerance. Flag an elevated cool-down HR as something to work on; do NOT praise a fast HR drop as a positive.',
    '- Judge the session against its STATED purpose and phase priority (e.g. a technique session on technique/DPS execution, not on threshold pace).',
    '- The ≥120s-rest rule applies ONLY to reps the plan labels max/sprint. Do NOT flag labeled "build"/easy reps as rest violations.',
    '- VARY the debrief — do not open every session with the same two flags or close with the same two action items. Lead with what matters most THIS session and reference cross-session trends where the data shows them.',
    '- Keep the debrief COMPLETE and self-contained: finish every section and every sentence; do not run past the length budget mid-thought.',
    '- ALWAYS read the athlete\'s note and respond to it directly in one short paragraph: acknowledge what they reported, address any injury/recovery update (e.g. "quad cramps no longer a problem" should be reflected), and react to plan modifications (cool-down swaps, set changes). If a "Response to your notes" section makes sense, add it; otherwise weave the response into the Coaching Takeaways. Never leave the note unaddressed.',
    '- BLOCK-LEVEL SYNTHESIS: when the engine flags a NEW BEST or "matched" record, write a one-line cross-session summary linking it to the immediately prior session(s) of the same type — e.g. "second sprint session this block to match 16.6s, with 12 reps under 17.0s." Don\'t treat each PR as an isolated event.',
    '- NEVER emit internal classifier tags (strings of the form `Feedback: <token>` or `<lowercase_with_underscores>`) to the user. If you see one in the engine flags, drop it or rewrite it as a coaching sentence.',
    'Be specific and use the real numbers. Direct, encouraging coach voice. No preamble before the first heading.',
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
    `Per-interval data:\n${breakdownText(session)}`,
    recordFlags.length ? `Records this session (report ONLY these):\n- ${recordFlags.join('\n- ')}` : 'Records this session: NONE — do not report any records.',
    otherFlags.length ? `Other engine flags (incorporate these):\n- ${otherFlags.join('\n- ')}` : '',
    hasNotes ? `Athlete's own notes (respond to these directly): "${rawNotes}"` : 'Athlete left no notes — OMIT any notes-response section.',
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

  const other = allFlags.filter(f => !/BEST|matched|PHASE ADVANCED/i.test(f));
  out.push('## 🚩 Coach Flags');
  out.push(other.length ? other.map(f => `- ${f}`).join('\n') : '_None._');

  // Surface the key actionable flags as short takeaways so the offline debrief
  // is useful, not just a data dump.
  const takeaways = [];
  if (other.some(f => /first-length gap/i.test(f))) takeaways.push('- Attack the wall push-off (streamline + breakout timing) — the first length is your gap.');
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
    responseMimeType: 'text/plain', temperature: 0.6, maxOutputTokens: 16384,
    fetchFn: opts.fetchFn, isOnline: opts.isOnline,
  });

  if (!res.ok) {
    return { ok: true, source: 'fallback', reason: res.error?.kind, error: res.error,
      text: deterministicSummary(session, catalogue), session_id: session.id };
  }
  return { ok: true, source: 'llm', text: res.text, session_id: session.id };
}
