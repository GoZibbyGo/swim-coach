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

// Single-length MAX-EFFORT reps (sprint protocol): one freestyle length,
// fast, not a drill. Round-5 refinement: gate on INTENSITY, not just rest.
// Rest alone is a bad classifier — the pre-existing "16.8s reps at 60s rest"
// is exactly the max-effort/under-rested case we WANT to flag; but 20s reps
// at 60s rest are speed-technique, not max_alactic, and must be excluded.
//
// Discriminator: use the session's fastest single-length freestyle rep as the
// intra-session anchor. If it's ≤17.0s (near the Phase-1 best_25m range),
// treat this as a max-alactic set and include every rep within 1.5s of the
// anchor. If the fastest rep is >17.0s, the whole set is sub-max — no rep is
// max_alactic, and quality-check flags (fade / spread / rest) don't apply.
// Fallback: if no fast rep exists, no reps qualify.
const MAX_ALACTIC_TIME_CAP_S = 17.0;   // absolute intensity ceiling
function sprintReps(intervals, planTags = null) {
  // When the plan tagged its sets, the TAG is authoritative — the heuristic
  // below is only for untagged/external sessions.
  //
  // Without this the analyser re-derived "max effort" from time alone and swept
  // in build-to-max finish reps: a Sprint Finish tagged `build_finish` at 60s
  // prescribed rest was flagged "max efforts need ≥120s" when the athlete had
  // taken 70s — MORE than prescribed — and its 19.6s reps inflated a "2.8s
  // spread across 8 max reps" when the real max set spanned 1.2s.
  if (planTags instanceof Map && planTags.size) {
    const tagged = intervals.filter(i => {
      const t = planTags.get(i.interval_number);
      return t?.rep_class != null;
    });
    if (tagged.length) {
      return tagged.filter(i =>
        !i.is_rest && !isDrillInterval(i) &&
        planTags.get(i.interval_number).rep_class === 'max_alactic');
    }
  }

  const candidates = intervals.filter(i =>
    !i.is_rest &&
    !isDrillInterval(i) &&
    i.lengths.length === 1 &&
    i.lengths[0]?.is_freestyle &&
    i.time_s != null && i.time_s <= 20
  );
  if (!candidates.length) return [];
  // Anchor on the FASTEST single-length freestyle rep in the session. If even
  // the fastest is >17s, the whole set is sub-max (speed-technique / build) —
  // no rep is max_alactic, so the quality-check flags (fade / spread / rest)
  // don't apply. Otherwise keep every candidate: a slow rep INSIDE a max set
  // is the fade we want to surface.
  const anchor = Math.min(...candidates.map(c => c.time_s));
  if (anchor > MAX_ALACTIC_TIME_CAP_S) return [];
  return candidates;
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
// Plan tags — map each ACTUAL interval to the plan block it fell inside, so
// downstream flag detection knows which reps were pull-buoy / paddles / drill
// (and therefore not PR-eligible). Greedy walk: for each plan block, consume
// actual intervals up to that block's volume, tag each with the block's
// equipment / rep_class.
// ──────────────────────────────────────────────────────────────────────────

// Shared greedy walk: assign ACTUAL intervals to plan blocks in order, each
// block consuming intervals until it reaches ~its prescribed volume. Returns
// one entry per plan block (with an empty interval list once the actual data
// runs out). Both buildPlanTags and buildPlanReconciliation ride on this so
// the two can never disagree about which rep belonged to which block.
// A block's prescribed per-rep distance sequence: 4×100 + 4×25 →
// [100,100,100,100,25,25,25,25].
function expectedDistances(sets) {
  const out = [];
  for (const s of sets ?? []) {
    const reps = Math.max(1, Number(s?.reps) || 1);
    const dist = Number(s?.distance_m) || 0;
    if (dist > 0) for (let i = 0; i < reps; i++) out.push(dist);
  }
  return out;
}

// The SET each expected rep came from, parallel to expectedDistances(). Lets a
// matched interval inherit its own set's rep_class / prescribed rest, rather
// than a single block-level guess — a Sprint Finish block can hold both
// build_finish and max_alactic sets.
function expectedSets(sets) {
  const out = [];
  for (const s of sets ?? []) {
    const reps = Math.max(1, Number(s?.reps) || 1);
    const dist = Number(s?.distance_m) || 0;
    if (dist > 0) for (let i = 0; i < reps; i++) out.push(s);
  }
  return out;
}

function walkPlanBlocks(plan, breakdown) {
  const out = [];
  if (!plan || !Array.isArray(plan.blocks) || !Array.isArray(breakdown)) return out;
  const blocks = plan.blocks;
  let idx = 0;

  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    const sets = Array.isArray(block.sets) ? block.sets : [];
    const expected = expectedDistances(sets);
    const expSets = expectedSets(sets);
    const blockVol = expected.reduce((a, d) => a + d, 0) || Number(block.volume_m) || 0;
    const intervals = [];
    const setForInterval = new Map();   // interval n → the planned set it matched
    let consumed = 0;
    let missedReps = 0;

    if (expected.length) {
      // Match on the DISTANCE SEQUENCE, not cumulative volume.
      //
      // This used to consume while `consumed < blockVol * 0.9`, which silently
      // truncated any block whose last reps were short: a 500m warm-up written
      // as 4×100 + 4×25 stopped at 450m, so its final 2×25 spilled into the
      // next block and every later boundary shifted with them. The athlete saw
      // "warm-up 450m" for a 500m warm-up, a primer reported as "2×25 + 3×50"
      // that was really 4×50, and main sets that looked reordered. The table
      // still said "swum as prescribed", so it was confidently wrong and the
      // debrief narrated the corruption as fact.
      let e = 0;
      while (idx < breakdown.length && e < expected.length) {
        const actual = Number(breakdown[idx].distance_m) || 0;
        if (actual === expected[e]) {
          setForInterval.set(breakdown[idx].n, expSets[e]);
          intervals.push(breakdown[idx]); consumed += actual; idx++; e++;
          continue;
        }
        // Not the next prescribed distance. If this distance appears LATER in
        // the same block, the athlete skipped some reps — jump to it. If it
        // appears nowhere in the remainder, this interval belongs to the next
        // block and this one is finished.
        const j = expected.indexOf(actual, e + 1);
        if (j === -1) break;
        missedReps += j - e;
        e = j;
        setForInterval.set(breakdown[idx].n, expSets[e]);
        intervals.push(breakdown[idx]); consumed += actual; idx++; e++;
      }
      missedReps += Math.max(0, expected.length - e);

      // Extra reps beyond the prescription (athlete added a few). Absorb them
      // only when the NEXT block expects a different distance — otherwise we
      // could steal its opening reps, which is the same cascade in reverse.
      const lastDist = expected[expected.length - 1];
      const nextExpected = expectedDistances(
        Array.isArray(blocks[b + 1]?.sets) ? blocks[b + 1].sets : []);
      const nextFirst = nextExpected.length ? nextExpected[0] : null;
      if (e >= expected.length && nextFirst !== lastDist) {
        while (idx < breakdown.length && (Number(breakdown[idx].distance_m) || 0) === lastDist) {
          setForInterval.set(breakdown[idx].n, expSets[expSets.length - 1]);
          intervals.push(breakdown[idx]); consumed += lastDist; idx++;
        }
      }
    } else if (blockVol > 0) {
      // Volume-only block (no per-set detail): fall back to filling by volume,
      // but never past the prescription.
      while (idx < breakdown.length
        && consumed + (Number(breakdown[idx].distance_m) || 0) <= blockVol) {
        consumed += Number(breakdown[idx].distance_m) || 0;
        intervals.push(breakdown[idx]);
        idx++;
      }
    }

    out.push({
      block, sets, blockVol, intervals, actual_m: consumed, setForInterval,
      expected_reps: expected.length, missed_reps: missedReps,
    });
  }

  // Intervals that matched no block — e.g. the athlete swapped a prescribed
  // 8×25 cool-down for 4×50, so nothing fits the 25m pattern. Strict matching
  // must not silently DROP them (that loses real swimming from the debrief) and
  // must not guess them into a block either (that is the cascade we just fixed).
  // Report them as their own row instead.
  if (idx < breakdown.length) {
    const rest = breakdown.slice(idx);
    out.push({
      block: { name: 'Unmatched' }, sets: [], blockVol: 0, setForInterval: new Map(),
      intervals: rest,
      actual_m: rest.reduce((s, iv) => s + (Number(iv.distance_m) || 0), 0),
      expected_reps: 0, missed_reps: 0, unmatched: true,
    });
  }
  return out;
}

