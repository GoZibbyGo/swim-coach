// Catalogue schema — constants, validators, and defaults.
// Mirrors the snake_case structure of athlete_catalogue.json so the JSON
// remains the unambiguous source of truth across phone and desktop.

export const SESSION_TYPES = Object.freeze(['pool', 'dryland', 'open_water']);

export const POOL_SUBTYPES = Object.freeze([
  'sprint',
  'technique',
  'threshold',
  'race_pace',
  'recovery',
  'mixed',
]);

export const DRYLAND_SUBTYPES = Object.freeze([
  'strength',
  'endurance',
  'mobility',
  'pulling_strength',
  'push_core_legs',
]);

export const SELF_EVAL_VALUES = Object.freeze(['Strong', 'OK', 'Weak']);

export const PHASES = Object.freeze([
  { phase: 1, name: 'Sprint Development', weeks: '1-6', focus: 'Neuromuscular speed, SWOLF reduction' },
  { phase: 2, name: 'Speed Integration', weeks: '7-12', focus: 'Race-pace reps, turn sharpening, lactate tolerance' },
  { phase: 3, name: 'Race Sharpening', weeks: '13-16', focus: 'Taper, race simulation, sub-30 attempt' },
]);

export const BLOCK_TARGET = Object.freeze({ pool: 3, dryland: 1, total: 4 });

// Per phase 1 of SKILL_session_generator.md.
export const POOL_VOLUME_TARGETS_M = Object.freeze({
  sprint:    { min: 1600, max: 1800 },
  technique: { min: 2000, max: 2200 },
  threshold: { min: 2400, max: 2600 },
  race_pace: { min: 1800, max: 2000 },
  recovery:  { min: 1200, max: 1500 },
});

// Dryland slot rotates by block_number % 4 → 0=S1, 1=S2, 2=S3, 3=S4.
export function drylandSlotForBlock(blockNumber) {
  const mod = ((Number(blockNumber) % 4) + 4) % 4;
  return mod === 0 ? 1 : mod === 1 ? 2 : mod === 2 ? 3 : 4;
}

// ──────────────────────────────────────────────────────────────────────────
// Validators
//
// Return shape: { valid: boolean, errors: string[], warnings: string[] }
// `errors` indicates schema violations that should block writes.
// `warnings` indicates suspicious-but-tolerated values (e.g. legacy subtypes,
// missing-but-optional fields) — surface to the user, don't block.
// ──────────────────────────────────────────────────────────────────────────

function ok() {
  return { valid: true, errors: [], warnings: [] };
}

