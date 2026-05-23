// Session validator — the deterministic safety net.
//
// Validates a structured session (whether produced by the LLM or the fallback
// library) for correctness before it is shown to the athlete or written to
// the catalogue. This is the one job the LLM is genuinely weakest at:
// arithmetic and constraint-checking. Hard errors mean "reject / regenerate";
// warnings mean "accept but surface".
//
// ── Structured session contract ──────────────────────────────────────────
// {
//   date, type: 'pool'|'dryland', subtype, phase,
//   block_number, session_in_block,
//   total_volume_m,                       // pool only
//   blocks: [
//     { name, volume_m, cue?, sets: [
//       { reps, distance_m, stroke?, effort?, rest_s?, cue? }
//     ]}
//   ],
//   targets, tracking?, active_flags?
// }
// ───────────────────────────────────────────────────────────────────────────

import { POOL_VOLUME_TARGETS_M, POOL_SUBTYPES } from './schema.js';
import { restrictionsForFlags } from './flag-rules.js';
import { phaseHasSprintFinish, volumeTargetsForPhase } from './phases.js';

const SPRINT_REST_MIN_S = 120;       // max-effort sprint reps need ≥2 min
const THRESHOLD_REST_MIN_S = 30;     // threshold sets >400m need ≥30 s
const THRESHOLD_LONG_SET_M = 400;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A set counts as a max-effort sprint rep if the effort text says so, or it's
// a short rep inside a sprint-flavoured block.
function isMaxEffortSprint(set, block, session) {
  const effort = String(set.effort ?? '').toLowerCase();
  const blockName = String(block.name ?? '').toLowerCase();
  const effortMax = /max|100%|all[- ]?out/.test(effort);
  const blockSprint = /sprint|finish|max/.test(blockName);
  const shortRep = (set.distance_m ?? 0) <= 50;
  return (effortMax && shortRep) || (blockSprint && shortRep && session.subtype !== 'recovery');
}

// ──────────────────────────────────────────────────────────────────────────
// Individual checks — each returns { errors: [], warnings: [] }
// ──────────────────────────────────────────────────────────────────────────

function checkDistances(session) {
  const errors = [];
  let total = 0;
  for (const block of session.blocks ?? []) {
    let blockSum = 0;
    for (const set of block.sets ?? []) {
      const reps = Number(set.reps ?? 1);
      const dist = Number(set.distance_m ?? 0);
      if (!Number.isFinite(reps) || !Number.isFinite(dist)) {
        errors.push(`Block "${block.name}": a set has non-numeric reps/distance.`);
        continue;
      }
      blockSum += reps * dist;
    }
    if (block.volume_m != null && Number(block.volume_m) !== blockSum) {
      errors.push(`Block "${block.name}": stated volume ${block.volume_m}m ≠ computed ${blockSum}m.`);
    }
    total += blockSum;
  }
  if (session.total_volume_m != null && Number(session.total_volume_m) !== total) {
    errors.push(`Total volume ${session.total_volume_m}m ≠ sum of blocks ${total}m.`);
  }
  return { errors, warnings: [], computed_total_m: total };
}

function checkRest(session) {
  const errors = [];
  for (const block of session.blocks ?? []) {
    for (const set of block.sets ?? []) {
      const rest = Number(set.rest_s ?? 0);
      if (isMaxEffortSprint(set, block, session) && rest < SPRINT_REST_MIN_S) {
        errors.push(`${block.name}: max-effort ${set.reps}×${set.distance_m}m has ${rest}s rest — sprint reps need ≥${SPRINT_REST_MIN_S}s. No exceptions.`);
      }
      if (session.subtype === 'threshold' && (set.distance_m ?? 0) > THRESHOLD_LONG_SET_M && rest < THRESHOLD_REST_MIN_S) {
        errors.push(`${block.name}: threshold set ${set.distance_m}m has ${rest}s rest — sets >${THRESHOLD_LONG_SET_M}m need ≥${THRESHOLD_REST_MIN_S}s.`);
      }
    }
  }
  return { errors, warnings: [] };
}

function checkStructure(session) {
  const errors = [];
  const warnings = [];
  if (session.type === 'pool') {
    const names = (session.blocks ?? []).map(b => String(b.name ?? '').toLowerCase());
    if (!names.some(n => n.includes('warm'))) errors.push('Pool session is missing a warm-up block.');
    if (!names.some(n => n.includes('main'))) errors.push('Pool session is missing a main set block.');
    if (!names.some(n => n.includes('cool'))) errors.push('Pool session is missing a cool-down block.');
    // Phases that mandate a sprint finish (1 & 2) should include one for
    // sprint/race sessions. Phase 3 (taper) does not.
    let sprintFinishExpected = false;
    try { sprintFinishExpected = phaseHasSprintFinish(session.phase); } catch { sprintFinishExpected = false; }
    if ((session.subtype === 'sprint' || session.subtype === 'race_pace') &&
        sprintFinishExpected &&
        !names.some(n => n.includes('finish') || n.includes('sprint'))) {
      warnings.push(`Phase ${session.phase} sprint/race session has no explicit sprint/finish block — expected for this phase.`);
    }
  }
  if (session.type === 'dryland') {
    if (!isObject(session.dryland) && !(Array.isArray(session.blocks) && session.blocks.length)) {
      errors.push('Dryland session has no exercise blocks.');
    }
  }
  return { errors, warnings };
}