export function buildPlanTags(plan, breakdown) {
  const tags = new Map();
  if (!Array.isArray(breakdown) || !breakdown.length) return tags;
  for (const { block, sets, intervals, setForInterval } of walkPlanBlocks(plan, breakdown)) {
    // Per-SET tags where the sequence matcher identified the exact set, falling
    // back to the block's first tagged set. Precision matters here: a Sprint
    // Finish block can hold a build_finish set at 60s rest next to a max_alactic
    // set at 120s, and tagging both with one block-level guess is what let the
    // analyser flag a build rep for "max efforts need ≥120s" when the athlete
    // had actually taken MORE rest than prescribed.
    const blockEquip = sets.find(x => x && x.equipment)?.equipment ?? null;
    const blockClass = sets.find(x => x && x.rep_class)?.rep_class ?? null;
    for (const iv of intervals) {
      const set = setForInterval?.get(iv.n) ?? null;
      tags.set(iv.n, {
        equipment: set?.equipment ?? blockEquip,
        rep_class: set?.rep_class ?? blockClass,
        prescribed_rest_s: set?.rest_s ?? null,
        effort: set?.effort ?? null,
        block_name: block.name ?? null,
      });
    }
  }
  return tags;
}

// ──────────────────────────────────────────────────────────────────────────
// Plan ↔ actual reconciliation.
//
// The feedback LLM used to receive only a FLAT list of intervals plus an
// instruction to "go block by block" — so it had to infer where the warm-up
// ended and the main set began, and it inferred wrong, producing "you did X
// but the plan said Y" complaints about sessions the athlete swam correctly.
// This computes the mapping deterministically so the LLM never has to.
// ──────────────────────────────────────────────────────────────────────────

