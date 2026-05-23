// Flag-detection engine.
//
// Generates coach_flags from parsed Garmin CSV data using deterministic rules
// (ports STEP 5 of SKILL_session_logger.md). No LLM involved — every flag is
// the output of an explicit comparison or pattern check, so the *findings*
// are always reproducible. An LLM may later wrap these in prose, but it never
// invents a finding.
//
// Two flag families:
//   1. Records — compare session metrics against rolling_bests (PRs).
//   2. Technical — pattern checks within the session (drift, gaps, HR, glitches).
//
// Structure-dependent checks (cool-down HR, first-length gap) use heuristics
// when no session plan is supplied, and become exact when one is. For now we
// rely on heuristics; the optional `opts.plan` hook is reserved for later.

import { paceToSeconds } from './targets.js';

// ──────────────────────────────────────────────────────────────────────────
// Small helpers
// ──────────────────────────────────────────────────────────────────────────

function isDrillInterval(i) {
  return String(i?.stroke ?? '').trim().toLowerCase() === 'drill';
}

function swimmingIntervals(intervals) {
  return intervals.filter(i => !i.is_rest);
}

function avg(arr) {
  const clean = arr.filter(v => v != null && Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

// Single-length max-effort reps (sprint protocol): one freestyle length,
// fast, not a drill.
function sprintReps(intervals) {
  return intervals.filter(i =>
    !i.is_rest &&
    !isDrillInterval(i) &&
    i.lengths.length === 1 &&
    i.lengths[0]?.is_freestyle &&
    i.time_s != null && i.time_s <= 20
  );
}

// 50m reps for first-length-gap analysis: exactly two freestyle, non-drill
// lengths.
function fiftyReps(intervals) {
  return intervals.filter(i =>
    !i.is_rest &&
    !isDrillInterval(i) &&
    i.lengths.length === 2 &&
    i.lengths.every(l => l.is_freestyle && !l.is_drill)
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Record detection (PRs)
// ──────────────────────────────────────────────────────────────────────────

export function detectRecords(parsed, rollingBests = {}) {
  const flags = [];
  const newRecords = {};
  const s = parsed.summary ?? {};

  // ── Best 25m ──
  // Compare against the sprint-protocol best first (clean sprint conditions),
  // then the raw all-time best. Lower is better.
  const best25 = s.best_25m_split_s;
  if (best25 != null) {
    const protoBest = rollingBests.best_25m_sprint_protocol_s;
    const rawBest = rollingBests.best_25m_split_s;
    if (protoBest == null || best25 < protoBest) {
      flags.push(`NEW SPRINT PROTOCOL BEST: ${best25}s (${s.best_25m_context ?? 'clean sprint'})${protoBest != null ? ` — previous ${protoBest}s` : ''}.`);
      newRecords.best_25m_sprint_protocol_s = best25;
    } else if (best25 === protoBest) {
      flags.push(`Sprint protocol best matched: ${best25}s (${s.best_25m_context ?? ''}).`);
    }
    if (rawBest == null || best25 < rawBest) {
      flags.push(`NEW 25M BEST (raw): ${best25}s — previous ${rawBest ?? 'n/a'}s.`);
      newRecords.best_25m_split_s = best25;
    }
  }

  // ── Session avg SWOLF ──
  if (s.avg_swolf != null) {
    const prev = rollingBests.best_avg_swolf;
    if (prev == null || s.avg_swolf < prev) {
      flags.push(`NEW SESSION SWOLF BEST: ${s.avg_swolf} avg${prev != null ? ` (previous ${prev})` : ''}.`);
      newRecords.best_avg_swolf = s.avg_swolf;
    }
  }

  // ── Sprint SWOLF (min SWOLF among sprint reps) ──
  const reps = sprintReps(parsed.intervals ?? []);
  const sprintSwolfs = reps.map(r => r.swolf).filter(v => v != null && v > 0);
  if (sprintSwolfs.length) {
    const bestSprintSwolf = Math.min(...sprintSwolfs);
    const prev = rollingBests.best_sprint_swolf;
    if (prev == null || bestSprintSwolf < prev) {
      flags.push(`NEW SPRINT SWOLF BEST: ${bestSprintSwolf}${prev != null ? ` (previous ${prev})` : ''}.`);
      newRecords.best_sprint_swolf = bestSprintSwolf;
    } else if (bestSprintSwolf === prev) {
      flags.push(`Sprint SWOLF best matched: ${bestSprintSwolf}.`);
    }
  }

  // ── Avg pace per 100m ──
  if (s.avg_pace_per_100m != null) {
    const prevStr = rollingBests.best_avg_pace_per_100m;
    const cur = paceToSeconds(s.avg_pace_per_100m);
    const prev = prevStr ? paceToSeconds(prevStr) : null;
    if (cur != null && (prev == null || cur < prev)) {
      flags.push(`NEW AVG PACE BEST: ${s.avg_pace_per_100m}/100m${prevStr ? ` (previous ${prevStr})` : ''}.`);
      newRecords.best_avg_pace_per_100m = s.avg_pace_per_100m;
    }
  }

  return { flags, newRecords };
}

// ──────────────────────────────────────────────────────────────────────────
// Technical / pattern detection
// ──────────────────────────────────────────────────────────────────────────

export function detectTechnical(parsed, opts = {}) {
  const flags = [];
  const intervals = parsed.intervals ?? [];
  const lengths = parsed.lengths ?? [];

  // ── Stroke drift: first third vs last third of freestyle, non-drill lengths.
  const effortLengths = lengths.filter(l => l.is_freestyle && !l.is_drill && l.strokes != null && l.strokes > 0);
  if (effortLengths.length >= 6) {
    const third = Math.floor(effortLengths.length / 3);
    const early = avg(effortLengths.slice(0, third).map(l => l.strokes));
    const late = avg(effortLengths.slice(-third).map(l => l.strokes));
    if (early != null && late != null && late - early >= 1) {
      flags.push(`Stroke drift detected: ${round1(early)} early → ${round1(late)} late (${round1(late - early)} more strokes/length under fatigue).`);
    }
  }

  // ── First-length gap (push-off / wall): compare each rep's first length to
  // its second, across ALL multi-length freestyle reps — 50s, 100s, 200s, any
  // subtype — not just 50m reps. The fallback feedback path relies entirely on
  // engine flags, so this must fire whenever the pattern is in the data.
  const multiLen = intervals.filter(i =>
    !i.is_rest && !isDrillInterval(i) &&
    (i.lengths?.length ?? 0) >= 2 &&
    i.lengths[0]?.is_freestyle && !i.lengths[0]?.is_drill && i.lengths[0]?.time_s != null &&
    i.lengths[1]?.is_freestyle && !i.lengths[1]?.is_drill && i.lengths[1]?.time_s != null);
  if (multiLen.length >= 2) {
    const l1 = avg(multiLen.map(i => i.lengths[0].time_s));
    const l2 = avg(multiLen.map(i => i.lengths[1].time_s));
    if (l1 != null && l2 != null) {
      const gap = round1(l1 - l2);
      if (gap >= 0.5) {
        flags.push(`First-length gap: L1 avg ${round1(l1)}s vs L2 avg ${round1(l2)}s (${gap}s slower off the wall) across ${multiLen.length} reps — wall push-off is the gap.`);
      }
    }
  }

  // ── Cool-down HR: heuristic = last swimming interval.
  const swim = swimmingIntervals(intervals);
  if (swim.length) {
    const last = swim[swim.length - 1];
    if (last.max_hr != null && last.max_hr > 150) {
      flags.push(`Cool-down HR elevated: max ${last.max_hr} bpm (INT ${last.interval_number}) — CO2 tolerance still lagging.`);
    }
  }

  // ── Sprint-quality markers (from KB research): consistency, velocity fade,
  // and rest adherence across single-length max-effort reps.
  const reps = sprintReps(intervals);
  if (reps.length >= 3) {
    const times = reps.map(r => r.time_s).filter(t => t != null);
    if (times.length >= 3) {
      const spread = round1(Math.max(...times) - Math.min(...times));
      if (spread >= 1.5) {
        flags.push(`Sprint pacing inconsistent: ${spread}s spread across ${times.length} max reps (fastest ${Math.min(...times)}s, slowest ${Math.max(...times)}s).`);
      }
      const fade = round1(times[times.length - 1] - times[0]);
      if (fade >= 1.0) {
        flags.push(`Velocity fade: last sprint rep ${fade}s slower than the first (${times[0]}s → ${times[times.length - 1]}s) — fatigue or rest too short.`);
      }
    }
    // Rest adherence — alactic quality and (for Julian) quad protection.
    const shortRest = reps.filter(r => r.rest_after_s != null && r.rest_after_s < 120);
    if (shortRest.length) {
      const detail = shortRest.map(r => `INT ${r.interval_number} (${Math.round(r.rest_after_s)}s)`).join(', ');
      flags.push(`Sprint rest too short on ${shortRest.length} rep(s): ${detail} — max efforts need ≥120s. Short rest blunts speed adaptation and removes quad protection.`);
    }
  }

  // ── DPS / stroke-rate snapshot (informational, from the parser summary).
  const s = parsed.summary ?? {};
  if (s.avg_dps_m != null && s.avg_stroke_rate_spm != null) {
    flags.push(`Efficiency: avg ${s.avg_dps_m} m/stroke at ${s.avg_stroke_rate_spm} strokes/min (DPS is the dominant 50m speed lever).`);
  }

  // ── Glitch summary from the parser.
  for (const g of parsed.glitches ?? []) {
    flags.push(`Garmin glitch: INT ${g.interval}${g.length != null ? '.' + g.length : ''} (${g.kind}) — ${g.detail}.`);
  }

  return { flags };
}

// ──────────────────────────────────────────────────────────────────────────
// Combined entry point
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {object} parsed   - output of parseGarminCsv
 * @param {object} catalogue
 * @param {object} [opts]    - { subtype, plan }
 * @returns {{ flags: string[], new_records: object }}
 */
export function detectFlags(parsed, catalogue, opts = {}) {
  const rollingBests = catalogue?.rolling_bests ?? {};
  const rec = detectRecords(parsed, rollingBests);
  const tech = detectTechnical(parsed, opts);
  return {
    flags: [...rec.flags, ...tech.flags],
    new_records: rec.newRecords,
  };
}

export { sprintReps, fiftyReps };
