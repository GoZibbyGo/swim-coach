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
