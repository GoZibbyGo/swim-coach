// Main-set archetypes — the structural vocabulary the session generator picks
// from, and the unit anti-repetition is tracked in.
//
// WHY THIS EXISTS. The generation prompt's entire creative vocabulary used to
// be the phrase "broken 50s, descending 25s, ladders", repeated in three rules.
// With one prior session fed back as the thing to differ from, the generator
// converged on a small handful of shapes and the athlete reported the sessions
// going stale. This module turns the knowledge base's set library (§5) into
// structured data so the engine can (a) hand the LLM an explicit menu, (b) name
// which archetypes were used recently, and (c) rotate deterministically in the
// fallback path too.
//
// Each archetype trains a different point on the speed ↔ speed-endurance curve.
// Rotation is therefore not decoration — a block that only ever runs "8×25 max"
// trains one energy system and leaves the 50m's actual glycolytic demand alone.
//
// rep_class vocabulary (matches the orchestrator's taxonomy rule):
//   max_alactic     — true top-end speed, ≥120s rest
//   speed_endurance — the 30–35s glycolytic middle the 50m actually is (NEW)
//   speed_technique — fast but sub-max, technique-constrained, 45–60s rest
//   build_finish    — progressive efforts, 60–90s rest
//   aerobic         — threshold / base, ≥15s rest
//   drill           — technique work, ≥15s rest

export const REP_CLASSES = [
  'max_alactic', 'speed_endurance', 'speed_technique', 'build_finish', 'aerobic', 'drill',
];

