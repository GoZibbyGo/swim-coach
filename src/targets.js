// Target-computation engine.
//
// Derives the targets to embed in a generated session from the catalogue's
// rolling_bests. Fully deterministic — given the same bests, it produces the
// same targets. No LLM involved.
//
// Step sizes are harvested from the existing system:
//   - SKILL_session_generator.md STEP 3:
//       sprint  → "beat your best 25m of [X]s"
//       thresh  → "hold [avg pace - 3s] per 100m"
//       swolf   → "[current avg - 2]"
//   - Block2_Session3_Sprint.md:
//       sprint  → "beat 16.8s ... aim for sub-16.5s"  (best, stretch -0.3)
//       swolf   → "23 (break your current best of 24)" (best -1)
//       50m sim → "sub-38.0s" (best 39.0 → -1.0)
//   - block_2_session_1_plan targets:
//       thresh  → "1:33/100m or better" (best 1:36 → -3)
//
// All step sizes are exported and tunable.

import { parseTimeToSeconds } from './garmin-parser.js';

// ──────────────────────────────────────────────────────────────────────────
// Tunable step sizes. Adjust here to make progression more or less aggressive.
// ──────────────────────────────────────────────────────────────────────────

export const TARGET_STEPS = Object.freeze({
  // Sprint 25m: the "beat this" baseline is the current best; the stretch
  // goal is best - sprint_25m_stretch_s.
  sprint_25m_stretch_s: 0.3,

  // Threshold 100m pace improvement (seconds faster per 100m).
  threshold_pace_improvement_s: 3,

  // SWOLF: target = best - swolf_stretch (floored at the phase swolf_target).
  swolf_stretch: 1,

  // 50m race-pace rep: target = best - race_50m_stretch_s.
  race_50m_stretch_s: 1,

  // Default stroke-count target per length (Phase 1 sprint efficiency goal).
  stroke_count_target: 7,
  stroke_count_acceptable: 8,
});

// ──────────────────────────────────────────────────────────────────────────
// Pace helpers — pace strings are "m:ss" per 100m.
// ──────────────────────────────────────────────────────────────────────────

export function paceToSeconds(pace) {
  return parseTimeToSeconds(pace);
}

export function secondsToPace(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return null;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds - m * 60);
  // Handle rounding that pushes seconds to 60.
  if (s === 60) return `${m + 1}:00`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Target computation
// ──────────────────────────────────────────────────────────────────────────

function rb(catalogue) {
  return catalogue?.rolling_bests ?? {};
}

function phaseGoals(catalogue) {
  return catalogue?.training_phase?.phase_goals ?? {};
}

/**
 * Compute the SWOLF target: one better than the current best, but never
 * tighter than the phase's stated swolf_target (no point asking for 28 when
 * the phase goal is 30 and the best is 31 — step toward the goal sensibly).
 */
function swolfTarget(catalogue) {
  const best = rb(catalogue).best_avg_swolf;
  if (best == null) return null;
  const stepped = best - TARGET_STEPS.swolf_stretch;
  const phaseFloor = phaseGoals(catalogue).swolf_target;
  // The target should not undershoot the phase goal by more than the step.
  if (phaseFloor != null && stepped < phaseFloor) return phaseFloor;
  return stepped;
}

function sprintSwolfTarget(catalogue) {
  const best = rb(catalogue).best_sprint_swolf;
  if (best == null) return null;
  return best - TARGET_STEPS.swolf_stretch;
}

/**
 * Sprint 25m targets.
 */
function sprintTargets(catalogue) {
  const best = rb(catalogue).best_25m_sprint_protocol_s ?? rb(catalogue).best_25m_split_s;
  const phaseTarget = phaseGoals(catalogue).best_25m_target_s;
  return {
    beat_25m_s: best ?? null,
    stretch_25m_s: best != null ? round1(best - TARGET_STEPS.sprint_25m_stretch_s) : null,
    sprint_swolf_target: sprintSwolfTarget(catalogue),
    stroke_count_target: TARGET_STEPS.stroke_count_target,
    stroke_count_acceptable: TARGET_STEPS.stroke_count_acceptable,
    phase_25m_target_s: phaseTarget ?? null,
  };
}

/**
 * Threshold targets.
 */
function thresholdTargets(catalogue) {
  // Use the dedicated *sustainable* threshold-pace best, NOT the whole-session
  // avg-pace best (which is dominated by short sprint days). Target = best - 3s.
  // The field is seeded via schema.migrateCatalogue() if a catalogue predates
  // its introduction.
  const bestPaceStr = rb(catalogue).best_threshold_pace_per_100m;
  const bestPaceS = bestPaceStr ? paceToSeconds(bestPaceStr) : null;
  const targetPaceS = bestPaceS != null ? bestPaceS - TARGET_STEPS.threshold_pace_improvement_s : null;
  return {
    main_set_pace_target: targetPaceS != null ? secondsToPace(targetPaceS) : null,
    main_set_pace_basis: bestPaceStr ?? null,
    swolf_target: swolfTarget(catalogue),
    stroke_count_target: 9, // threshold reps run longer strokes than sprint
  };
}

/**
 * Technique targets — efficiency-focused.
 */
function techniqueTargets(catalogue) {
  return {
    swolf_target: swolfTarget(catalogue),
    stroke_count_target: TARGET_STEPS.stroke_count_target + 1, // a touch looser than max sprint
  };
}

/**
 * Race-pace targets (50m focus).
 */
function racePaceTargets(catalogue) {
  const best50 = rb(catalogue).best_50m_equiv_s;
  const phase50 = phaseGoals(catalogue).best_50m_target_s;
  return {
    beat_50m_s: best50 ?? null,
    stretch_50m_s: best50 != null ? round1(best50 - TARGET_STEPS.race_50m_stretch_s) : null,
    swolf_target: sprintSwolfTarget(catalogue),
    phase_50m_target_s: phase50 ?? null,
  };
}

/**
 * Main entry point.
 * @param {object} catalogue
 * @param {string} subtype - 'sprint' | 'threshold' | 'technique' | 'race_pace' | 'recovery'
 * @returns {object} targets for that subtype
 */
export function computeTargets(catalogue, subtype) {
  switch (subtype) {
    case 'sprint':    return sprintTargets(catalogue);
    case 'threshold': return thresholdTargets(catalogue);
    case 'technique': return techniqueTargets(catalogue);
    case 'race_pace': return racePaceTargets(catalogue);
    case 'recovery':  return { swolf_target: null, note: 'Recovery — no performance targets; focus on form and ease.' };
    default:          return {};
  }
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
