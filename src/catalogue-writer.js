// Catalogue writer — the ONLY component that mutates the catalogue.
//
// Logs a completed session (app-generated or external), then:
//   - builds the session record (metrics, subtype, source)
//   - runs flag detection → coach_flags + new records (pool)
//   - updates rolling_bests for any PR
//   - advances block tracking (counts, completion, block rollover)
//   - manages the active_flags map with decay
//   - stores pending feedback adjustments for the next generation
//   - applies equipment constraints and external-session bookkeeping
//
// Pure: never mutates its input — returns a new catalogue. The LLM never
// touches this; it only ever produces structured inputs that flow through here.

import { migrateCatalogue, nextSessionId, BLOCK_TARGET, drylandSlotForBlock } from './schema.js';
import { detectFlags } from './flags.js';
import { inferPoolSubtype } from './classify.js';
import { mapFeedback, FEEDBACK_SIGNALS } from './symptom-mapper.js';
import { applyPhaseAdvancement } from './phases.js';

function clone(o) { return structuredClone(o); }
function today() { return new Date().toISOString().slice(0, 10); }

function flagDecay(flagId) {
  const sig = FEEDBACK_SIGNALS.find(s => s.effects?.flag === flagId);
  return sig?.decay ?? { sessions: 2 };
}

// Age the active-flags map by one session. When a flag passes its decay
// window we do NOT silently delete it — we mark it pending_clear (it stays
// ACTIVE, safety-first) and report it as "expiring" so the UI can ask the
// athlete to confirm removal. A recurrence resets it. New reported flags are
// added/refreshed. Returns { next, expiring } where expiring lists ids that
// just became removal candidates this session.
function updateActiveFlags(existing, reportedFlags, { sessionId, date }) {
  const next = {};
  const expiring = [];
  for (const [id, meta] of Object.entries(existing ?? {})) {
    if (reportedFlags.includes(id)) {
      // Symptom recurred → reset the clock, drop any pending removal.
      next[id] = { ...meta, sessions_since: 0, pending_clear: false };
      continue;
    }
    const sessionsSince = (meta.sessions_since ?? 0) + 1;
    const decay = meta.decay ?? flagDecay(id);
    const reachedDecay = decay && typeof decay === 'object' && decay.sessions != null
      ? sessionsSince >= decay.sessions
      : false; // 'until_resolved' etc. stay until explicitly cleared
    if (reachedDecay && !meta.pending_clear) expiring.push(id);
    next[id] = { ...meta, sessions_since: sessionsSince, pending_clear: reachedDecay || meta.pending_clear === true };
  }
  for (const id of reportedFlags) {
    next[id] = { onset_session_id: sessionId, onset_date: date, decay: flagDecay(id), sessions_since: 0, pending_clear: false };
  }
  return { next, expiring };
}

/**
 * Resolve a removal-candidate flag after the athlete confirms.
 * action 'remove' → delete it; action 'keep' → reset its clock (still active).
 */
export function resolveFlag(catalogue, flagId, action) {
  const cat = clone(catalogue);
  if (!cat.active_flags || !cat.active_flags[flagId]) return cat;
  if (action === 'remove') {
    delete cat.active_flags[flagId];
  } else {
    cat.active_flags[flagId] = { ...cat.active_flags[flagId], sessions_since: 0, pending_clear: false };
  }
  return cat;
}

// Per-interval breakdown stored on the session so the LLM analysis (and the
// Feedback tab) can produce rep-by-rep tables + interpretation anytime, not
// just at log time. Compact: one row per swimming interval.
function buildBreakdown(parsed) {
  if (!parsed?.intervals) return null;
  return parsed.intervals
    .filter(i => !i.is_rest)
    .map(i => ({
      n: i.interval_number,
      stroke: i.stroke ?? null,
      is_drill: String(i.stroke ?? '').trim().toLowerCase() === 'drill',
      distance_m: i.distance_m,
      time_s: i.time_s,
      swolf: i.swolf,
      avg_hr: i.avg_hr,
      max_hr: i.max_hr,
      avg_strokes: i.avg_strokes,
      rest_after_s: i.rest_after_s,
      splits_s: (i.lengths ?? []).map(l => l.time_s),
    }));
}

