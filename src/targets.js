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
import { phaseTargetFor } from './phases.js';

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

  // Fatigue cost of adding a second 25 to a 25m stretch effort. The v26
  // formula treated this as a NEGATIVE (savings) — that produced an implied
  // 50m FASTER than 2×stretch, which is arithmetically impossible: even with
  // the turn advantage, a 50m held at max effort trades some pace off L1
  // (pacing the whole 50) so the total ≈ L1 + (L1 + turn_cost). turn_cost is
  // a small POSITIVE fatigue debit on top of two 25s worth of work; 0.8-1.2s
  // is the coaching range.
  turn_cost_s: 1.0,
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

function currentPhase(catalogue) {
  return catalogue?.training_phase?.current ?? 1;
}

// Round-5: detect a training layoff so today's targets aren't calibrated to
// a swim from 2+ weeks ago. If the last pool session is >10 days back, mark
// this as a re-entry and de-rate the sprint anchor by 2.5% (fair for a
// two-week gap; the LLM prompt will frame it as a re-entry, not a PR attempt).
const LAYOFF_THRESHOLD_DAYS = 10;
const RE_ENTRY_DE_RATE = 0.025;
function daysSinceLastPool(catalogue, today) {
  const sessions = Array.isArray(catalogue?.sessions) ? catalogue.sessions : [];
  const lastPool = sessions.find(s => s?.type === 'pool' && typeof s?.date === 'string');
  if (!lastPool) return null;
  const t = Date.parse(String(today));
  const l = Date.parse(lastPool.date);
  if (!Number.isFinite(t) || !Number.isFinite(l)) return null;
  return Math.floor((t - l) / (1000 * 60 * 60 * 24));
}
function layoffContext(catalogue, todayISO) {
  const days = daysSinceLastPool(catalogue, todayISO ?? new Date().toISOString().slice(0, 10));
  return { days_since_last_pool: days, is_re_entry: days != null && days > LAYOFF_THRESHOLD_DAYS };
}

/**
 * Compute the SWOLF target: one better than the current best, but never
 * tighter than the current phase's SWOLF milestone (no point asking for 24 in
 * Phase 1 when the milestone is 27 and the best is 28 — step toward it
 * sensibly). The milestone comes live from phases.js, so it tightens
 * automatically as the phase advances (27 → 25 → 23).
 */
function swolfTarget(catalogue) {
  const best = rb(catalogue).best_avg_swolf;
  if (best == null) return null;
  const stepped = best - TARGET_STEPS.swolf_stretch;
  const phaseFloor = phaseTargetFor(currentPhase(catalogue), 'best_avg_swolf');
  // The target should not undershoot the phase milestone by more than the step.
  if (phaseFloor != null && stepped < phaseFloor) return phaseFloor;
  return stepped;
}

function sprintSwolfTarget(catalogue) {
  const best = rb(catalogue).best_sprint_swolf;
  if (best == null) return null;
  return best - TARGET_STEPS.swolf_stretch;
}

/**
 * Sprint 25m targets — one coherent ladder for the LLM to restate verbatim.
 *
 * A single anchor (the current best 25m sprint) drives every downstream number
 * so beat/stretch/implied-50m can't disagree. Round-4 feedback: the plan had
 * been prescribing three different 50m goals in one sprint session
 * (phase_50m 33s vs 2×stretch 32.6s vs an implied 31s from the phase 25m).
 * The `implied_50m_from_stretch_s` field is the ONE 50m number to prescribe in
 * a sprint session's 50m reps; `phase_50m_target_s` (via race_pace) is the
 * long-horizon aspiration, not a per-session prescription.
 */