function checkVolume(session) {
  const warnings = [];
  if (session.type !== 'pool') return { errors: [], warnings };
  // Phase-specific range when the phase is known; else the default.
  const range = volumeTargetsForPhase(session.phase, session.subtype) ?? POOL_VOLUME_TARGETS_M[session.subtype];
  if (range && session.total_volume_m != null) {
    const v = Number(session.total_volume_m);
    if (v < range.min || v > range.max) {
      warnings.push(`Total ${v}m is outside the ${session.subtype} target range ${range.min}-${range.max}m.`);
    }
  }
  return { errors: [], warnings };
}

// Every block must contain real content — a pool block needs ≥1 set with
// reps×distance; a dryland block needs ≥1 exercise. Catches the LLM emitting
// section headers with no sets (which previously passed as a "valid" session).
function checkContent(session) {
  const errors = [];
  const blocks = session.blocks ?? [];
  if (!blocks.length) {
    errors.push('Session has no blocks.');
    return { errors, warnings: [] };
  }
  for (const block of blocks) {
    if (session.type === 'dryland') {
      if (!Array.isArray(block.exercises) || block.exercises.length === 0) {
        errors.push(`Block "${block.name}" has no exercises — empty blocks are not allowed.`);
      }
    } else {
      const hasReal = (block.sets ?? []).some(s => Number(s.reps) > 0 && Number(s.distance_m) > 0);
      if (!hasReal) errors.push(`Block "${block.name}" has no real sets (reps×distance) — empty blocks are not allowed.`);
    }
  }
  return { errors, warnings: [] };
}

function checkSubtype(session) {
  const errors = [];
  const warnings = [];
  if (session.type === 'pool' && !POOL_SUBTYPES.includes(session.subtype)) {
    warnings.push(`Pool subtype "${session.subtype}" is not in the known list.`);
  }
  return { errors, warnings };
}

// A sprint session should be sprint-dominant. Warn (don't block) if there's
// little true max-effort work — catches a "sprint" session whose main set is
// actually threshold/pull filler.
function checkSprintQuality(session) {
  const warnings = [];
  if (session.subtype !== 'sprint') return { errors: [], warnings };
  let maxDist = 0;
  for (const block of session.blocks ?? []) {
    for (const set of block.sets ?? []) {
      if (isMaxEffortSprint(set, block, session)) maxDist += Number(set.reps ?? 1) * Number(set.distance_m ?? 0);
    }
  }
  if (maxDist < 250) {
    warnings.push(`Sprint session has only ${maxDist}m of true max-effort sprint work — keep the main set sprint-dominant (≈250m+ of max reps), not threshold/pull filler.`);
  }
  return { errors: [], warnings };
}

// Flag respect is a WARNING, not an error: naive keyword scanning can't tell
// "no dolphin kick" (compliant) from "dolphin kick" (violation). We surface
// the mention and a negation hint for human/LLM review rather than blocking.
function checkFlags(session, activeFlags = []) {
  const warnings = [];
  const restrictions = restrictionsForFlags(activeFlags);
  if (!restrictions.length) return { errors: [], warnings };
  const text = JSON.stringify(session).toLowerCase();
  for (const r of restrictions) {
    for (const kw of r.forbid_keywords) {
      const k = kw.toLowerCase();
      const idx = text.indexOf(k);
      if (idx >= 0) {
        const before = text.slice(Math.max(0, idx - 12), idx);
        const negated = /(no|without|avoid|skip|not|zero)\b[\s\w-]*$/.test(before);
        if (!negated) {
          warnings.push(`Active flag "${r.label}" restricts "${kw}", and the session mentions it without a clear negation — verify it isn't prescribing prohibited work.`);
        }
      }
    }
  }
  return { errors: [], warnings };
}

function checkTargets(session) {
  const warnings = [];
  if (session.type === 'pool' && (session.targets == null || Object.keys(session.targets).length === 0)) {
    warnings.push('Session has no targets — progression cues will be generic.');
  }
  return { errors: [], warnings };
}

// ──────────────────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {object} session - structured session (see contract above)
 * @param {object} [opts]
 * @param {string[]} [opts.activeFlags] - injury/condition flags to enforce
 * @returns {{ valid: boolean, errors: string[], warnings: string[], computed_total_m: number }}
 */
export function validateGeneratedSession(session, opts = {}) {
  if (!isObject(session)) {
    return { valid: false, errors: ['session must be an object'], warnings: [], computed_total_m: 0 };
  }

  const activeFlags = opts.activeFlags ?? session.active_flags ?? [];
  const checks = [
    checkDistances(session),
    checkRest(session),
    checkStructure(session),
    checkContent(session),
    checkVolume(session),
    checkSubtype(session),
    checkSprintQuality(session),
    checkFlags(session, activeFlags),
    checkTargets(session),
  ];

  const errors = checks.flatMap(c => c.errors ?? []);
  const warnings = checks.flatMap(c => c.warnings ?? []);
  const computed_total_m = checks[0].computed_total_m ?? 0;

  return { valid: errors.length === 0, errors, warnings, computed_total_m };
}