function fail(errors = [], warnings = []) {
  return { valid: errors.length === 0, errors, warnings };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function validateSession(session) {
  const errors = [];
  const warnings = [];

  if (!isObject(session)) {
    return fail(['session must be an object']);
  }

  if (typeof session.id !== 'number' || !Number.isInteger(session.id) || session.id < 1) {
    errors.push('id must be a positive integer');
  }

  if (typeof session.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(session.date)) {
    errors.push('date must be a YYYY-MM-DD string');
  }

  if (!SESSION_TYPES.includes(session.type)) {
    errors.push(`type must be one of ${SESSION_TYPES.join(', ')}`);
  }

  if (session.type === 'pool') {
    if (!POOL_SUBTYPES.includes(session.subtype)) {
      warnings.push(`pool subtype "${session.subtype}" is not in known list — accepted but flagged`);
    }
    if (session.distance_m == null || typeof session.distance_m !== 'number' || session.distance_m <= 0) {
      errors.push('pool sessions require positive distance_m');
    }
  } else if (session.type === 'dryland') {
    if (session.subtype != null && !DRYLAND_SUBTYPES.includes(session.subtype)) {
      warnings.push(`dryland subtype "${session.subtype}" is not in known list — accepted but flagged`);
    }
    if (!isObject(session.dryland)) {
      errors.push('dryland sessions require a dryland object');
    } else if (!Array.isArray(session.dryland.exercises)) {
      errors.push('dryland.exercises must be an array');
    }
  }

  if (session.phase_at_time != null && !PHASES.some(p => p.phase === session.phase_at_time)) {
    warnings.push(`phase_at_time ${session.phase_at_time} is outside the known phases`);
  }

  if (session.metrics != null && !isObject(session.metrics)) {
    errors.push('metrics must be an object when present');
  }

  if (session.metrics?.self_eval != null && !SELF_EVAL_VALUES.includes(session.metrics.self_eval)) {
    warnings.push(`self_eval "${session.metrics.self_eval}" not in canonical list (${SELF_EVAL_VALUES.join('/')})`);
  }

  return fail(errors, warnings);
}

export function validateCatalogue(catalogue) {
  const errors = [];
  const warnings = [];

  if (!isObject(catalogue)) return fail(['catalogue must be an object']);

  if (!isObject(catalogue.athlete)) errors.push('catalogue.athlete missing');
  if (!isObject(catalogue.training_phase)) errors.push('catalogue.training_phase missing');
  if (!isObject(catalogue.rolling_bests)) errors.push('catalogue.rolling_bests missing');
  if (!isObject(catalogue.weekly_block_tracking)) errors.push('catalogue.weekly_block_tracking missing');

  if (!Array.isArray(catalogue.sessions)) {
    errors.push('catalogue.sessions must be an array');
  } else {
    const ids = new Set();
    for (const s of catalogue.sessions) {
      const r = validateSession(s);
      r.errors.forEach(e => errors.push(`session ${s?.id ?? '?'}: ${e}`));
      r.warnings.forEach(w => warnings.push(`session ${s?.id ?? '?'}: ${w}`));
      if (typeof s?.id === 'number') {
        if (ids.has(s.id)) errors.push(`duplicate session id ${s.id}`);
        ids.add(s.id);
      }
    }
  }

  if (errors.length === 0 && warnings.length === 0) return ok();
  return fail(errors, warnings);
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
// Catalogue migration / seeding
//
// Fields the app introduces that may not exist in an older catalogue. The
// migration adds them with a sensible seed only if absent — it never
// overwrites an existing value. Add future migrations here.
// ──────────────────────────────────────────────────────────────────────────

export const ROLLING_BEST_SEEDS = Object.freeze({
  // Best *sustainable* threshold pace (set average on a good day), per 100m.
  // Seeded from the Block 2 plan's "threshold best of 1:36" reference.
  // Distinct from best_avg_pace_per_100m, which is a whole-session average and
  // is dominated by short sprint days (1:27) — wrong basis for threshold sets.
  best_threshold_pace_per_100m: '1:36',
});

// ──────────────────────────────────────────────────────────────────────────
// One-time corrective migration: standing-start 25m scrub.
//
// Before the standing-start parser fix, the "best 25m" was the fastest single
// freestyle length of ANY kind — including L2+ of a 50m rep, a turn-aided
// "flying" split that's ~1-2s quicker than a from-a-push 25m. A 4×50m session
// recorded a 15.0s flying split as the best 25m, burying the real standing-
// start PR (16.6s) from the same session and miscalibrating every future
// sprint target derived from it.
//
// Unlike the additive seeding above, this pass DELIBERATELY overwrites the
// polluted values. It is gated on `migrations_applied` so it runs exactly once
// per catalogue, then never again — so later legitimate bests are never
// stomped. It re-derives each pool session's standing-start best from its own
// stored per-rep splits (the first length of each non-drill interval), then
// recomputes the 25m rolling bests, excluding the known-bad early readings
// (≤ 2026-04-10) to match the trend-graph display filter.
// ──────────────────────────────────────────────────────────────────────────

const SCRUB_25M_KEY = 'standing_start_25m_v1';
const SCRUB_BAD_25M_ON_OR_BEFORE = '2026-04-10'; // known-faulty 16.1/16.3 readings
const STANDING_START_FLOOR_S = 13.0;             // below this a 25m split is implausible

// Fastest standing-start length in a stored pool session: the first split of
// each non-drill interval. Returns null when the session has no usable
// per-rep breakdown (e.g. hand-authored or "describe the sets" logs).
function standingStartBest(session) {
  const bd = session?.breakdown;
  if (!Array.isArray(bd) || bd.length === 0) return null;
  let best = null;
  for (const it of bd) {
    if (it?.is_drill) continue;
    const splits = it?.splits_s;
    if (!Array.isArray(splits) || splits.length === 0) continue;
    const first = splits[0]; // standing start; later splits are flying (turn-aided)
    if (first != null && Number.isFinite(first) && first > STANDING_START_FLOOR_S) {
      if (best == null || first < best) best = first;
    }
  }
  return best == null ? null : Math.round(best * 10) / 10;
}

function scrubStandingStart25m(cat) {
  const sessions = Array.isArray(cat.sessions) ? cat.sessions : [];

  // 1) Correct each pool session's stored best_25m from its real splits, so the
  //    Best-25m graph (which plots per-session metrics) no longer shows the dip.
  for (const s of sessions) {
    if (s?.type !== 'pool' || !s.metrics) continue;
    const derived = standingStartBest(s);
    if (derived != null && s.metrics.best_25m_split_s !== derived) {
      const prev = s.metrics.best_25m_split_s;
      const prevCtx = s.metrics.best_25m_split_context ?? '';
      s.metrics.best_25m_split_s = derived;
      s.metrics.best_25m_split_context =
        `standing-start best (corrected from ${prev ?? 'n/a'}s` +
        `${prevCtx ? `, was "${prevCtx}"` : ''} — flying split excluded)`;
    }
  }

  // 2) Recompute the 25m rolling bests from corrected, in-window sessions.
  let bestVal = null, bestDate = null, bestId = null;
  for (const s of sessions) {
    if (s?.type !== 'pool' || !s.metrics) continue;
    if (String(s.date) <= SCRUB_BAD_25M_ON_OR_BEFORE) continue; // drop known-bad early data
    const v = s.metrics.best_25m_split_s;
    if (v != null && Number.isFinite(v) && (bestVal == null || v < bestVal)) {
      bestVal = v; bestDate = s.date; bestId = s.id;
    }
  }
  if (bestVal != null) {
    const rb = cat.rolling_bests;
    rb.best_25m_sprint_protocol_s = bestVal;
    rb.best_25m_sprint_protocol_date = bestDate;
    rb.best_25m_sprint_protocol_session_id = bestId;
    rb.best_25m_split_s = bestVal;
    rb.best_25m_date = bestDate;
    rb.best_25m_session_id = bestId;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// One-time backfill: 50m / 100m bests from existing logged reps.
//
// `best_50m_equiv_s` / `best_100m_split_s` were never updated from sessions
// (no flag-detection path existed before this change), so they sat at their
// hand-seeded estimates. Now that the engine tracks them going forward, this
// pass seeds them from history: the fastest actual full-distance rep already
// recorded in any pool session's stored `breakdown`. Improve-only — it never
// raises a best, matching the going-forward "new best beats prior" rule.
// ──────────────────────────────────────────────────────────────────────────

const TRACK_50_100_KEY = 'track_50m_100m_v1';

// Fastest full-distance rep in a session's stored breakdown: a non-drill
// interval with exactly `splitCount` length splits. Time = interval time, or
// the sum of the splits. Returns seconds (1 dp) or null.
function bestRepFromBreakdown(session, splitCount) {
  const bd = session?.breakdown;
  if (!Array.isArray(bd)) return null;
  let best = null;
  for (const it of bd) {
    if (it?.is_drill) continue;
    const splits = it?.splits_s;
    if (!Array.isArray(splits) || splits.length !== splitCount) continue;
    if (!splits.every(x => x != null && Number.isFinite(x))) continue;
    const t = (it.time_s != null && Number.isFinite(it.time_s))
      ? it.time_s
      : splits.reduce((sum, x) => sum + x, 0);
    if (t > 0 && (best == null || t < best)) best = Math.round(t * 10) / 10;
  }
  return best;
}

function backfill50m100m(cat) {
  const sessions = Array.isArray(cat.sessions) ? cat.sessions : [];
  const rb = cat.rolling_bests;
  const scan = (splitCount) => {
    let val = null, date = null, id = null;
    for (const s of sessions) {
      if (s?.type !== 'pool') continue;
      const t = bestRepFromBreakdown(s, splitCount);
      if (t != null && (val == null || t < val)) { val = t; date = s.date; id = s.id; }
    }
    return { val, date, id };
  };
  const r50 = scan(2);
  if (r50.val != null && (rb.best_50m_equiv_s == null || r50.val < rb.best_50m_equiv_s)) {
    rb.best_50m_equiv_s = r50.val;
    rb.best_50m_equiv_date = r50.date;
    rb.best_50m_equiv_session_id = r50.id;
  }
  const r100 = scan(4);
  if (r100.val != null && (rb.best_100m_split_s == null || r100.val < rb.best_100m_split_s)) {
    rb.best_100m_split_s = r100.val;
    rb.best_100m_split_date = r100.date;
    rb.best_100m_split_session_id = r100.id;
  }
}

export function migrateCatalogue(catalogue) {
  if (catalogue == null || typeof catalogue !== 'object') return catalogue;
  const cat = structuredClone(catalogue);
  cat.rolling_bests = cat.rolling_bests ?? {};
  for (const [key, seed] of Object.entries(ROLLING_BEST_SEEDS)) {
    if (cat.rolling_bests[key] == null) cat.rolling_bests[key] = seed;
  }
  // Block-based phase advancement needs a per-phase block counter. Seed it
  // from blocks already completed (assumed to belong to the current phase,
  // which holds at programme start in Phase 1).
  cat.training_phase = cat.training_phase ?? {};
  if (cat.training_phase.blocks_in_phase == null) {
    const lastCompleted = cat.weekly_block_tracking?.last_completed_block ?? 0;
    cat.training_phase.blocks_in_phase = (cat.training_phase.current ?? 1) === 1 ? lastCompleted : 0;
  }

  // One-time corrective migrations (run exactly once per catalogue).
  cat.migrations_applied = Array.isArray(cat.migrations_applied) ? cat.migrations_applied : [];
  if (!cat.migrations_applied.includes(SCRUB_25M_KEY)) {
    scrubStandingStart25m(cat);
    cat.migrations_applied.push(SCRUB_25M_KEY);
  }
  if (!cat.migrations_applied.includes(TRACK_50_100_KEY)) {
    backfill50m100m(cat);
    cat.migrations_applied.push(TRACK_50_100_KEY);
  }

  return cat;
}

export function nextSessionId(catalogue) {
  if (!Array.isArray(catalogue?.sessions) || catalogue.sessions.length === 0) return 1;
  let max = 0;
  for (const s of catalogue.sessions) {
    if (typeof s?.id === 'number' && s.id > max) max = s.id;
  }
  return max + 1;
}

// Returns the catalogue with the new session prepended (most-recent-first
// ordering, matching the existing file).
export function appendSession(catalogue, session) {
  const r = validateSession(session);
  if (!r.valid) {
    const err = new Error(`session failed validation: ${r.errors.join('; ')}`);
    err.errors = r.errors;
    throw err;
  }
  return {
    ...catalogue,
    sessions: [session, ...(catalogue.sessions ?? [])],
  };
}