function sprintTargets(catalogue, opts = {}) {
  const rawAnchor = rb(catalogue).best_25m_sprint_protocol_s ?? rb(catalogue).best_25m_split_s;
  const layoff = layoffContext(catalogue, opts.date);
  // De-rate the anchor on a re-entry so the "beat" floor isn't set at a PR
  // the athlete swam two weeks ago fresh. Slower anchor → slower stretch →
  // more achievable prescriptions coming back in.
  const anchor = (rawAnchor != null && layoff.is_re_entry)
    ? round1(rawAnchor * (1 + RE_ENTRY_DE_RATE))
    : rawAnchor;
  const stretch = anchor != null ? round1(anchor - TARGET_STEPS.sprint_25m_stretch_s) : null;
  // 50m = L1 at stretch pace + L2 at stretch pace + a small fatigue debit.
  // Always > 2×stretch (round-5 assertion: never present an implied 50m the
  // athlete's own 25m target can't produce). Feedback also asked that the
  // long-horizon phase goal live in its OWN field, not mixed into today's
  // ladder — that field is `phase_goal_50m_s` (from phases.js) vs today's
  // derived `implied_50m_from_stretch_s`.
  const implied50 = stretch != null ? round1(stretch * 2 + TARGET_STEPS.turn_cost_s) : null;
  const phase25 = phaseTargetFor(currentPhase(catalogue), 'best_25m_sprint_protocol_s');
  // The phase's 50m milestone must sit AHEAD of what today's 25m targets
  // already imply, or it isn't a goal — it's a number the athlete has passed.
  // Block-6 report: phase_goal_50m_s was 33.0s while implied_50m was 32.4s and
  // the standing best 33.1s, i.e. the "goal" was slower than tonight's session
  // and barely ahead of a result already achieved. When the athlete outgrows
  // the current phase's milestone, step to the next phase's; if there isn't
  // one, keep it a genuine stretch beyond today's implied time.
  const rawPhase50 = phaseTargetFor(currentPhase(catalogue), 'best_50m_equiv_s');
  let phase50Goal = rawPhase50;
  let phaseGoalStale = false;
  if (rawPhase50 != null && implied50 != null && rawPhase50 >= implied50) {
    phaseGoalStale = true;
    const next = phaseTargetFor(currentPhase(catalogue) + 1, 'best_50m_equiv_s');
    phase50Goal = (next != null && next < implied50) ? next : round1(implied50 - 0.5);
  }
  return {
    beat_25m_s: anchor ?? null,
    stretch_25m_s: stretch,
    implied_50m_from_stretch_s: implied50,
    sprint_swolf_target: sprintSwolfTarget(catalogue),
    stroke_count_target: TARGET_STEPS.stroke_count_target,
    stroke_count_acceptable: TARGET_STEPS.stroke_count_acceptable,
    phase_25m_target_s: phase25 ?? null,
    phase_goal_50m_s: phase50Goal ?? null, // long-horizon goal — always AHEAD of implied_50m
    phase_goal_outgrown: phaseGoalStale,   // true when the milestone was passed and had to be stepped
    re_entry: layoff.is_re_entry,          // LLM prompt frames re-entry differently
    days_since_last_pool: layoff.days_since_last_pool,
    pre_layoff_beat_25m_s: layoff.is_re_entry ? rawAnchor : undefined,
  };
}

/**
 * Threshold targets.
 */
function thresholdTargets(catalogue) {
  // The watch shows no live pace, so a /100m pace target isn't actionable
  // mid-set. Prescribe by EFFORT (RPE) + stroke-count + SWOLF, which the athlete
  // can hold and observe in-pool. (The sustainable threshold-pace best is kept
  // only as context for analysis, not as a prescribed target.)
  return {
    effort: 'comfortably hard — RPE 7–8 (threshold: strong but repeatable, not max)',
    swolf_target: swolfTarget(catalogue),
    stroke_count_target: 9, // threshold reps run longer strokes than sprint
    pace_context_per_100m: rb(catalogue).best_threshold_pace_per_100m ?? null, // analysis context only
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
  const phase50 = phaseTargetFor(currentPhase(catalogue), 'best_50m_equiv_s');
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
export function computeTargets(catalogue, subtype, opts = {}) {
  switch (subtype) {
    case 'sprint':    return sprintTargets(catalogue, opts);
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
