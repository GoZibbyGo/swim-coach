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
  const flags = (session.coach_flags ?? []).join('\n- ');

  const systemPrompt = [
    'You are an expert sprint-freestyle swim coach writing a detailed post-session debrief for the athlete.',
    'Write in markdown with these four sections, in this order, using ## headings:',
    '## 🏆 Records — list any PRs/matched bests WITH context (why each matters; compare to the previous best).',
    '## 📊 Session Breakdown — go block by block (warm-up, drills, main set, sprint finish, cool-down as applicable). For sets with multiple reps, include a small markdown table of the rep data, then 1–3 sentences interpreting it.',
    '## 🚩 Coach Flags — data-quality notes, Garmin glitches, HR/CO2 observations, anything to watch.',
    '## 🎯 Coaching Takeaways — the narrative: what the data reveals about where speed/limits come from, how it relates to the phase, and 1–2 concrete action items. Respond directly to the athlete\'s own notes here.',
    'Be specific and use the real numbers. Direct, encouraging coach voice. No preamble before the first heading.',
    knowledge ? `\nDomain context:\n${knowledge.slice(0, 5000)}` : '',
  ].filter(Boolean).join('\n');

  const userPrompt = [
    `SESSION ${session.id} — ${session.type}/${session.subtype} on ${session.date}${session.source === 'external' ? ' (EXTERNAL — pull performance, do not critique structure)' : ''}.`,
    session.distance_m ? `Volume ${session.distance_m}m.` : '',
    metricsLine(session) ? `Session metrics: ${metricsLine(session)}.` : '',
    `Rolling bests for comparison: 25m sprint ${rb.best_25m_sprint_protocol_s}s, raw 25m ${rb.best_25m_split_s}s, avg SWOLF ${rb.best_avg_swolf}, sprint SWOLF ${rb.best_sprint_swolf}, avg pace ${rb.best_avg_pace_per_100m}/100m, threshold pace ${rb.best_threshold_pace_per_100m}/100m, 50m ${rb.best_50m_equiv_s}s.`,
    `Phase ${session.phase_at_time ?? catalogue?.training_phase?.current ?? 1}.`,
    `Per-interval data:\n${breakdownText(session)}`,
    flags ? `Engine-detected flags (incorporate these):\n- ${flags}` : '',
    session.athlete_feedback ? `Athlete's own notes (respond to these directly): "${session.athlete_feedback}"` : 'Athlete left no notes.',
  ].filter(Boolean).join('\n');

  return { systemPrompt, userPrompt };
}

// Deterministic fallback — same sections, real data, no narrative prose.
function deterministicSummary(session, catalogue) {
  const out = [];
  out.push(`## Session ${session.id} — ${session.type}/${session.subtype} (${session.date})`);
  const m = metricsLine(session);
  if (m) out.push(`**Summary:** ${m}.`);

  const records = (session.coach_flags ?? []).filter(f => /BEST|matched|PHASE ADVANCED/i.test(f));
  out.push('## 🏆 Records');
  out.push(records.length ? records.map(r => `- ${r}`).join('\n') : '_No new records this session._');

  if (Array.isArray(session.breakdown) && session.breakdown.length) {
    out.push('## 📊 Session Breakdown');
    out.push('| INT | Dist | Time | SWOLF | HRmax | Rest |');
    out.push('|---|---|---|---|---|---|');
    for (const r of session.breakdown) {
      out.push(`| ${r.n}${r.is_drill ? ' (drill)' : ''} | ${r.distance_m}m | ${fmtT(r.time_s)} | ${r.swolf ?? '—'} | ${r.max_hr ?? '—'} | ${r.rest_after_s ? Math.round(r.rest_after_s) + 's' : '—'} |`);
    }
  } else if (session.dryland?.exercises?.length) {
    out.push('## 📊 Session Breakdown');
    for (const e of session.dryland.exercises) {
      const v = e.reps_per_set ?? e.duration_s_per_set ?? e.prescription ?? '';
      out.push(`- **${e.name}**: ${Array.isArray(v) ? v.join(' / ') : v}`);
    }
  }

  const other = (session.coach_flags ?? []).filter(f => !/BEST|matched|PHASE ADVANCED/i.test(f));
  out.push('## 🚩 Coach Flags');
  out.push(other.length ? other.map(f => `- ${f}`).join('\n') : '_None._');

  out.push('## 🎯 Coaching Takeaways');
  out.push(session.athlete_feedback ? `Your notes: "${session.athlete_feedback}"` : '_No athlete notes._');
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
    responseMimeType: 'text/plain', temperature: 0.6, maxOutputTokens: 8192,
    fetchFn: opts.fetchFn, isOnline: opts.isOnline,
  });

  if (!res.ok) {
    return { ok: true, source: 'fallback', reason: res.error?.kind, error: res.error,
      text: deterministicSummary(session, catalogue), session_id: session.id };
  }
  return { ok: true, source: 'llm', text: res.text, session_id: session.id };
}