export const SET_ARCHETYPES = [
  // ── Sprint: alactic ────────────────────────────────────────────────────
  {
    id: 'alactic_25s',
    name: 'Straight max 25s',
    shape: '8–12×25m max from a push',
    rep_class: 'max_alactic',
    rest_rule: '≥120s',
    trains: 'Pure alactic top-end velocity with full recovery. The backbone, but not the whole diet.',
    subtype_fit: ['sprint'], phase_fit: [1, 2, 3], volume_m: 250,
  },
  {
    id: 'descending_25s',
    name: 'Descending 25s',
    shape: '6–8×25m descending 1→6 (each rep faster than the last)',
    rep_class: 'max_alactic',
    rest_rule: '≥120s',
    trains: 'Speed under control — teaches gear-finding rather than one flat max effort.',
    subtype_fit: ['sprint'], phase_fit: [1, 2, 3], volume_m: 200,
  },
  {
    id: 'mixed_25_50',
    name: '25/50 alternating',
    shape: '4×(25m max + 50m max) alternating',
    rep_class: 'max_alactic',
    rest_rule: '≥120s',
    trains: 'Alactic speed plus one turn under fatigue — bridges 25m speed to 50m racing.',
    subtype_fit: ['sprint'], phase_fit: [1, 2, 3], volume_m: 300,
  },
  {
    id: 'gear_change_50s',
    name: 'Gear-change 50s',
    shape: '6×50m as 25 build → 25 max',
    rep_class: 'build_finish',
    rest_rule: '60–90s',
    trains: 'Shifting into top gear mid-swim; coordination at the transition.',
    subtype_fit: ['sprint', 'race_pace'], phase_fit: [1, 2], volume_m: 300,
  },

  // ── Sprint: the speed-endurance middle (the identified programming gap) ──
  {
    id: 'race_pace_25s',
    name: 'Race-pace 25s at goal tempo',
    shape: '8×25m holding the goal-50 split (name the number, e.g. "hold 15.2s")',
    rep_class: 'speed_endurance',
    rest_rule: '≥120s',
    trains: 'Teaches the ACTUAL speed of the goal 50 rather than a vague "fast".',
    subtype_fit: ['sprint', 'race_pace'], phase_fit: [1, 2, 3], volume_m: 200,
  },
  {
    id: 'broken_50s',
    name: 'Broken 50s',
    shape: '4×50m broken at the 25 (25 + 10s rest + 25), full recovery between',
    rep_class: 'speed_endurance',
    rest_rule: '10s mid-rep, ≥120s between reps',
    trains: 'Race-pace speed at race distance — sub-goal splits while acidic.',
    subtype_fit: ['sprint', 'race_pace'], phase_fit: [1, 2, 3], volume_m: 200,
  },
  {
    id: 'speed_endurance_50s',
    name: 'Speed-endurance 50s (1:4 work:rest)',
    shape: '6–8×50m near-max at roughly 1:4 work-to-rest',
    rep_class: 'speed_endurance',
    rest_rule: '~120s',
    trains: 'Holding velocity while acidic — the 50m IS a ~30-35s glycolytic effort.',
    subtype_fit: ['sprint', 'race_pace'], phase_fit: [1, 2, 3], volume_m: 350,
  },
  {
    id: 'sprint_pyramid',
    name: 'Sprint pyramid',
    shape: '25-50-75-50-25 (or up to 100) max, full rest on the ≥50s',
    rep_class: 'speed_endurance',
    rest_rule: 'full on reps ≥50m',
    trains: 'A full sweep from pure speed through speed-endurance in one set.',
    subtype_fit: ['sprint', 'race_pace'], phase_fit: [2, 3], volume_m: 250,
  },
  {
    id: 'descending_ladder',
    name: 'Descending ladder',
    shape: '100-75-50-25, descending the pace as the distance drops',
    rep_class: 'speed_endurance',
    rest_rule: '45–90s',
    trains: 'Speed-endurance → speed bridge; finishing fastest when most tired.',
    subtype_fit: ['sprint', 'threshold'], phase_fit: [1, 2], volume_m: 250,
  },

  // ── Technique / stroke-mechanics ───────────────────────────────────────
  {
    id: 'spl_locked_50s',
    name: 'Stroke-count-locked descending',
    shape: '4–6×50m holding a fixed stroke count while descending the time',
    rep_class: 'speed_technique',
    rest_rule: '45–60s',
    trains: 'Distance-per-stroke under increasing speed — the DPS lever, not gliding.',
    subtype_fit: ['technique', 'sprint'], phase_fit: [1, 2], volume_m: 250,
  },
  {
    id: 'stroke_count_ladder',
    name: 'Stroke-count ladder',
    shape: '8×25m: 2 at SPL−1, 2 at SPL, 2 at SPL+1, 2 free — same target time',
    rep_class: 'speed_technique',
    rest_rule: '45–60s',
    trains: 'Finds the stroke-count/rate combination that is actually fastest for him.',
    subtype_fit: ['technique'], phase_fit: [1, 2], volume_m: 200,
  },
  {
    id: 'drill_sprint_contrast',
    name: 'Drill / sprint contrast',
    shape: '6×(25m drill + 25m fast) — carry the drill feel straight into speed',
    rep_class: 'speed_technique',
    rest_rule: '45–60s',
    trains: 'Transfers technique work into actual speed instead of leaving it in the drill.',
    subtype_fit: ['technique'], phase_fit: [1, 2, 3], volume_m: 300,
  },
  {
    id: 'turn_focus',
    name: 'Turn focus',
    shape: '8×25m "3 strokes then flip" away from the wall, or 6×(15m in + turn + 15m out)',
    rep_class: 'drill',
    rest_rule: '20–60s',
    trains: 'Turns are 20–30% of short-course race time; isolates entry, plant and breakout.',
    subtype_fit: ['technique', 'sprint'], phase_fit: [1, 2, 3], volume_m: 200,
  },

  // ── Kick (newly prioritised — kick is ~30% of propulsive force) ─────────
  {
    id: 'kick_board_controlled',
    name: 'Controlled board kick',
    shape: '6×50m flutter kick on a board, hip-driven and controlled',
    rep_class: 'aerobic',
    rest_rule: '20–30s',
    trains: 'Leg fitness and body position without ballistic loading. ⚠️ Flutter only — no dolphin.',
    subtype_fit: ['technique', 'threshold'], phase_fit: [1, 2], volume_m: 300,
  },
  {
    id: 'kick_vertical',
    name: 'Vertical kick',
    shape: '6×30s vertical flutter kick, 15–30s rest',
    rep_class: 'speed_technique',
    rest_rule: '15–30s',
    trains: 'Potent leg drive work. ⚠️ Quad-intensive — only after several symptom-free board-kick sessions.',
    subtype_fit: ['technique'], phase_fit: [2, 3], volume_m: 0,
  },

  // ── Threshold / aerobic ────────────────────────────────────────────────
  {
    id: 'broken_300s',
    name: 'Broken 300s',
    shape: '3×300m broken at each 100 with 10s rest',
    rep_class: 'aerobic',
    rest_rule: '10s internal, 45s between',
    trains: 'Threshold volume at a slightly higher quality than a straight swim.',
    subtype_fit: ['threshold'], phase_fit: [1, 2], volume_m: 900,
  },
  {
    id: 'descending_200s',
    name: 'Descending 200s',
    shape: '5×200m, each faster than the last',
    rep_class: 'aerobic',
    rest_rule: '30s',
    trains: 'Threshold with a pacing demand — negative-split discipline.',
    subtype_fit: ['threshold'], phase_fit: [1, 2], volume_m: 1000,
  },
  {
    id: 'threshold_ladder',
    name: 'Threshold ladder',
    shape: '200-300-400-300-200 at threshold effort',
    rep_class: 'aerobic',
    rest_rule: '30–45s',
    trains: 'Varied threshold exposure without the monotony of a straight rep set.',
    subtype_fit: ['threshold'], phase_fit: [1, 2], volume_m: 1400,
  },
  {
    id: 'negative_split_200s',
    name: 'Negative-split 200s',
    shape: '4×200m, second 100 faster than the first',
    rep_class: 'aerobic',
    rest_rule: '30s',
    trains: 'Pacing control and finishing speed under aerobic fatigue.',
    subtype_fit: ['threshold'], phase_fit: [1, 2], volume_m: 800,
  },
  {
    id: 'pull_100s',
    name: 'Pull 100s',
    shape: '6×100m pull (buoy ± paddles)',
    rep_class: 'aerobic',
    rest_rule: '20s',
    trains: 'Catch loading and DPS without leg involvement — useful while protecting the quad.',
    subtype_fit: ['threshold', 'technique'], phase_fit: [1, 2], volume_m: 600,
    equipment: 'pull buoy',
  },

  // ── Race simulation ────────────────────────────────────────────────────
  {
    id: 'race_sim_50s',
    name: 'Race-simulation 50s',
    shape: '4×50m from a push at full race effort, full recovery',
    rep_class: 'speed_endurance',
    rest_rule: '≥180s',
    trains: 'The event itself. Use sparingly — it is a test, not a training stimulus.',
    subtype_fit: ['race_pace'], phase_fit: [2, 3], volume_m: 200,
  },
  {
    id: 'time_trial_50',
    name: '50m time trial',
    shape: '1×50m all-out from a push, fully rested',
    rep_class: 'speed_endurance',
    rest_rule: 'fully rested',
    trains: 'Benchmark check against the sub-30 goal.',
    subtype_fit: ['race_pace'], phase_fit: [3], volume_m: 50,
  },
];

