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

  // ── Best 50m (fastest actual 50m rep this session — any context) ──
  const best50 = s.best_50m_split_s;
  if (best50 != null) {
    const prev50 = rollingBests.best_50m_equiv_s;
    if (prev50 == null || best50 < prev50) {
      flags.push(`NEW 50M BEST: ${best50}s${prev50 != null ? ` — previous ${prev50}s` : ''} (${s.best_50m_context ?? 'fastest 50m rep'}).`);
      newRecords.best_50m_equiv_s = best50;
    }
  }

  // ── Best 100m (fastest actual 100m rep this session — any context) ──
  const best100 = s.best_100m_split_s;
  if (best100 != null) {
    const prev100 = rollingBests.best_100m_split_s;
    if (prev100 == null || best100 < prev100) {
      flags.push(`NEW 100M BEST: ${best100}s${prev100 != null ? ` — previous ${prev100}s` : ''} (${s.best_100m_context ?? 'fastest 100m rep'}).`);
      newRecords.best_100m_split_s = best100;
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

  // ── Best threshold pace (fastest sustained same-distance set, ≥3 reps, avg rest ≤60s) ──
  if (s.best_threshold_pace_per_100m != null) {
    const prevStr = rollingBests.best_threshold_pace_per_100m;
    const cur = paceToSeconds(s.best_threshold_pace_per_100m);
    const prev = prevStr ? paceToSeconds(prevStr) : null;
    if (cur != null && (prev == null || cur < prev)) {
      flags.push(`NEW THRESHOLD PACE BEST: ${s.best_threshold_pace_per_100m}/100m${prevStr ? ` (previous ${prevStr})` : ''}.`);
      newRecords.best_threshold_pace_per_100m = s.best_threshold_pace_per_100m;
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

  // ── Cool-down HR: scan the final ~3 swimming intervals (typical cool-down
  // length — covers 8×25 every-5 OR 4×50 / 20s rest). Threshold lowered from
  // 150 → 140 because cool-down work should be RPE ≤3 / easy and 140+ bpm at
  // easy pace is the same CO2-tolerance signal we flag elsewhere.
  const COOL_DOWN_LOOKBACK = 3;
  const COOL_DOWN_HR_THRESHOLD = 140;
  const swim = swimmingIntervals(intervals);
  if (swim.length) {
    const tail = swim.slice(-COOL_DOWN_LOOKBACK);
    const elevated = tail.filter(i => i.max_hr != null && i.max_hr >= COOL_DOWN_HR_THRESHOLD);
    if (elevated.length) {
      const peak = elevated.reduce((a, b) => (a.max_hr >= b.max_hr ? a : b));
      const ratio = `${elevated.length}/${tail.length}`;
      flags.push(`Cool-down HR elevated: peak ${peak.max_hr} bpm at INT ${peak.interval_number} (${ratio} of the closing intervals ≥${COOL_DOWN_HR_THRESHOLD}) — CO2 tolerance still lagging.`);
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

// ──────────────────────────────────────────────────────────────────────────
// Dryland data-quality
// ──────────────────────────────────────────────────────────────────────────

// Spot likely logging typos in dryland rep counts — a single set whose rep
// count is way higher than its peers (e.g. "10 / 18 / 10") is almost always
// a fat-fingered "18" instead of "10". Flag it before it enters the rolling
// baseline. Conservative: requires both a 1.5× ratio AND ≥5 absolute reps,
// and at least 3 sets to compare against.
export function detectDrylandIssues(dryland) {
  const flags = [];
  if (!dryland || !Array.isArray(dryland.exercises)) return flags;
  for (const ex of dryland.exercises) {
    const reps = Array.isArray(ex.reps_per_set)
      ? ex.reps_per_set.filter(n => typeof n === 'number' && n > 0)
      : [];
    if (reps.length < 3) continue;
    const sorted = [...reps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const max = Math.max(...reps);
    if (max > median * 1.5 && max - median >= 5) {
      flags.push(`Dryland data check: ${ex.name ?? '(unnamed)'} has a high outlier (${max} vs median ${median} across ${reps.length} sets) — likely a logging typo.`);
    }
  }
  return flags;
}

// ──────────────────────────────────────────────────────────────────────────
// Plan deviation
// ──────────────────────────────────────────────────────────────────────────

// Compare what was actually swum against the prescribed plan and flag
// structural deviations — total volume cut/added, and per-block rep/distance
// mismatches (catches the "swapped cool-down to 4×50" pattern). Heuristic:
// walks the plan's blocks in order, greedily consumes actual intervals up to
// each block's volume, and compares counts × distance.
export function detectPlanDeviations(plan, breakdown) {
  const flags = [];
  if (!plan || !Array.isArray(plan.blocks) || !Array.isArray(breakdown) || !breakdown.length) return flags;

  const plannedVol = plan.total_volume_m
    || plan.blocks.reduce((s, b) => s + (Number(b.volume_m) || 0), 0);
  const actualVol = breakdown.reduce((s, b) => s + (Number(b.distance_m) || 0), 0);
  if (plannedVol > 0 && Math.abs(actualVol - plannedVol) / plannedVol > 0.10) {
    const diff = actualVol - plannedVol;
    flags.push(`Plan deviation: total volume ${actualVol}m vs prescribed ${plannedVol}m (${diff > 0 ? '+' : '−'}${Math.abs(diff)}m).`);
  }

  // Per-block walk.
  let idx = 0;
  for (const block of plan.blocks) {
    const sets = Array.isArray(block.sets) ? block.sets : [];
    const expectedReps = sets.reduce((s, x) => s + (Number(x.reps) || 1), 0);
    const expectedDist = sets.find(x => x.distance_m != null)?.distance_m ?? null;
    const blockVol = sets.reduce((s, x) => s + (Number(x.reps) || 1) * (Number(x.distance_m) || 0), 0)
      || Number(block.volume_m) || 0;
    if (!expectedReps || !expectedDist || blockVol === 0 || idx >= breakdown.length) continue;
    let consumed = 0;
    let count = 0;
    let firstDist = null;
    while (idx < breakdown.length && consumed < blockVol * 0.9) {
      const iv = breakdown[idx];
      if (firstDist == null) firstDist = Number(iv.distance_m) || null;
      consumed += Number(iv.distance_m) || 0;
      count++;
      idx++;
    }
    if (!count) continue;
    const repsMismatch = Math.abs(count - expectedReps) >= 2;
    const distMismatch = firstDist != null && firstDist !== expectedDist;
    if (repsMismatch || distMismatch) {
      flags.push(`Plan deviation: ${block.name ?? '(block)'} — prescribed ${expectedReps}×${expectedDist}m, actual ${count}×${firstDist ?? '?'}m.`);
    }
  }
  return flags;
}

export { sprintReps, fiftyReps };
