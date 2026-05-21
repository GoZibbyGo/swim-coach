// Session classifier — infers the subtype of an externally-generated pool
// session from its parsed structure, so logging a squad/coach/self-made
// session still produces a subtype for anti-repetition and record-keeping.
//
// Per the agreed UX: infer, then let the athlete confirm/override. The
// `confidence` field signals how strongly to prompt — low confidence should
// always ask.
//
// Heuristics (deterministic, from the structure the Garmin parser already
// extracts):
//   - drill-heavy            → technique
//   - several long reps      → threshold
//   - many short max reps    → sprint
//   - several 50m race reps  → race_pace
//   - otherwise              → mixed (low confidence)

const LONG_REP_M = 150;          // ≥150m reps indicate threshold/aerobic work
const SPRINT_MAX_S = 20;         // a single length under 20s is a max effort
const RACE_50_LENGTH_S = 22;     // each length of a race-pace 50 runs ≤ ~22s
const DRILL_PROPORTION = 0.35;   // ≥35% drill lengths → technique focus

function nonRest(intervals) {
  return (intervals ?? []).filter(i => !i.is_rest);
}

function isDrillInterval(i) {
  return String(i?.stroke ?? '').trim().toLowerCase() === 'drill';
}

/**
 * @param {object} parsed - output of parseGarminCsv
 * @returns {{ subtype: string, confidence: 'high'|'medium'|'low', reason: string }}
 */
export function inferPoolSubtype(parsed) {
  const intervals = nonRest(parsed?.intervals);
  const lengths = parsed?.lengths ?? [];
  const totalLengths = lengths.length;

  if (intervals.length === 0 || totalLengths === 0) {
    return { subtype: 'mixed', confidence: 'low', reason: 'No usable intervals to classify.' };
  }

  const drillLengths = lengths.filter(l => l.is_drill).length;
  const drillProportion = drillLengths / totalLengths;

  const longReps = intervals.filter(i => (i.distance_m ?? 0) >= LONG_REP_M).length;

  const sprintReps = intervals.filter(i =>
    !isDrillInterval(i) &&
    i.lengths.length === 1 &&
    i.lengths[0]?.is_freestyle &&
    i.time_s != null && i.time_s <= SPRINT_MAX_S
  ).length;

  const raceReps = intervals.filter(i =>
    !isDrillInterval(i) &&
    i.lengths.length === 2 &&
    i.lengths.every(l => l.is_freestyle && l.time_s != null && l.time_s <= RACE_50_LENGTH_S)
  ).length;

  // Ordered classification — most distinctive signals first.
  if (drillProportion >= DRILL_PROPORTION) {
    return {
      subtype: 'technique',
      confidence: drillProportion >= 0.5 ? 'high' : 'medium',
      reason: `${Math.round(drillProportion * 100)}% of lengths were drills.`,
    };
  }
  if (longReps >= 3) {
    return {
      subtype: 'threshold',
      confidence: longReps >= 4 ? 'high' : 'medium',
      reason: `${longReps} reps of ≥${LONG_REP_M}m (sustained efforts).`,
    };
  }
  if (sprintReps >= 6) {
    return {
      subtype: 'sprint',
      confidence: sprintReps >= 8 ? 'high' : 'medium',
      reason: `${sprintReps} single-length max efforts ≤${SPRINT_MAX_S}s.`,
    };
  }
  if (raceReps >= 4) {
    return {
      subtype: 'race_pace',
      confidence: 'medium',
      reason: `${raceReps} fast 50m reps (race-pace pattern).`,
    };
  }
  // Some sprint presence but not dominant.
  if (sprintReps >= 3) {
    return {
      subtype: 'sprint',
      confidence: 'low',
      reason: `${sprintReps} short max efforts, but no clearly dominant set type — confirm.`,
    };
  }
  return {
    subtype: 'mixed',
    confidence: 'low',
    reason: 'No dominant set type detected — please confirm the subtype.',
  };
}