const BY_ID = new Map(SET_ARCHETYPES.map(a => [a.id, a]));

export function archetypeById(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Archetypes eligible for a given subtype + phase.
 */
export function archetypesFor(subtype, phase) {
  return SET_ARCHETYPES.filter(a =>
    a.subtype_fit.includes(subtype) &&
    (phase == null || a.phase_fit.includes(phase)));
}

/**
 * Archetype ids used by the most recent same-subtype sessions, newest first.
 * Read off `plan.archetype_id`, which the orchestrator stamps on generated
 * sessions (the LLM declares it; the fallback library maps its template).
 */
export function recentArchetypeIds(catalogue, subtype, lookback = 4) {
  return (catalogue?.sessions ?? [])
    .filter(s => s?.subtype === subtype)
    .slice(0, lookback)
    .map(s => s?.plan?.archetype_id ?? s?.archetype_id)
    .filter(Boolean);
}

/**
 * Prompt-ready menu. Recently-used archetypes are listed separately as
 * "do not reuse" rather than hidden, so the model understands the constraint
 * instead of silently getting a shorter list.
 *
 * @returns {string} '' when nothing is eligible (caller should omit the line)
 */
export function archetypeMenuText(subtype, phase, recentIds = []) {
  const eligible = archetypesFor(subtype, phase);
  if (!eligible.length) return '';
  const recent = new Set(recentIds);
  const line = a =>
    `  - ${a.id} — ${a.name}: ${a.shape}. [rep_class: ${a.rep_class}, rest ${a.rest_rule}] ${a.trains}`;
  const fresh = eligible.filter(a => !recent.has(a.id));
  const used = eligible.filter(a => recent.has(a.id));
  const parts = [
    `MAIN-SET ARCHETYPE MENU for a ${subtype} session in Phase ${phase}. Pick ONE as the spine of your main set and name it in the "archetype_id" field of the main block. You may adapt rep counts to hit the volume target, but keep the architecture recognisable.`,
    fresh.length ? `Available:\n${fresh.map(line).join('\n')}` : '',
    used.length
      ? `ALREADY USED in the last ${recentIds.length} ${subtype} session(s) — do NOT pick these again:\n${used.map(a => `  - ${a.id} (${a.name})`).join('\n')}`
      : '',
  ].filter(Boolean);
  return parts.join('\n');
}
