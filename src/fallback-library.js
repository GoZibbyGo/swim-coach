// Fallback template library.
//
// Produces a complete, valid structured session WITHOUT an LLM — used when
// Gemini is unavailable, rate-limited, or its output fails validation twice.
// Templates define sets only; the builder computes every volume so the
// validator's distance check passes by construction.
//
// Templates are assembled from the KB set library (knowledge/swimming-coaching-kb.md
// and dryland-coaching-kb.md). Cues are short pre-written coach-voice lines —
// less expressive than the LLM, but safe and on-message. Flag-aware: an active
// quad flag rewrites push-off drills to glide-only and never prescribes
// dolphin kick.

import { computeTargets, secondsToPace } from './targets.js';

// ──────────────────────────────────────────────────────────────────────────
// Pool templates — sets only; volumes computed by the builder.
// effort 'max'/'near-max' on short reps triggers the ≥120s rest rule.
// ──────────────────────────────────────────────────────────────────────────

const POOL_TEMPLATES = {
  sprint: [
    {
      id: 'sprint_race_sim',
      blocks: [
        { name: 'Warm-Up', cue_key: 'warmup', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
        { name: 'Drill Block', cue_key: 'drill_pushoff', sets: [
          { reps: 4, distance_m: 25, effort: 'drill', rest_s: 30, drill: 'wall push-off glide' },
          { reps: 4, distance_m: 25, effort: 'drill', rest_s: 20, drill: 'single-arm' },
        ] },
        { name: 'Priming Set', cue_key: 'priming', sets: [{ reps: 4, distance_m: 25, effort: 'build', rest_s: 90 }] },
        { name: 'Sprint Main Set', cue_key: 'sprint_main', sets: [{ reps: 10, distance_m: 25, effort: 'max', rest_s: 120 }] },
        { name: 'Race Simulation', cue_key: 'race_sim', sets: [{ reps: 6, distance_m: 50, effort: 'near-max', rest_s: 180 }] },
        { name: 'Sprint Finish', cue_key: 'sprint_finish', sets: [{ reps: 6, distance_m: 25, effort: 'max', rest_s: 120 }] },
        { name: 'Cool-Down', cue_key: 'cooldown', sets: [{ reps: 8, distance_m: 25, effort: 'easy', rest_s: 0, breathing: 'every-5' }] },
      ],
    },
    {
      id: 'sprint_speed_endurance',
      blocks: [
        { name: 'Warm-Up', cue_key: 'warmup', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
        { name: 'Drill Block', cue_key: 'drill_catch', sets: [{ reps: 8, distance_m: 25, effort: 'drill', rest_s: 25, drill: 'fingertip drag + scull' }] },
        { name: 'Priming Set', cue_key: 'priming', sets: [{ reps: 4, distance_m: 25, effort: 'build', rest_s: 90 }] },
        { name: 'Sprint Main Set', cue_key: 'sprint_main', sets: [{ reps: 12, distance_m: 25, effort: 'max', rest_s: 120 }] },
        { name: 'Speed Endurance', cue_key: 'speed_endurance', sets: [{ reps: 4, distance_m: 50, effort: 'near-max', rest_s: 150 }] },
        { name: 'Sprint Finish', cue_key: 'sprint_finish', sets: [{ reps: 8, distance_m: 25, effort: 'max', rest_s: 120 }] },
        { name: 'Cool-Down', cue_key: 'cooldown', sets: [{ reps: 8, distance_m: 25, effort: 'easy', rest_s: 0, breathing: 'every-5' }] },
      ],
    },
    {
      id: 'sprint_volume',
      blocks: [
        { name: 'Warm-Up', cue_key: 'warmup', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
        { name: 'Drill Block', cue_key: 'drill_pushoff', sets: [{ reps: 8, distance_m: 25, effort: 'drill', rest_s: 25, drill: 'wall push-off glide' }] },
        { name: 'Priming Set', cue_key: 'priming', sets: [{ reps: 4, distance_m: 25, effort: 'build', rest_s: 90 }] },
        { name: 'Sprint Main Set', cue_key: 'sprint_main', sets: [{ reps: 16, distance_m: 25, effort: 'max', rest_s: 120 }] },
        { name: 'Speed Endurance', cue_key: 'speed_endurance', sets: [{ reps: 4, distance_m: 50, effort: 'near-max', rest_s: 150 }] },
        { name: 'Cool-Down', cue_key: 'cooldown', sets: [{ reps: 12, distance_m: 25, effort: 'easy', rest_s: 0, breathing: 'every-5' }] },
      ],
    },
  ],

  threshold: [
    {
      id: 'threshold_8x200',
      blocks: [
        { name: 'Warm-Up', cue_key: 'warmup', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
        { name: 'Drill Block', cue_key: 'drill_pushoff', sets: [
          { reps: 4, distance_m: 25, effort: 'drill', rest_s: 30, drill: 'wall push-off glide' },
          { reps: 4, distance_m: 25, effort: 'drill', rest_s: 20, drill: 'fingertip drag' },
        ] },
        { name: 'Main Set', cue_key: 'threshold_main', sets: [{ reps: 8, distance_m: 200, effort: '85%', rest_s: 40 }] },
        { name: 'Sprint Finish', cue_key: 'sprint_finish', sets: [{ reps: 6, distance_m: 25, effort: 'max', rest_s: 120 }] },
        { name: 'Cool-Down', cue_key: 'cooldown', sets: [{ reps: 6, distance_m: 25, effort: 'easy', rest_s: 0, breathing: 'every-5' }] },
      ],
    },
    {
      id: 'threshold_5x300',
      blocks: [
        { name: 'Warm-Up', cue_key: 'warmup', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
        { name: 'Drill Block', cue_key: 'drill_catch', sets: [{ reps: 8, distance_m: 25, effort: 'drill', rest_s: 25, drill: 'single-arm + scull' }] },
        { name: 'Main Set', cue_key: 'threshold_main', sets: [{ reps: 5, distance_m: 300, effort: '85%', rest_s: 40 }] },
        { name: 'Sprint Finish', cue_key: 'sprint_finish', sets: [{ reps: 6, distance_m: 25, effort: 'max', rest_s: 120 }] },
        { name: 'Cool-Down', cue_key: 'cooldown', sets: [{ reps: 6, distance_m: 25, effort: 'easy', rest_s: 0, breathing: 'every-5' }] },
      ],
    },
  ],

  technique: [
    {
      id: 'technique_efficiency',
      blocks: [
        { name: 'Warm-Up', cue_key: 'warmup', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
        { name: 'Drill Block', cue_key: 'drill_catch', sets: [{ reps: 8, distance_m: 25, effort: 'drill', rest_s: 25, drill: 'catch-up + fist' }] },
        { name: 'Drill Block 2', cue_key: 'drill_pushoff', sets: [{ reps: 4, distance_m: 50, effort: 'drill', rest_s: 30, drill: 'single-arm' }] },
        { name: 'Main Set', cue_key: 'technique_main', sets: [{ reps: 10, distance_m: 100, effort: 'smooth', rest_s: 20 }] },
        { name: 'Speed Touches', cue_key: 'priming', sets: [{ reps: 4, distance_m: 25, effort: 'build', rest_s: 60 }] },
        { name: 'Cool-Down', cue_key: 'cooldown', sets: [{ reps: 8, distance_m: 25, effort: 'easy', rest_s: 0, breathing: 'every-5' }] },
      ],
    },
    {
      id: 'technique_pull_focus',
      blocks: [
        { name: 'Warm-Up', cue_key: 'warmup', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
        { name: 'Drill Block', cue_key: 'drill_catch', sets: [{ reps: 12, distance_m: 25, effort: 'drill', rest_s: 25, drill: 'scull + fingertip drag' }] },
        { name: 'Main Set', cue_key: 'technique_main', sets: [{ reps: 6, distance_m: 150, effort: 'smooth', rest_s: 20 }] },
        { name: 'Pull Set', cue_key: 'pull', sets: [{ reps: 4, distance_m: 100, effort: 'moderate', rest_s: 20, equipment: 'pull buoy + paddles' }] },
        { name: 'Cool-Down', cue_key: 'cooldown', sets: [{ reps: 8, distance_m: 25, effort: 'easy', rest_s: 0, breathing: 'every-5' }] },
      ],
    },
  ],

  race_pace: [
    {
      id: 'race_pace_50s',
      blocks: [
        { name: 'Warm-Up', cue_key: 'warmup', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
        { name: 'Drill Block', cue_key: 'drill_pushoff', sets: [{ reps: 8, distance_m: 25, effort: 'drill', rest_s: 25, drill: 'wall push-off glide' }] },
        { name: 'Priming Set', cue_key: 'priming', sets: [{ reps: 4, distance_m: 25, effort: 'build', rest_s: 90 }] },
        { name: 'Race Main Set', cue_key: 'race_sim', sets: [{ reps: 12, distance_m: 50, effort: 'near-max', rest_s: 180 }] },
        { name: 'Broken 50s', cue_key: 'speed_endurance', sets: [{ reps: 6, distance_m: 50, effort: 'near-max', rest_s: 180 }] },
        { name: 'Cool-Down', cue_key: 'cooldown', sets: [{ reps: 8, distance_m: 25, effort: 'easy', rest_s: 0, breathing: 'every-5' }] },
      ],
    },
  ],

  recovery: [
    {
      id: 'recovery_easy',
      blocks: [
        { name: 'Warm-Up', cue_key: 'warmup', sets: [{ reps: 4, distance_m: 100, effort: 'easy', rest_s: 15 }] },
        { name: 'Main Set', cue_key: 'recovery_main', sets: [{ reps: 8, distance_m: 100, effort: 'easy', rest_s: 20 }] },
        { name: 'Cool-Down', cue_key: 'cooldown', sets: [{ reps: 8, distance_m: 25, effort: 'easy', rest_s: 0, breathing: 'every-5' }] },
      ],
    },
  ],
};

// ──────────────────────────────────────────────────────────────────────────
// Dryland templates — equipment-keyed; exercises, not distance sets.
// Block order matches the KB: core → pulling → shoulder → controlled legs.
// ──────────────────────────────────────────────────────────────────────────

const DRYLAND_TEMPLATES = {
  bars: {
    id: 'dryland_bars',
    blocks: [
      { name: 'Block A — Core & Rotation', exercises: [
        { name: 'Hollow-body hold', sets: 3, prescription: '20-30s', rest_s: 45, rationale: 'streamline trunk tension' },
        { name: 'Hanging knee raises', sets: 3, prescription: '10-12 reps', rest_s: 45, rationale: 'lower-ab + hip-flexor control' },
        { name: 'V-ups', sets: 3, prescription: '10-15 reps', rest_s: 45, rationale: 'dynamic trunk flexion' },
      ] },
      { name: 'Block B — Pulling Strength', exercises: [
        { name: 'Inverted rows', sets: 4, prescription: '10-12 reps', rest_s: 60, rationale: 'horizontal pull / catch strength' },
        { name: 'Pull-ups', sets: 4, prescription: 'max-3 reps', rest_s: 90, rationale: 'freestyle-pull pattern, lat power' },
        { name: 'Dips', sets: 3, prescription: '8-10 reps', rest_s: 60, rationale: 'pressing balance' },
      ] },
      { name: 'Block C — Shoulder Stability', exercises: [
        { name: 'Scapular pull-ups', sets: 3, prescription: '6-8 reps', rest_s: 45, rationale: 'scapular control under load' },
        { name: 'Support hold (dip bars)', sets: 3, prescription: '20s', rest_s: 45, rationale: 'shoulder stability' },
        { name: 'Prone Y-T-W raises', sets: 3, prescription: '10 each', rest_s: 45, rationale: 'lower-trap / cuff' },
      ] },
      { name: 'Block D — Controlled Leg / Hip-Flexor', exercises: [
        { name: 'Bar-assisted deep-squat hold', sets: 3, prescription: '20-30s', rest_s: 45, rationale: 'quad/hip mobility + isometric base' },
        { name: 'Bar-assisted single-leg squat', sets: 3, prescription: '6 each leg', rest_s: 60, rationale: 'unilateral quad control' },
        { name: 'Slow standing hip-flexor drive', sets: 3, prescription: '10 each', rest_s: 45, rationale: 'hip-flexor endurance (deficit)' },
      ] },
    ],
  },
  rings: {
    id: 'dryland_rings',
    blocks: [
      { name: 'Block A — Core & Rotation', exercises: [
        { name: 'Hollow-body hold', sets: 3, prescription: '20-30s', rest_s: 45, rationale: 'streamline trunk tension' },
        { name: 'Ring knee raises', sets: 3, prescription: '10-12 reps', rest_s: 45, rationale: 'hip-flexor control' },
        { name: 'V-ups', sets: 3, prescription: '10-15 reps', rest_s: 45, rationale: 'dynamic trunk flexion' },
      ] },
      { name: 'Block B — Pulling Strength', exercises: [
        { name: 'Ring rows', sets: 4, prescription: '10-12 reps', rest_s: 60, rationale: 'scapular retraction / catch' },
        { name: 'Ring pull-ups', sets: 4, prescription: 'max-3 reps', rest_s: 90, rationale: 'freestyle-pull pattern' },
        { name: 'Ring dips', sets: 3, prescription: '6-8 reps', rest_s: 60, rationale: 'pressing balance + stability' },
      ] },
      { name: 'Block C — Shoulder Stability', exercises: [
        { name: 'Ring support hold', sets: 3, prescription: '20s', rest_s: 45, rationale: 'shoulder stability under instability' },
        { name: 'Prone Y-T-W raises', sets: 3, prescription: '10 each', rest_s: 45, rationale: 'lower-trap / cuff' },
      ] },
      { name: 'Block D — Controlled Leg / Hip-Flexor', exercises: [
        { name: 'Wall-sit', sets: 3, prescription: '30s', rest_s: 45, rationale: 'quad isometric base' },
        { name: 'Single-leg deadlift (bodyweight)', sets: 3, prescription: '6 each leg', rest_s: 45, rationale: 'posterior chain, anti-cramp' },
        { name: 'Slow standing hip-flexor drive', sets: 3, prescription: '10 each', rest_s: 45, rationale: 'hip-flexor endurance' },
      ] },
    ],
  },
  bodyweight: {
    id: 'dryland_bodyweight',
    blocks: [
      { name: 'Block A — Core & Rotation', exercises: [
        { name: 'Plank', sets: 3, prescription: '30-45s', rest_s: 45, rationale: 'anti-extension stability' },
        { name: 'Hollow-body hold', sets: 3, prescription: '20-30s', rest_s: 45, rationale: 'streamline tension' },
        { name: 'V-ups', sets: 3, prescription: '10-15 reps', rest_s: 45, rationale: 'trunk flexion' },
        { name: 'Bird dog', sets: 3, prescription: '8 each', rest_s: 30, rationale: 'anti-rotation' },
      ] },
      { name: 'Block B — Pulling Strength', exercises: [
        { name: 'Table/doorway rows', sets: 4, prescription: '10-12 reps', rest_s: 60, rationale: 'horizontal pull' },
        { name: 'Push-ups', sets: 3, prescription: '10-15 reps', rest_s: 45, rationale: 'pressing balance' },
      ] },
      { name: 'Block C — Shoulder Stability', exercises: [
        { name: 'Prone Y-T-W raises', sets: 3, prescription: '10 each', rest_s: 45, rationale: 'lower-trap / cuff' },
        { name: 'Floor scapular slides', sets: 3, prescription: '10 reps', rest_s: 30, rationale: 'scapular control' },
      ] },
      { name: 'Block D — Controlled Leg / Hip-Flexor', exercises: [
        { name: 'Wall-sit', sets: 3, prescription: '30s', rest_s: 45, rationale: 'quad isometric base' },
        { name: 'Glute bridge (single-leg)', sets: 3, prescription: '10 each', rest_s: 45, rationale: 'posterior chain, anti-cramp' },
        { name: 'Slow standing hip-flexor drive', sets: 3, prescription: '10 each', rest_s: 45, rationale: 'hip-flexor endurance' },
      ] },
    ],
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Cue bank — short coach-voice lines. Picked deterministically (no RNG) so
// generation is reproducible. Never prescribes dolphin kick.
// ──────────────────────────────────────────────────────────────────────────

const CUES = {
  warmup: [
    'Easy and long — no effort here. Loosen the shoulders and find your rhythm.',
    'Relaxed and smooth. Count your strokes; aim for 10 or under without forcing.',
  ],
  drill_pushoff: [
    'Max force into the wall, tight streamline, push and glide — no dolphin kick. Ride it to a near-stop.',
    'Load the push-off pattern: streamline, no dolphin kick today, glide long. Monitor the quad; stop on any tightness.',
  ],
  drill_catch: [
    'Feel the forearm catch — pressure on the forearm, not just the hand. High elbow on entry.',
    'Slow and deliberate. Connect the catch to your rotation; this is feel work, not speed.',
  ],
  priming: [
    'Build each rep: 70 → 80 → 90 → 100%. The last one is full race speed. Wakes up the fast-twitch — take the rest.',
    'Progressive build to max on the final rep. One stride into the wall, clean and fast.',
  ],
  sprint_main: [
    'No breath the first 10m, then every 2. Hit the wall hard, count strokes — target 7/length, 8 acceptable.',
    'Max effort, full rest. Explode off the wall, stay long. Time every rep and note your best.',
  ],
  race_sim: [
    'Treat each as a race. Open turn (no dolphin kick), push and sprint home. Find where you fade — that\'s your gap.',
    'Race effort. Hold form to the wall, controlled turn, drive the second length.',
  ],
  speed_endurance: [
    'Hold speed as fatigue builds — this is where race fitness lives. Don\'t let stroke count climb.',
    'Near-max with form. If you\'re dying on the back half, you went out too hard — dial back 5%.',
  ],
  sprint_finish: [
    'You\'re fatigued — these are meant to be fast anyway. Stay long, 7 strokes, no breathing. Let a best happen here.',
    'Last hard efforts. Full commitment, clean technique. This is where the priming pays off.',
  ],
  threshold_main: [
    'Hold the pace across every rep — even effort, not a fast first one then fade. Smooth and strong.',
    'Sustained pace, controlled breathing every 3. Watch the stroke count creep in the back half.',
  ],
  technique_main: [
    'Smooth and efficient — this is about feel, not effort. Long strokes, hold your count.',
    'Quality over speed. Reinforce the catch and rotation you drilled. Keep it relaxed.',
  ],
  pull: [
    'Buoy and paddles — load the catch, feel the forearm. Long, powerful strokes. Easy on the shoulders.',
    'Pull focus: legs quiet, drive the pull. Reinforce distance-per-stroke.',
  ],
  recovery_main: [
    'Easy throughout. Loosen up, flush the legs, keep it gentle. No targets today.',
    'Recovery pace — relaxed and smooth. Focus on long, easy strokes.',
  ],
  cooldown: [
    'Every-5-stroke breathing throughout, continuous, no stopping. The discomfort between breaths is the point — CO2 tolerance.',
    'Hold the every-5 pattern the whole way. If it breaks, reset on the next length — don\'t coast to every-3.',
  ],
};

// Quad-flag rewrite for push-off drills — already glide-only, but make it explicit.
const QUAD_FLAGS = new Set(['left_quad_cramp', 'right_quad_cramp', 'left_quad_pre_cramp', 'right_quad_pre_cramp']);

// ──────────────────────────────────────────────────────────────────────────
// Builder
// ──────────────────────────────────────────────────────────────────────────

function pickIndex(seed, len) {
  if (len <= 0) return 0;
  return ((seed % len) + len) % len;
}

function pickTemplate(templates, recentIds, seed) {
  const eligible = templates.filter(t => !recentIds.includes(t.id));
  const pool = eligible.length ? eligible : templates;
  return pool[pickIndex(seed, pool.length)];
}

function cueFor(key, seed, activeFlags) {
  const variants = CUES[key];
  if (!variants) return null;
  let cue = variants[pickIndex(seed, variants.length)];
  // Reinforce quad protection on push-off cues when a quad flag is active.
  if (key === 'drill_pushoff' && [...QUAD_FLAGS].some(f => activeFlags.includes(f))) {
    cue += ' ⚠️ Quad flag active — if you feel any tightness in either quad, stop the drill immediately.';
  }
  return cue;
}

function targetLineFor(blockName, subtype, targets) {
  const n = blockName.toLowerCase();
  if (subtype === 'sprint' || subtype === 'race_pace') {
    if (n.includes('sprint main') || n.includes('sprint finish')) {
      const parts = [];
      if (targets.beat_25m_s != null) parts.push(`beat ${targets.beat_25m_s}s (aim sub-${targets.stretch_25m_s}s)`);
      if (targets.sprint_swolf_target != null) parts.push(`SWOLF ${targets.sprint_swolf_target}`);
      if (targets.stroke_count_target != null) parts.push(`${targets.stroke_count_target} strokes/length`);
      return parts.length ? `Target: ${parts.join(' · ')}` : null;
    }
    if (n.includes('race')) {
      if (targets.stretch_50m_s != null) return `Target: sub-${targets.stretch_50m_s}s per 50`;
    }
  }
  if (subtype === 'threshold' && n.includes('main')) {
    const parts = [];
    if (targets.main_set_pace_target != null) parts.push(`hold ${targets.main_set_pace_target}/100m`);
    if (targets.swolf_target != null) parts.push(`SWOLF ${targets.swolf_target}`);
    return parts.length ? `Target: ${parts.join(' · ')}` : null;
  }
  if (subtype === 'technique' && n.includes('main')) {
    if (targets.swolf_target != null) return `Target: hold SWOLF ${targets.swolf_target}, count strokes`;
  }
  return null;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build a fully-formed, validator-ready session from the fallback library.
 *
 * @param {object} decision - block-state output (type, subtype, block_number, session_in_block, active_flags)
 * @param {object} catalogue
 * @param {object} [opts] - { date, equipment, recentTemplateIds }
 * @returns {{ session: object, template_id: string }}
 */
export function buildFallbackSession(decision, catalogue, opts = {}) {
  const {
    type = 'pool',
    subtype = 'sprint',
    block_number = 1,
    session_in_block = 1,
    active_flags = [],
  } = decision ?? {};
  const phase = catalogue?.training_phase?.current ?? 1;
  const date = opts.date ?? today();
  const recentIds = opts.recentTemplateIds ?? [];
  const seed = (block_number * 7) + session_in_block; // deterministic variety

  if (type === 'dryland') {
    return buildFallbackDryland(decision, catalogue, { ...opts, date, phase, seed });
  }

  const targets = computeTargets(catalogue, subtype);
  const templates = POOL_TEMPLATES[subtype] ?? POOL_TEMPLATES.sprint;
  const template = pickTemplate(templates, recentIds, seed);

  const blocks = template.blocks.map(b => {
    const sets = b.sets.map(s => filterSetEquipment({ ...s }, opts.equipmentAvailable));
    const volume_m = sets.reduce((sum, s) => sum + (s.reps ?? 1) * (s.distance_m ?? 0), 0);
    return {
      name: b.name,
      volume_m,
      cue: cueFor(b.cue_key, seed, active_flags),
      target: targetLineFor(b.name, subtype, targets),
      sets,
    };
  });
  const total_volume_m = blocks.reduce((sum, b) => sum + b.volume_m, 0);

  const session = {
    date, type: 'pool', subtype, phase, block_number, session_in_block,
    total_volume_m, blocks, targets,
    active_flags,
    source: 'app_generated',
    generator: 'fallback_library',
    template_id: template.id,
  };
  return { session, template_id: template.id };
}

function resolveEquipment(catalogue, blockNumber, optEquipment, available) {
  // A pre-session availability list (from the Today checkboxes) wins when given.
  // Offline fallback stays conservative: weights-only / nothing → bodyweight
  // (the LLM path uses weights properly; the template library doesn't have a
  // dumbbell-only session).
  if (Array.isArray(available)) {
    if (available.includes('rings')) return 'rings';
    if (available.includes('bars')) return 'bars';
    return 'bodyweight';
  }
  const raw = optEquipment
    ?? catalogue?.weekly_block_tracking?.[`block_${blockNumber}_dryland_equipment`]
    ?? 'bodyweight';
  const s = String(raw).toLowerCase();
  if (s.includes('ring')) return 'rings';
  if (s.includes('bar') || s.includes('park')) return 'bars';
  if (s.includes('dumbbell') || s.includes('db')) return 'bars'; // bars template covers loaded patterns
  return 'bodyweight';
}

// When a pre-session availability list is given, downgrade any pool set's
// `equipment` to only what's on hand (e.g. 'pull buoy + paddles' → 'pull buoy',
// or remove it entirely → plain swim). No list = leave templates as authored.
function filterSetEquipment(set, available) {
  if (!Array.isArray(available) || !set.equipment) return set;
  const keep = [];
  if (/buoy/i.test(set.equipment) && available.includes('pull_buoy')) keep.push('pull buoy');
  if (/paddle/i.test(set.equipment) && available.includes('paddles')) keep.push('paddles');
  if (keep.length) set.equipment = keep.join(' + ');
  else delete set.equipment;
  return set;
}

function buildFallbackDryland(decision, catalogue, opts) {
  const { block_number = 1, session_in_block = 1, active_flags = [], subtype = 'strength' } = decision ?? {};
  const equipmentKey = resolveEquipment(catalogue, block_number, opts.equipment, opts.equipmentAvailable);
  const template = DRYLAND_TEMPLATES[equipmentKey] ?? DRYLAND_TEMPLATES.bodyweight;
  const quadActive = [...QUAD_FLAGS].some(f => active_flags.includes(f));

  // Clone blocks; annotate the leg block when a quad flag is active.
  const blocks = template.blocks.map(b => {
    const block = { name: b.name, exercises: b.exercises.map(e => ({ ...e })) };
    if (quadActive && /leg|hip-flexor/i.test(b.name)) {
      block.note = '⚠️ Quad flag active — controlled tempo only, no jumping or explosive loading; keep isometric holds short. Stop on any tightness.';
    }
    return block;
  });

  const session = {
    date: opts.date,
    type: 'dryland',
    subtype,
    phase: opts.phase ?? 1,
    block_number,
    session_in_block,
    total_volume_m: null,
    blocks,
    equipment: equipmentKey,
    active_flags,
    source: 'app_generated',
    generator: 'fallback_library',
    template_id: template.id,
  };
  return { session, template_id: template.id };
}

export { POOL_TEMPLATES, DRYLAND_TEMPLATES };
