// Markdown renderer — turns a structured session into the markdown format the
// athlete reads (matching the Block2_Session3_Sprint.md style). Pure
// formatting; no decisions. Works for both pool and dryland sessions, and for
// sessions from the LLM or the fallback library (same structure).

function titleCase(s) {
  return String(s ?? '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Flag ids are snake_case (e.g. right_quad_pre_cramp) — show them readably.
function humanizeFlag(f) {
  return String(f).replace(/_/g, ' ').replace(/\bpre cramp\b/, 'pre-cramp');
}
function humanizeFlags(flags) {
  return (flags ?? []).map(humanizeFlag).join(', ');
}

function setLine(set) {
  const reps = set.reps ?? 1;
  const dist = set.distance_m ?? 0;
  const head = `${reps}×${dist}m`;
  const bits = [];
  if (set.drill) bits.push(set.drill);
  if (set.equipment) bits.push(set.equipment);
  if (set.effort) bits.push(set.effort);
  if (set.breathing) bits.push(`breathing ${set.breathing}`);
  const desc = bits.length ? ` ${bits.join(', ')}` : '';
  const rest = set.rest_s != null
    ? (set.rest_s === 0 ? ' — no rest, continuous' : ` — ${formatRest(set.rest_s)} rest`)
    : '';
  return `${head}${desc}${rest}`;
}

function formatRest(s) {
  if (s == null) return '';
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}:${String(r).padStart(2, '0')} min` : `${m} min`;
  }
  return `${s}s`;
}

// ──────────────────────────────────────────────────────────────────────────
// Pool session
// ──────────────────────────────────────────────────────────────────────────

function renderPool(session) {
  const lines = [];
  const subtype = titleCase(session.subtype);
  lines.push(`# Block ${session.block_number} · Session ${session.session_in_block} — ${subtype}`);
  lines.push('');
  lines.push(`**Phase ${session.phase}** · **${session.total_volume_m}m total**${session.generator ? ` · _${session.generator === 'fallback_library' ? 'fallback' : session.generator}_` : ''}`);
  lines.push('');

  if (session.active_flags?.length) {
    lines.push(`> ⚠️ Active flags: ${humanizeFlags(session.active_flags)}`);
    lines.push('');
  }

  // Distance tally
  lines.push('## Distance Tally');
  lines.push('');
  lines.push('| Block | Content | Subtotal |');
  lines.push('|---|---|---|');
  for (const b of session.blocks ?? []) {
    const content = (b.sets ?? []).map(setLine).join('; ');
    lines.push(`| ${b.name} | ${content} | ${b.volume_m}m |`);
  }
  lines.push(`| **Total** | | **${session.total_volume_m}m** |`);
  lines.push('');

  // Session detail
  lines.push('## Session');
  lines.push('');
  for (const b of session.blocks ?? []) {
    lines.push(`### ${b.name} — ${b.volume_m}m`);
    for (const s of b.sets ?? []) {
      lines.push(`- ${setLine(s)}`);
    }
    if (b.target) lines.push(`  > ${b.target}`);
    if (b.cue) lines.push(`  → Coach cue: ${b.cue}`);
    lines.push('');
  }

  // What to track
  lines.push('## 📋 What to track this session');
  lines.push('');
  lines.push('| Metric | Target | Actual |');
  lines.push('|---|---|---|');
  const t = session.targets ?? {};
  if (t.beat_25m_s != null) lines.push(`| Best 25m split | sub-${t.stretch_25m_s ?? t.beat_25m_s}s | ___s |`);
  if (t.sprint_swolf_target != null) lines.push(`| Best sprint SWOLF | ${t.sprint_swolf_target} | ___ |`);
  if (t.effort != null) lines.push(`| Main set effort | ${t.effort} | ___ |`);
  if (t.swolf_target != null) lines.push(`| Avg SWOLF | ${t.swolf_target} | ___ |`);
  if (t.stretch_50m_s != null) lines.push(`| Best 50m | sub-${t.stretch_50m_s}s | ___s |`);
  lines.push('| Stroke count in sprint reps | 7/length | ___ |');
  lines.push('| Any flag to log | — | ___ |');
  lines.push('');

  // Phase progress
  lines.push(phaseProgressLine(session, t));
  lines.push('');
  lines.push('💾 After this session, log it using the Session Logger so your catalogue stays current.');
  return lines.join('\n');
}

function phaseProgressLine(session, t) {
  // Show the actionable stepped target, not the ultimate goal (a hard-coded
  // "→ 14.0s" 25m is implausible for Phase 1 and read as broken).
  const bits = [];
  if (t.beat_25m_s != null) bits.push(`Best 25m ${t.beat_25m_s}s → target sub-${t.stretch_25m_s ?? t.beat_25m_s}s`);
  if (t.swolf_target != null) bits.push(`SWOLF → ${t.swolf_target}`);
  return `🏁 **Phase ${session.phase} Progress:** ${bits.join(' | ') || '—'}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Dryland session
// ──────────────────────────────────────────────────────────────────────────

function renderDryland(session) {
  const lines = [];
  lines.push(`# Block ${session.block_number} · Session ${session.session_in_block} — Dryland (${titleCase(session.subtype)})`);
  lines.push('');
  lines.push(`**Phase ${session.phase}** · Equipment: ${session.equipment ?? 'bodyweight'}${session.generator === 'fallback_library' ? ' · _fallback_' : ''}`);
  lines.push('');
  if (session.active_flags?.length) {
    lines.push(`> ⚠️ Active flags: ${humanizeFlags(session.active_flags)}`);
    lines.push('');
  }

  for (const b of session.blocks ?? []) {
    lines.push(`### ${b.name}`);
    if (b.note) lines.push(`> ${b.note}`);
    for (const e of b.exercises ?? []) {
      const sets = e.sets != null ? `${e.sets} × ` : '';
      const presc = e.prescription ?? '';
      const rest = e.rest_s != null ? ` — ${formatRest(e.rest_s)} rest` : '';
      const rationale = e.rationale ? `  _(${e.rationale})_` : '';
      lines.push(`- **${e.name}**: ${sets}${presc}${rest}${rationale}`);
    }
    lines.push('');
  }

  lines.push('## 📋 What to track this session');
  lines.push('');
  lines.push('- Any PRs (reps, weight, hold duration): ___');
  lines.push('- Perceived effort (1–10): ___');
  lines.push('- Any flag to log (e.g. quad sensation): ___');
  lines.push('');
  lines.push('💾 After this session, log it using the Session Logger so your catalogue stays current.');
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────

/**
 * Render a structured session to markdown.
 * @param {object} session
 * @returns {string}
 */
export function renderSessionMarkdown(session) {
  if (!session || typeof session !== 'object') return '';
  return session.type === 'dryland' ? renderDryland(session) : renderPool(session);
}

export { humanizeFlag };
