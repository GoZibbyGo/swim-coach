// Block analysis report + tuning ingestion.
//
// buildBlockReportMarkdown() assembles everything about one completed block —
// prescribed plans + actual performance + feedback + engine flags — into a
// single self-contained markdown doc the athlete hands to an external coaching
// Claude project, which reviews whether the app's session GENERATION and
// session ANALYSIS are sound and returns a tuning file.
//
// extractTuningGuidance() pulls the auto-applied LLM-guidance section back out
// of that returned tuning file, so the app can inject it into future prompts.
// (Deterministic-core changes in the tuning file are NOT auto-applied — they're
// a spec for a developer to implement, keeping the core a trustworthy gate.)
//
// Pure + testable; no DOM, no I/O.

function fmt(v) { return v == null ? '—' : String(v); }

function planText(plan) {
  if (!plan || !Array.isArray(plan.blocks)) {
    return '_(plan not recorded — logged before plans were stored, or an external session)_';
  }
  const lines = [];
  if (plan.total_volume_m != null) lines.push(`Prescribed volume: ${plan.total_volume_m}m · generator: ${plan.generator ?? '—'}`);
  for (const b of plan.blocks) {
    if (Array.isArray(b.sets)) {
      const sets = b.sets.map(s => {
        const reps = (s.reps != null && s.distance_m != null) ? `${s.reps}×${s.distance_m}m` : '';
        return [reps, s.effort, s.rest_s != null ? `${s.rest_s}s rest` : '', s.drill, s.equipment, s.breathing].filter(Boolean).join(' · ');
      }).join(' | ');
      lines.push(`- **${b.name}** (${fmt(b.volume_m)}m): ${sets}${b.cue ? ` — _${b.cue}_` : ''}${b.target ? ` → ${b.target}` : ''}`);
    } else if (Array.isArray(b.exercises)) {
      lines.push(`- **${b.name}**: ${b.exercises.map(e => `${e.name} ${fmt(e.sets)}×${fmt(e.prescription ?? e.reps_per_set)}`).join('; ')}`);
    }
  }
  return lines.join('\n');
}

function performanceText(s) {
  const lines = [];
  const m = s.metrics ?? {};
  const bits = [];
  if (s.distance_m != null) bits.push(`${s.distance_m}m`);
  if (m.best_25m_split_s != null) bits.push(`best 25m ${m.best_25m_split_s}s`);
  if (m.avg_swolf != null) bits.push(`avg SWOLF ${m.avg_swolf}`);
  if (m.avg_pace_per_100m) bits.push(`avg pace ${m.avg_pace_per_100m}`);
  if (m.avg_hr != null) bits.push(`avg HR ${m.avg_hr}`);
  if (m.max_hr != null) bits.push(`max HR ${m.max_hr}`);
  if (m.avg_dps_m != null) bits.push(`DPS ${m.avg_dps_m}`);
  if (m.avg_stroke_rate_spm != null) bits.push(`rate ${m.avg_stroke_rate_spm}spm`);
  if (bits.length) lines.push(`Result: ${bits.join(', ')}.`);
  if (Array.isArray(s.breakdown) && s.breakdown.length) {
    lines.push('', '| INT | Dist | Time | SWOLF | HRmax | Rest |', '|---|---|---|---|---|---|');
    for (const r of s.breakdown) {
      lines.push(`| ${r.n}${r.is_drill ? ' (drill)' : ''} | ${r.distance_m}m | ${fmt(r.time_s)}s | ${fmt(r.swolf)} | ${fmt(r.max_hr)} | ${r.rest_after_s ? Math.round(r.rest_after_s) + 's' : '—'} |`);
    }
  } else if (s.dryland?.exercises?.length) {
    for (const e of s.dryland.exercises) {
      const v = e.reps_per_set ?? e.duration_s_per_set ?? e.prescription ?? '';
      lines.push(`- ${e.name}: ${Array.isArray(v) ? v.join(' / ') : v}`);
    }
  }
  return lines.join('\n');
}

/**
 * @param {object} catalogue
 * @param {number} blockNumber
 * @returns {string} self-contained markdown report for the block
 */
export function buildBlockReportMarkdown(catalogue, blockNumber) {
  const all = (catalogue?.sessions ?? [])
    .filter(s => s.block_number === blockNumber)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const rb = catalogue?.rolling_bests ?? {};

  const out = [];
  out.push(`# Swim Coach — Block ${blockNumber} analysis`);
  out.push(`Athlete: ${catalogue?.athlete?.name ?? '—'} · Goal: ${catalogue?.athlete?.goal ?? '—'}`);
  out.push(`Phase ${catalogue?.training_phase?.current ?? '?'} (${catalogue?.training_phase?.name ?? ''}) · ${all.length} session(s) · exported ${new Date().toISOString().slice(0, 10)}`);
  out.push('');
  out.push('> For the coaching-review Claude project: judge whether the **session generation** (the prescribed plans below) and the **session analysis** (the feedback) are sound for this athlete and phase, then return a tuning file in the format the project brief specifies.');

  for (const s of all) {
    out.push('', `## Session ${s.id} — ${s.date} · ${s.type}/${s.subtype} (${s.source}${s.generator ? `, ${s.generator}` : ''})`);
    out.push('', '### Prescribed plan', planText(s.plan));
    out.push('', '### Actual performance', performanceText(s) || '_(no performance data recorded)_');
    if (s.coach_flags?.length) out.push('', '### Engine flags', s.coach_flags.map(f => `- ${f}`).join('\n'));
    if (s.athlete_feedback) out.push('', '### Athlete notes', `"${s.athlete_feedback}"`);
  }

  out.push('', '## Rolling bests after this block');
  const bests = [
    rb.best_25m_sprint_protocol_s != null ? `- Best 25m sprint: ${rb.best_25m_sprint_protocol_s}s` : '',
    rb.best_avg_swolf != null ? `- Best avg SWOLF: ${rb.best_avg_swolf}` : '',
    rb.best_sprint_swolf != null ? `- Best sprint SWOLF: ${rb.best_sprint_swolf}` : '',
    rb.best_avg_pace_per_100m ? `- Best avg pace /100m: ${rb.best_avg_pace_per_100m}` : '',
    rb.best_threshold_pace_per_100m ? `- Best threshold pace /100m: ${rb.best_threshold_pace_per_100m}` : '',
  ].filter(Boolean);
  out.push(bests.length ? bests.join('\n') : '_none recorded_');

  // Machine-readable copy for precise parsing by the reviewer.
  out.push('', '## Raw data (JSON)', '```json',
    JSON.stringify({ block: blockNumber, sessions: all, rolling_bests: rb }, null, 1), '```');

  return out.join('\n');
}

// Heading that marks the auto-applied guidance section in a returned tuning file.
const TUNING_HEADING = /^#{1,6}[^\n]*llm guidance[^\n]*$/im;

/**
 * Pull the "LLM guidance (auto-applied)" section out of a returned tuning .md.
 * Returns the trimmed body (until the next heading), or '' if not present.
 * @param {string} md
 * @returns {string}
 */
export function extractTuningGuidance(md) {
  const text = String(md ?? '');
  const m = text.match(TUNING_HEADING);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/\n#{1,6}\s/);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}