function buildPoolMetrics(parsed, extra) {
  const s = parsed?.summary ?? {};
  return {
    avg_pace_per_100m: s.avg_pace_per_100m ?? null,
    avg_swolf: s.avg_swolf ?? null,
    best_25m_split_s: s.best_25m_split_s ?? null,
    best_25m_split_context: s.best_25m_context ?? null,
    best_25m_unverified_s: s.best_25m_unverified_s ?? null,
    best_50m_split_s: s.best_50m_split_s ?? null,
    best_50m_split_context: s.best_50m_context ?? null,
    best_100m_split_s: s.best_100m_split_s ?? null,
    best_100m_split_context: s.best_100m_context ?? null,
    avg_hr: s.avg_hr ?? null,
    max_hr: s.max_hr ?? null,
    avg_strokes_per_length: s.avg_strokes_per_length ?? null,
    avg_dps_m: s.avg_dps_m ?? null,
    avg_stroke_rate_spm: s.avg_stroke_rate_spm ?? null,
    perceived_effort: extra.perceivedEffort ?? null,
    self_eval: extra.selfEval ?? null,
  };
}

function applyNewRecords(rollingBests, records, date, sessionId) {
  const rb = { ...rollingBests };
  const map = {
    best_25m_sprint_protocol_s: ['best_25m_sprint_protocol_date', 'best_25m_sprint_protocol_session_id'],
    best_25m_split_s: ['best_25m_date', 'best_25m_session_id'],
    best_50m_equiv_s: ['best_50m_equiv_date', 'best_50m_equiv_session_id'],
    best_100m_split_s: ['best_100m_split_date', 'best_100m_split_session_id'],
    best_avg_swolf: ['best_avg_swolf_date', 'best_avg_swolf_session_id'],
    best_sprint_swolf: ['best_sprint_swolf_date', 'best_sprint_swolf_session_id'],
    best_avg_pace_per_100m: ['best_avg_pace_date', 'best_avg_pace_session_id'],
  };
  for (const [key, value] of Object.entries(records ?? {})) {
    rb[key] = value;
    const meta = map[key];
    if (meta) { rb[meta[0]] = date; rb[meta[1]] = sessionId; }
  }
  return rb;
}

function advanceBlockTracking(tracking, type, { isExternal }) {
  const t = { ...tracking };
  if (type === 'dryland') t.current_block_dryland_count = (t.current_block_dryland_count ?? 0) + 1;
  else t.current_block_pool_count = (t.current_block_pool_count ?? 0) + 1;

  if (isExternal) t.current_block_plan_advisory = true;

  let blockCompleted = false;
  const pool = t.current_block_pool_count ?? 0;
  const dry = t.current_block_dryland_count ?? 0;
  if (pool >= BLOCK_TARGET.pool && dry >= BLOCK_TARGET.dryland) {
    // Block complete → roll over.
    blockCompleted = true;
    t.last_completed_block = t.current_block_number ?? 1;
    t.last_block_completed_date = today();
    t.current_block_number = (t.current_block_number ?? 1) + 1;
    t.current_block_pool_count = 0;
    t.current_block_dryland_count = 0;
    t.current_block_plan_advisory = false;
    t.dryland_slot_this_block = drylandSlotForBlock(t.current_block_number);
    t.current_block_started = today();
  }
  return { tracking: t, blockCompleted };
}

/**
 * Log a completed session into the catalogue.
 *
 * @param {object} catalogue
 * @param {object} input
 *   - type: 'pool' | 'dryland'
 *   - date?: 'YYYY-MM-DD'
 *   - parsed?: parseGarminCsv output (pool)
 *   - dryland?: { exercises: [...] } (dryland results)
 *   - subtype?: explicit subtype (overrides inference)
 *   - source?: 'app_generated' | 'external'  (default 'app_generated')
 *   - feedbackText?: free-text athlete feedback
 *   - perceivedEffort?, selfEval?, notes?
 * @returns {{ catalogue, session, flags, records, signals, subtype_inference }}
 */
