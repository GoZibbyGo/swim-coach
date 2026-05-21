// Phase definitions — single source of truth for the 3-phase progression,
// per training_phase_plan.md.
//
// Advancement is BLOCK-based (not calendar weeks): each phase runs for a fixed
// number of completed blocks (a block = 3 pool + 1 dryland). The performance
// targets are tracked for display/progress only — they do NOT gate advancement.

export const PHASES = Object.freeze({
  1: {
    phase: 1,
    name: 'Sprint Development',
    weeks: '1-6',
    blocks: 6,                // advance after 6 completed blocks
    focus: 'Neuromuscular speed, SWOLF reduction',
    pool_priority: ['sprint', 'technique', 'threshold'],
    sprint_finish: true,      // sprint finish in ALL Phase 1 subtypes
    volume_targets: {
      sprint:    { min: 1600, max: 1800 },
      technique: { min: 2000, max: 2200 },
      threshold: { min: 2400, max: 2600 },
      recovery:  { min: 1200, max: 1500 },
    },
    targets: [
      { label: 'Best 25m sprint', metric: 'best_25m_sprint_protocol_s', target: 14.0, unit: 's', lower: true },
      { label: 'Avg session SWOLF', metric: 'best_avg_swolf', target: 30, unit: '', lower: true },
      { label: 'Best 50m equiv', metric: 'best_50m_equiv_s', target: 30.0, unit: 's', lower: true },
    ],
    next_phase: 2,
    terminal: false,
  },
  2: {
    phase: 2,
    name: 'Speed Integration',
    weeks: '7-12',
    blocks: 6,
    focus: 'Race-pace reps, lactate tolerance, turn sharpening',
    pool_priority: ['race_pace', 'sprint', 'technique'],
    sprint_finish: true,
    volume_targets: {
      race_pace: { min: 1800, max: 2000 },
      sprint:    { min: 1600, max: 1800 },
      technique: { min: 2000, max: 2200 },
      recovery:  { min: 1200, max: 1500 },
    },
    targets: [
      { label: 'Best 25m sprint', metric: 'best_25m_sprint_protocol_s', target: 14.0, unit: 's', lower: true },
      { label: 'Avg session SWOLF', metric: 'best_avg_swolf', target: 28, unit: '', lower: true },
      { label: 'Race-pace 50m', metric: 'best_50m_equiv_s', target: 33.0, unit: 's', lower: true },
    ],
    next_phase: 3,
    terminal: false,
  },
  3: {
    phase: 3,
    name: 'Race Sharpening',
    weeks: '13-16',
    blocks: 4,
    focus: 'Taper, race simulation, sub-30 attempt',
    pool_priority: ['race_pace', 'sprint', 'recovery'],
    sprint_finish: false,     // every fast swim is the point; no separate finish
    volume_targets: {
      race_pace: { min: 1400, max: 1600 }, // "race simulation"
      sprint:    { min: 1200, max: 1400 },
      recovery:  { min: 1000, max: 1200 },
    },
    targets: [
      { label: 'Best 50m time', metric: 'best_50m_equiv_s', target: 30.0, unit: 's', lower: true },
      { label: 'Avg session SWOLF', metric: 'best_avg_swolf', target: 26, unit: '', lower: true },
    ],
    next_phase: null,
    terminal: true,
  },
});

export function phaseDef(phaseNumber) {
  const def = PHASES[phaseNumber];
  if (!def) throw new Error(`Phase ${phaseNumber} is not defined. Supported: ${Object.keys(PHASES).join(', ')}.`);
  return def;
}
export function phasePriority(phaseNumber) { return phaseDef(phaseNumber).pool_priority; }
export function phaseHasSprintFinish(phaseNumber) { return phaseDef(phaseNumber).sprint_finish === true; }

// Phase-specific pool volume range for a subtype (falls back to null if the
// subtype isn't part of that phase).
export function volumeTargetsForPhase(phaseNumber, subtype) {
  const def = PHASES[phaseNumber];
  return def?.volume_targets?.[subtype] ?? null;
}

// ──────────────────────────────────────────────────────────────────────────
// Block-based advancement
// ──────────────────────────────────────────────────────────────────────────

function blocksInPhase(catalogue) {
  return catalogue?.training_phase?.blocks_in_phase ?? 0;
}

/**
 * Should the phase advance? Block-based: blocks_in_phase >= phase.blocks.
 */
export function checkPhaseAdvancement(catalogue) {
  const current = catalogue?.training_phase?.current ?? 1;
  const def = PHASES[current];
  if (!def || def.terminal) {
    return { advance: false, from: current, to: null, blocks_done: blocksInPhase(catalogue), blocks_total: def?.blocks ?? null, reason: 'Terminal phase — no further advancement.' };
  }
  const done = blocksInPhase(catalogue);
  const advance = done >= def.blocks;
  return {
    advance,
    from: current,
    to: advance ? def.next_phase : null,
    blocks_done: done,
    blocks_total: def.blocks,
    reason: advance
      ? `Phase ${current} complete (${done}/${def.blocks} blocks) → advance to Phase ${def.next_phase} (${PHASES[def.next_phase].name}).`
      : `Phase ${current}: ${done}/${def.blocks} blocks complete.`,
  };
}

/**
 * Returns { catalogue, advanced, check }. Advances + resets the in-phase block
 * counter when the quota is met. Pure.
 */
export function applyPhaseAdvancement(catalogue, date) {
  const check = checkPhaseAdvancement(catalogue);
  if (!check.advance || check.to == null) return { catalogue, advanced: false, check };
  const nextDef = PHASES[check.to];
  const cat = structuredClone(catalogue);
  cat.training_phase = {
    ...(cat.training_phase ?? {}),
    current: check.to,
    name: nextDef.name,
    started: date,
    previous_phase: check.from,
    advanced_on: date,
    blocks_in_phase: 0,
  };
  return { catalogue: cat, advanced: true, check };
}

// Progress for the Today indicator: block progress + target tracking.
export function phaseProgress(catalogue) {
  const current = catalogue?.training_phase?.current ?? 1;
  const def = PHASES[current];
  const rb = catalogue?.rolling_bests ?? {};
  const done = blocksInPhase(catalogue);
  const total = def?.blocks ?? 1;
  const targets = (def?.targets ?? []).map(t => ({
    label: t.label, metric: t.metric, target: t.target, unit: t.unit, lower: t.lower,
    current: rb[t.metric] ?? null,
    met: rb[t.metric] != null && (t.lower ? rb[t.metric] <= t.target : rb[t.metric] >= t.target),
  }));
  return {
    phase: current,
    name: def?.name ?? `Phase ${current}`,
    focus: def?.focus ?? '',
    blocks_done: done,
    blocks_total: total,
    pct: Math.min(100, Math.round(100 * done / total)),
    terminal: !!def?.terminal,
    targets,
  };
}