export function buildPlanReconciliation(plan, breakdown) {
  const rows = [];
  if (!plan || !Array.isArray(plan.blocks) || !Array.isArray(breakdown) || !breakdown.length) {
    return { rows, text: '' };
  }
  for (const { block, sets, blockVol, intervals, actual_m, expected_reps, missed_reps, unmatched } of walkPlanBlocks(plan, breakdown)) {
    const prescribed = sets.length
      ? sets.map(s => `${Number(s.reps) || 1}×${Number(s.distance_m) || 0}m`
          + `${s.effort ? ` ${s.effort}` : ''}`
          + `${s.rest_s != null ? ` @${s.rest_s}s` : ''}`).join(' + ')
      : `${blockVol}m`;
    const ns = intervals.map(i => i.n);
    const intRange = ns.length
      ? (ns.length === 1 ? `INT ${ns[0]}` : `INT ${ns[0]}–${ns[ns.length - 1]}`)
      : '—';
    // Group the actual reps by distance so the line reads like a set, not a list.
    const counts = new Map();
    for (const iv of intervals) {
      const d = Number(iv.distance_m) || 0;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const actualDesc = counts.size
      ? [...counts.entries()].map(([d, c]) => `${c}×${d}m`).join(' + ')
      : 'nothing recorded';
    const delta = actual_m - blockVol;
    // "As prescribed" now requires the REPS to line up, not just the metres.
    // Volume alone let a mis-bounded block report a correct-looking total while
    // holding the wrong reps — the failure the athlete caught.
    const repsMatch = expected_reps > 0
      ? (intervals.length === expected_reps && missed_reps === 0)
      : Math.abs(delta) <= Math.max(25, blockVol * 0.1);
    const status = unmatched
      ? '⚠ swum but matches no prescribed block (swapped or added work)'
      : !ns.length ? '⚠ prescribed but no matching reps recorded'
      : (repsMatch && delta === 0) ? '✓ swum as prescribed'
      : repsMatch ? `✓ all reps present (${delta > 0 ? '+' : '−'}${Math.abs(delta)}m vs plan)`
      : `⚠ ${intervals.length}/${expected_reps} prescribed reps matched${delta ? `, ${delta > 0 ? '+' : '−'}${Math.abs(delta)}m` : ''}`;
    rows.push({
      block_name: block.name ?? '(block)', prescribed, prescribed_m: blockVol,
      interval_range: intRange, actual: actualDesc, actual_m, status,
    });
  }
  const text = rows.map(r =>
    `- ${r.block_name}: prescribed ${r.prescribed} (${r.prescribed_m}m) → ${r.interval_range}, actually swam ${r.actual} (${r.actual_m}m) — ${r.status}`
  ).join('\n');

  // Honesty caveat. Intervals are assigned to blocks by matching the prescribed
  // distance sequence, so where two ADJACENT blocks use the same rep distance
  // (e.g. a 4×50 primer straight into an 8×50 main set) the boundary between
  // them is inferred, not measured — if reps were skipped there, the split
  // between those two blocks may be off even though the totals reconcile.
  // Say so once rather than letting the debrief assert a false certainty.
  const ambiguous = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = expectedDistances(plan.blocks[i]?.sets);
    const b2 = expectedDistances(plan.blocks[i + 1]?.sets);
    if (a.length && b2.length && a[a.length - 1] === b2[0]) {
      ambiguous.push(`${rows[i].block_name} → ${rows[i + 1].block_name}`);
    }
  }
  const caveat = ambiguous.length
    ? `\n(Boundary inferred where consecutive blocks share a rep distance: ${ambiguous.join('; ')}. `
      + 'Totals are reliable; the exact split between those blocks is not — do not assert reps were moved between them.)'
    : '';
  return { rows, text: text + caveat };
}