export function logSession(catalogue, input = {}) {
  const cat = migrateCatalogue(catalogue);
  const date = input.date ?? today();
  const id = nextSessionId(cat);
  const type = input.type ?? 'pool';
  const source = input.source ?? 'app_generated';
  const isExternal = source === 'external';
  const phase = cat.training_phase?.current ?? 1;

  // ── Subtype: explicit > inferred (pool) > default (dryland) ──
  let subtype = input.subtype ?? null;
  let subtypeInference = null;
  if (!subtype) {
    if (type === 'pool' && input.parsed) {
      subtypeInference = inferPoolSubtype(input.parsed);
      subtype = subtypeInference.subtype;
    } else {
      subtype = type === 'dryland' ? 'strength' : 'mixed';
    }
  }

  // ── Feedback → structured signals ──
  const fb = input.feedbackText ? mapFeedback(input.feedbackText, { context: type }) : { matched: [], resolved: emptyResolved() };
  const signals = fb.resolved;

  // ── Flag detection (pool) ──
  let detected = { flags: [], new_records: {} };
  if (type === 'pool' && input.parsed) {
    detected = detectFlags(input.parsed, cat, { subtype });
  }

  // ── Build session record ──
  const partial = signals.data_quality.includes('partial');
  const session = {
    id, date, type, subtype,
    distance_m: type === 'pool' ? (input.parsed?.summary?.total_distance_m ?? null) : null,
    duration_min: input.durationMin ?? null,
    source,
    generator: input.generator ?? (isExternal ? 'external' : 'app_generated'),
    block_number: cat.weekly_block_tracking?.current_block_number ?? 1,
    metrics: type === 'pool' ? buildPoolMetrics(input.parsed, input) : null,
    breakdown: type === 'pool' ? buildBreakdown(input.parsed) : null,
    dryland: type === 'dryland' ? (input.dryland ?? { exercises: [] }) : null,
    phase_at_time: phase,
    injury_flags: signals.flags.length
      ? Object.fromEntries(signals.flags.map(f => [f, { onset_date: date, source: 'feedback' }]))
      : undefined,
    coach_flags: [
      ...detected.flags,
      ...signals.context_notes.map(n => `Feedback: ${n}`),
    ],
    notes: input.notes ?? (subtypeInference && isExternal
      ? `External session. Inferred subtype "${subtype}" (${subtypeInference.confidence} confidence: ${subtypeInference.reason})`
      : null),
    athlete_feedback: input.feedbackText || null, // verbatim, for session analysis
    data_quality: signals.data_quality.length ? signals.data_quality : undefined,
    // The prescribed plan (app-generated sessions only) — kept so the block
    // analysis export can compare "what was prescribed" vs "what happened".
    plan: input.planned ?? null,
  };

  // ── Update rolling bests ──
  const rolling_bests = applyNewRecords(cat.rolling_bests ?? {}, detected.new_records, date, id);

  // ── Active flags (with decay) ──
  const { next: active_flags, expiring: expiring_flags } = updateActiveFlags(cat.active_flags, signals.flags, { sessionId: id, date });

  // ── Block tracking ──
  const { tracking: weekly_block_tracking, blockCompleted } = advanceBlockTracking(cat.weekly_block_tracking ?? {}, type, { isExternal });
  // Equipment constraint from feedback (e.g. "rings only").
  if (signals.equipment) {
    weekly_block_tracking[`block_${weekly_block_tracking.current_block_number}_dryland_equipment`] = signals.equipment;
  }

  // Block-based phase progress: a completed block ticks the phase's block
  // counter (phase advancement is evaluated below).
  let training_phase = { ...(cat.training_phase ?? {}) };
  if (blockCompleted) {
    training_phase.blocks_in_phase = (training_phase.blocks_in_phase ?? 0) + 1;
  }

  // ── Pending adjustments for the NEXT generation (consumed then cleared) ──
  const pending_adjustments = {
    intensity: signals.intensity,
    volume: signals.volume,
    recovery_tilt: signals.recovery_tilt,
    technique_focus: signals.technique_focus,
    set_on_session_id: id,
  };

  let updated = {
    ...cat,
    rolling_bests,
    active_flags,
    weekly_block_tracking,
    training_phase,
    pending_adjustments,
    sessions: [session, ...(cat.sessions ?? [])],
    coach_notes: {
      ...(cat.coach_notes ?? {}),
      last_updated: date,
    },
  };

  // Block-based phase advancement: once the phase's block quota is met (only
  // possible right after a block completed), advance to the next phase.
  const adv = applyPhaseAdvancement(updated, date);
  updated = adv.catalogue;
  if (adv.advanced) {
    session.coach_flags = [...session.coach_flags, `PHASE ADVANCED: ${adv.check.reason}`];
  }

  return {
    catalogue: updated,
    session,
    flags: session.coach_flags,
    records: detected.new_records,
    signals,
    subtype_inference: subtypeInference,
    expiring_flags, // removal candidates — UI should confirm before clearing
    phase_advancement: adv.advanced ? adv.check : null,
    // A block just rolled over → the UI offers the block-analysis export.
    block_completed: blockCompleted,
    completed_block_number: blockCompleted ? session.block_number : null,
  };
}

function emptyResolved() {
  return { flags: [], intensity: 'normal', volume: 'normal', recovery_tilt: false, equipment: null, technique_focus: [], data_quality: [], context_notes: [] };
}