// Given a "INT 33.1" or "INT 22" style context and a Map of plan tags,
// return true if the referenced interval was in an equipment-assisted block.
function contextIsAssisted(context, planTags) {
  if (!(planTags instanceof Map) || !planTags.size) return false;
  if (typeof context !== 'string') return false;
  const m = context.match(/INT\s+(\d+)/i);
  if (!m) return false;
  const tag = planTags.get(Number(m[1]));
  return tag != null && tag.equipment != null;
}

// ──────────────────────────────────────────────────────────────────────────
// Record detection (PRs)
// ──────────────────────────────────────────────────────────────────────────

export function detectRecords(parsed, rollingBests = {}, opts = {}) {
  const flags = [];
  const newRecords = {};
  const s = parsed.summary ?? {};
  // Round-5 feedback: never write an equipment-assisted rep into rolling bests
  // (a 4×100 pull-buoy set wrote 88.8s into best_100m_split_s in Session 32,
  // permanently superseding the previous unassisted 89.9s). If the plan is
  // present and the best's context sits inside an equipment block, skip the
  // PR write and add a note.
  const planTags = opts.planTags instanceof Map ? opts.planTags : new Map();
  const assistedNote = (context, planTagsMap) => {
    const m = String(context ?? '').match(/INT\s+(\d+)/i);
    if (!m) return '(assisted rep — equipment noted in plan)';
    const tag = planTagsMap.get(Number(m[1]));
    const eq = tag?.equipment ? ` — ${tag.equipment}` : '';
    return `(assisted rep${eq}; not written to rolling bests)`;
  };

  // ── Best 25m ──
  const best25 = s.best_25m_split_s;
  if (best25 != null) {
    const protoBest = rollingBests.best_25m_sprint_protocol_s;
    const rawBest = rollingBests.best_25m_split_s;
    if (contextIsAssisted(s.best_25m_context, planTags)) {
      flags.push(`Fast 25m NOT written as PR ${assistedNote(s.best_25m_context, planTags)}: ${best25}s.`);
    } else {
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
  }

  // ── Best 50m (fastest actual 50m rep this session — any context) ──
  const best50 = s.best_50m_split_s;
  if (best50 != null) {
    const prev50 = rollingBests.best_50m_equiv_s;
    if (contextIsAssisted(s.best_50m_context, planTags)) {
      flags.push(`Fast 50m NOT written as PR ${assistedNote(s.best_50m_context, planTags)}: ${best50}s.`);
    } else if (prev50 == null || best50 < prev50) {
      flags.push(`NEW 50M BEST: ${best50}s${prev50 != null ? ` — previous ${prev50}s` : ''} (${s.best_50m_context ?? 'fastest 50m rep'}).`);
      newRecords.best_50m_equiv_s = best50;
    }
  }

  // ── Best 100m (fastest actual 100m rep this session — any context) ──
  const best100 = s.best_100m_split_s;
  if (best100 != null) {
    const prev100 = rollingBests.best_100m_split_s;
    if (contextIsAssisted(s.best_100m_context, planTags)) {
      flags.push(`Fast 100m NOT written as PR ${assistedNote(s.best_100m_context, planTags)}: ${best100}s.`);
    } else if (prev100 == null || best100 < prev100) {
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
  // Round-4 feedback: reconcile safety flags with the athlete's own explanation
  // before asserting them. A session the athlete says was cut short means the
  // FINAL rep's short rest is the session-end tail (not a prescription failure)
  // and any velocity fade is likely CO2/nausea driven (not a training-design
  // problem). Both were false-positived in Session 27; the mapper already
  // classifies these — the flag layer just needs to honour it.
  // Round-5: an explicit "watch fell off / tracking stopped" note OR an
  // explicit "I completed the full session" note override any cut_short —
  // the swim happened, the DATA is truncated. Don't fire fade / rest-too-
  // short from a tracking artefact.
  const matchedIds = new Set((opts.signals?.matched ?? []).map(m => m.id));
  const trackingDropout = matchedIds.has('tracking_dropout') || matchedIds.has('session_completed_explicit');
  const cutShort = !trackingDropout
    && (matchedIds.has('cut_short') || matchedIds.has('terminated_injury'));

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

  // ── Turn conversion (formerly "first-length gap").
  //
  // In a 25m pool, L1 of any 50m+ rep is a push start from a DEAD STOP at the
  // wall; L2+ is turn-aided, entered with velocity. L2 being faster is normal
  // PHYSICS, not a defect. The old rule flagged any gap ≥0.5s — but the normal
  // advantage at this athlete's level is ~0.5–1.2s, so it fired on essentially
  // every session with 50m+ reps and trained the athlete to tune the finding
  // out. What's actually coachable is a gap OUTSIDE the normal band:
  //   < 0.4s  → the turn isn't converting momentum (streamline / breakout)
  //   > 1.8s  → L1 is being paced, or L2 is over-glided
  // Inside the band we say NOTHING.
  //
  // Also: group by rep DISTANCE and judge only the dominant group. Averaging a
  // sprint 50's L1/L2 together with an aerobic 100's L1/L2 is the same
  // mixed-rep_class error round 5 fixed elsewhere, and produces a number that
  // describes no actual set.
  const TURN_ADVANTAGE_MIN_S = 0.4;
  const TURN_ADVANTAGE_MAX_S = 1.8;
  const multiLen = intervals.filter(i =>
    !i.is_rest && !isDrillInterval(i) &&
    (i.lengths?.length ?? 0) >= 2 &&
    i.lengths[0]?.is_freestyle && !i.lengths[0]?.is_drill && i.lengths[0]?.time_s != null &&
    i.lengths[1]?.is_freestyle && !i.lengths[1]?.is_drill && i.lengths[1]?.time_s != null);
  if (multiLen.length >= 2) {
    // Dominant distance group: most reps wins; ties break to the SHORTER
    // distance (more likely to be the quality work we care about).
    const byDist = new Map();
    for (const i of multiLen) {
      const d = Number(i.distance_m) || (i.lengths.length * 25);
      if (!byDist.has(d)) byDist.set(d, []);
      byDist.get(d).push(i);
    }
    const [dist, group] = [...byDist.entries()]
      .sort((a, b) => (b[1].length - a[1].length) || (a[0] - b[0]))[0];
    if (group.length >= 2) {
      const l1 = avg(group.map(i => i.lengths[0].time_s));
      const l2 = avg(group.map(i => i.lengths[1].time_s));
      if (l1 != null && l2 != null) {
        const gap = round1(l1 - l2);
        const ctx = `${group.length}×${dist}m (L1 avg ${round1(l1)}s, L2 avg ${round1(l2)}s)`;
        if (gap < TURN_ADVANTAGE_MIN_S) {
          const how = gap <= 0
            ? `L2 is ${round1(Math.abs(gap))}s SLOWER than L1`
            : `L2 is only ${gap}s faster than L1`;
          flags.push(`Turn conversion: across ${ctx}, ${how}. L1 is a dead-stop push start and L2 is turn-aided, so L2 should be ~0.5–1.2s quicker — the turn isn't paying. Tighten the streamline and hold it longer before the breakout.`);
        } else if (gap > TURN_ADVANTAGE_MAX_S) {
          // Disambiguate using the athlete's own standing-start 25m best: L1 of
          // a 50 is the SAME effort as a standalone 25. If L1 is close to that
          // best, the turn/L2 is the outlier; if L1 is far off it, they're
          // pacing the first length instead of attacking it.
          const ssBest = opts.rollingBests?.best_25m_sprint_protocol_s ?? null;
          const detail = (ssBest != null && dist === 50 && l1 - ssBest > 1.5)
            ? `L1 is also ${round1(l1 - ssBest)}s off your standing-start 25m best (${ssBest}s) — you're pacing the first length rather than attacking it.`
            : 'Either the first length is being paced or the breakout off the turn is over-glided.';
          flags.push(`Split imbalance: across ${ctx}, L2 is ${gap}s faster than L1 — beyond the ~0.5–1.2s a turn normally buys. ${detail}`);
        }
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
  const reps = sprintReps(intervals, opts.planTags);
  if (reps.length >= 3) {
    const times = reps.map(r => r.time_s).filter(t => t != null);
    if (times.length >= 3) {
      const spread = round1(Math.max(...times) - Math.min(...times));
      if (spread >= 1.5) {
        flags.push(`Sprint pacing inconsistent: ${spread}s spread across ${times.length} max-effort reps (max_alactic only) (fastest ${Math.min(...times)}s, slowest ${Math.max(...times)}s).`);
      }
      const fade = round1(times[times.length - 1] - times[0]);
      // Skip fade flag when the athlete told us the session was aborted — the
      // slowdown is CO2/nausea (per note), not a training-design problem.
      if (fade >= 1.0 && !cutShort) {
        flags.push(`Velocity fade: last sprint rep ${fade}s slower than the first (${times[0]}s → ${times[times.length - 1]}s) — fatigue or rest too short.`);
      }
    }
    // Rest adherence — alactic quality and (for Julian) quad protection. When
    // the session was cut short, the final rep's rest_after_s is the session-
    // end tail, not a prescription failure — drop it from the check. 10%
    // tolerance band: flag only if rest < 120×0.9 = 108s (a rep at 117s vs
    // 120s prescribed is a rounding-tier difference, not a safety violation).
    const SPRINT_REST_MIN_S = 120;
    const REST_FLAG_TOLERANCE = 0.9;
    const restReps = cutShort ? reps.slice(0, -1) : reps;
    // Never flag a rep whose rest MET OR EXCEEDED what the plan asked for.
    // The athlete cannot be non-compliant with a prescription they beat: INT 28
    // took 70s against a 60s prescription and was told "max efforts need ≥120s".
    const prescribedRest = (r) => {
      const t = opts.planTags instanceof Map ? opts.planTags.get(r.interval_number) : null;
      return t?.prescribed_rest_s != null ? Number(t.prescribed_rest_s) : null;
    };
    const shortRest = restReps.filter(r => {
      if (r.rest_after_s == null) return false;
      const asked = prescribedRest(r);
      if (asked != null) return r.rest_after_s < asked * REST_FLAG_TOLERANCE;
      return r.rest_after_s < SPRINT_REST_MIN_S * REST_FLAG_TOLERANCE;
    });
    if (shortRest.length) {
      // Explicit dedup by interval_number in case the same rep appears twice
      // in any earlier filter step (round-5 feedback: INT 12 shown, INT 8 with
      // an identical rest value not — this makes the list order-stable).
      const seen = new Set();
      const unique = shortRest.filter(r => (seen.has(r.interval_number) ? false : (seen.add(r.interval_number), true)));
      const detail = unique.map(r => `INT ${r.interval_number} (${Math.round(r.rest_after_s)}s)`).join(', ');
      const asked = prescribedRest(unique[0]);
      flags.push(`Sprint rest too short on ${unique.length} max-effort rep(s): ${detail} — ${asked != null ? `the plan prescribed ${asked}s` : `max efforts need ≥${SPRINT_REST_MIN_S}s`}. Short rest blunts speed adaptation and removes quad protection.`);
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
  const rec = detectRecords(parsed, rollingBests, opts);
  // Technical checks need the rolling bests too — the turn-conversion check
  // disambiguates a large split gap against the standing-start 25m best.
  const tech = detectTechnical(parsed, { ...opts, rollingBests });
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
// and at least 3 sets to compare against. Round-5: also compares each
// exercise against a stored baseline (in `dryland_baselines`) and emits PR /
// regression flags — the analyser previously ignored dryland performance
// entirely.
// Canonical key for an exercise name, so "Hollow Body Hold" and
// "hollow-body hold" share one baseline entry.
export function drylandKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Highest value the athlete actually produced this session, and what kind it is.
function sessionBest(ex) {
  const nums = (a) => (Array.isArray(a) ? a.filter(n => typeof n === 'number' && n > 0) : []);
  const reps = nums(ex.reps_per_set);
  const holds = nums(ex.duration_s_per_set);
  const weights = nums(ex.weight_kg_per_set);
  if (holds.length) return { kind: 'hold', value: Math.max(...holds), unit: 's', reps, holds, weights };
  if (reps.length) return { kind: 'reps', value: Math.max(...reps), unit: ' reps', reps, holds, weights };
  return null;
}

// Top of a prescribed range like "3×8-10" / "8-10 reps" / "30-40s".
function prescribedTop(prescription) {
  const m = String(prescription ?? '').match(/(\d+)\s*[-–]\s*(\d+)/);
  return m ? Number(m[2]) : null;
}

/**
 * Dryland analysis. Returns BOTH the coaching flags and the baseline updates to
 * persist — previously it only read `dryland_baselines` and never wrote them,
 * so `updated_session_id` sat at Session 18 while three drylands went by and a
 * hollow-body hold of 30s against a 20s baseline was never recorded.
 *
 * Every logged exercise produces a finding: a PR, a miss, or "first baseline".
 * A dryland session returning no findings at all was a repeat complaint.
 *
 * @returns {{ flags: string[], updates: object }}
 */
export function detectDrylandIssues(dryland, baselines = null) {
  const flags = [];
  const updates = {};
  if (!dryland || !Array.isArray(dryland.exercises)) return { flags, updates };
  const base = baselines ?? {};

  for (const ex of dryland.exercises) {
    const name = ex.name ?? '(unnamed)';
    const best = sessionBest(ex);

    // Outlier / likely-typo check (existing behaviour).
    if (best?.reps.length >= 3) {
      const sorted = [...best.reps].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const max = Math.max(...best.reps);
      if (max > median * 1.5 && max - median >= 5) {
        flags.push(`Dryland data check: ${name} has a high outlier (${max} vs median ${median} across ${best.reps.length} sets) — likely a logging typo.`);
      }
    }
    if (!best) continue;

    const key = `${drylandKey(name)}_best`;
    const stored = Number(base[key]);
    const had = Number.isFinite(stored);

    if (!had) {
      flags.push(`Dryland baseline established: ${name} — ${best.value}${best.unit} (first recorded benchmark).`);
      updates[key] = best.value;
    } else if (best.value > stored) {
      flags.push(`Dryland PR: ${name} — ${best.value}${best.unit} beats the stored ${stored}${best.unit}.`);
      updates[key] = best.value;
    } else if (best.value < stored * 0.8) {
      flags.push(`Dryland regression: ${name} — ${best.value}${best.unit} vs a stored ${stored}${best.unit}. Worth a look at conditions/fatigue.`);
    } else {
      flags.push(`Dryland held: ${name} — ${best.value}${best.unit} against a stored best of ${stored}${best.unit}.`);
    }

    // Cleared the top of the prescribed range → say it should be progressed.
    const top = prescribedTop(ex.prescription);
    if (top != null && best.reps.length && Math.min(...best.reps) >= top) {
      flags.push(`Dryland progression due: ${name} — every set hit or beat the top of the prescribed range (${ex.prescription}). Add load or reps next time.`);
    }
    if (best.weights.length) {
      const wKey = `${drylandKey(name)}_weight_kg`;
      const wStored = Number(base[wKey]);
      const wBest = Math.max(...best.weights);
      if (!Number.isFinite(wStored) || wBest > wStored) updates[wKey] = wBest;
    }
  }

  // Carry-forward items that were never programmed.
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string' && /NOT YET ESTABLISHED/i.test(value)) {
      flags.push(`Dryland carry-forward: ${key.replace(/_/g, ' ')} still marked "NOT YET ESTABLISHED" — programme it in the next dryland.`);
    }
  }

  if (!flags.length && dryland.exercises.length) {
    flags.push('Dryland logged but no per-set values were recorded — enter reps/holds so progress can be tracked.');
  }
  return { flags, updates };
}

// ──────────────────────────────────────────────────────────────────────────
// Plan deviation
// ──────────────────────────────────────────────────────────────────────────

// Compare what was actually swum against the prescribed plan and flag
// structural deviations — total volume cut/added, and per-block rep/distance
// mismatches (catches the "swapped cool-down to 4×50" pattern). Heuristic:
// walks the plan's blocks in order, greedily consumes actual intervals up to
// each block's volume, and compares counts × distance.
export function detectPlanDeviations(plan, breakdown, opts = {}) {
  const flags = [];
  if (!plan || !Array.isArray(plan.blocks) || !Array.isArray(breakdown) || !breakdown.length) return flags;

  // Round-5: skip the volume-deviation flag when the athlete's note indicates
  // a tracking dropout — the shortfall is untracked reps, not skipped ones.
  const matchedIds = new Set((opts.signals?.matched ?? []).map(m => m.id));
  const trackingDropout = matchedIds.has('tracking_dropout') || matchedIds.has('session_completed_explicit');
  // Also treat a mid-session rest gap of >300s as a heuristic tracking dropout,
  // since a proper cool-down doesn't produce a 5-minute gap between reps.
  const midSessionGap = breakdown.slice(0, -1).some(b => Number(b.rest_after_s) > 300);
  const skipVolumeCheck = trackingDropout || midSessionGap;

  const plannedVol = plan.total_volume_m
    || plan.blocks.reduce((s, b) => s + (Number(b.volume_m) || 0), 0);
  const actualVol = breakdown.reduce((s, b) => s + (Number(b.distance_m) || 0), 0);
  if (!skipVolumeCheck && plannedVol > 0 && Math.abs(actualVol - plannedVol) / plannedVol > 0.10) {
    const diff = actualVol - plannedVol;
    flags.push(`Plan deviation: total volume ${actualVol}m vs prescribed ${plannedVol}m (${diff > 0 ? '+' : '−'}${Math.abs(diff)}m).`);
  }
  if (skipVolumeCheck && plannedVol > 0 && actualVol < plannedVol) {
    const gap = plannedVol - actualVol;
    flags.push(`Data quality: tracking dropout — ${gap}m of the prescribed session appears untracked (not a compliance issue; athlete note / mid-session rest gap indicates a tracking gap).`);
  }

  // Per-block walk. Round-5 fix: skip per-block deviation on MIXED-distance
  // blocks — rendering "prescribed 12×100m" against a 4×100+4×50+4×25 warm-up
  // was a repeat false-positive. We only compare like-for-like blocks; the
  // total-volume check above still catches gross deviations.
  // Ride on the SAME walkPlanBlocks the reconciliation table uses. This used to
  // keep its own copy of the old `consumed < blockVol * 0.9` walk, so it drifted
  // exactly the way the table did — and worse, the debrief received a correct
  // table alongside contradictory "Plan deviation" flags derived from a
  // different, wrong block assignment. One walk, one answer.
  for (const { block, sets, intervals, expected_reps, unmatched } of walkPlanBlocks(plan, breakdown)) {
    if (unmatched) {
      const byDist = new Map();
      for (const iv of intervals) {
        const d = Number(iv.distance_m) || 0;
        byDist.set(d, (byDist.get(d) ?? 0) + 1);
      }
      flags.push(`Plan deviation: ${[...byDist.entries()].map(([d, c]) => `${c}×${d}m`).join(' + ')} swum but matching no prescribed block — a set was swapped or added.`);
      continue;
    }
    const distanceSet = new Set(sets.map(x => Number(x?.distance_m)).filter(x => Number.isFinite(x) && x > 0));
    if (expected_reps && !intervals.length) {
      flags.push(`Plan deviation: ${block.name ?? '(block)'} — prescribed ${expected_reps} rep(s), none matching recorded.`);
      continue;
    }
    // Mixed-distance blocks are skipped: rendering "prescribed 12×100m" against
    // a 4×100 + 4×50 + 4×25 warm-up was a repeat false positive. The
    // total-volume check above still catches gross deviations.
    const expectedDist = distanceSet.size === 1 ? [...distanceSet][0] : null;
    if (!expected_reps || !expectedDist || !intervals.length) continue;
    const count = intervals.length;
    const firstDist = Number(intervals[0].distance_m) || null;
    const repsMismatch = Math.abs(count - expected_reps) >= 2;
    const distMismatch = firstDist != null && firstDist !== expectedDist;
    if (repsMismatch || distMismatch) {
      flags.push(`Plan deviation: ${block.name ?? '(block)'} — prescribed ${expected_reps}×${expectedDist}m, actual ${count}×${firstDist ?? '?'}m.`);
    }
  }
  return flags;
}

export { sprintReps, fiftyReps };
