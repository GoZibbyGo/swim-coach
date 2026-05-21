// Symptom mapper — turns free-text athlete feedback into structured signals.
//
// Encodes knowledge/feedback-signals.md. Works offline (deterministic phrase
// matching) so the system stays adaptive even with no LLM. The LLM, when
// available, can map novel phrasing to these same signal ids — but everything
// here is handleable without it.
//
// The mapper only TRANSLATES free-text → signals + a resolved action set.
// The catalogue writer (#14) is what APPLIES them (sets flags, adjusts the
// next target step, etc.) and enforces decay.

// Effect fields a signal can carry:
//   flag           - injury/condition flag id (ties to flag-rules.js)
//   intensity      - 'increase' | 'hold' | 'decrease'
//   volume         - 'increase' | 'hold' | 'decrease'
//   recovery_tilt  - bias next session toward recovery/technique
//   equipment      - dryland equipment for the block
//   technique      - drill/cue focus theme
//   data_quality   - marks logged metrics partial/unreliable
//   note           - store as context (no automatic action)
//
// decay: 'next' | 'this' | 'block' | 'stored' | 'until_resolved' | {sessions:N}

export const FEEDBACK_SIGNALS = [
  // ── 1. Injury & pain ────────────────────────────────────────────────
  { id: 'left_quad_cramp', category: 'injury', applies_to: ['both'], severity: 'critical', decay: { sessions: 3 },
    phrases: ['left quad cramp', 'left thigh cramp', 'left quad seized', 'left quad locked'],
    effects: { flag: 'left_quad_cramp', recovery_tilt: true } },
  { id: 'right_quad_cramp', category: 'injury', applies_to: ['both'], severity: 'critical', decay: { sessions: 3 },
    phrases: ['right quad cramp', 'right thigh cramp', 'right quad seized', 'right quad locked'],
    effects: { flag: 'right_quad_cramp', recovery_tilt: true } },
  { id: 'right_quad_pre_cramp', category: 'injury', applies_to: ['both'], severity: 'high', decay: { sessions: 2 },
    phrases: ['right quad nearly cramp', 'right quad pre-cramp', 'right quad about to', 'right quad twinge'],
    effects: { flag: 'right_quad_pre_cramp' } },
  { id: 'left_quad_pre_cramp', category: 'injury', applies_to: ['both'], severity: 'high', decay: { sessions: 2 },
    phrases: ['left quad nearly cramp', 'left quad pre-cramp', 'left quad about to', 'left quad twinge'],
    effects: { flag: 'left_quad_pre_cramp' } },
  { id: 'calf_cramp', category: 'injury', applies_to: ['both'], severity: 'high', decay: { sessions: 2 },
    phrases: ['calf cramp', 'calf locked', 'calf seized'],
    effects: { flag: 'calf_cramp', recovery_tilt: true } },
  { id: 'hip_flexor_tightness', category: 'injury', applies_to: ['both'], severity: 'high', decay: { sessions: 2 },
    phrases: ['hip flexor tight', 'hip flexors sore', 'hip flexor sore'],
    effects: { flag: 'hip_flexor_tightness' } },
  { id: 'shoulder_discomfort', category: 'injury', applies_to: ['both'], severity: 'high', decay: { sessions: 3 },
    phrases: ['shoulder sore', 'shoulder pinch', 'shoulder hurt', 'shoulder pain', 'sore shoulder'],
    effects: { flag: 'shoulder_discomfort' } },
  { id: 'lower_back_discomfort', category: 'injury', applies_to: ['both'], severity: 'high', decay: { sessions: 2 },
    phrases: ['lower back sore', 'lower back tight', 'back tight', 'sore back'],
    effects: { flag: 'lower_back_discomfort' } },
  { id: 'general_soreness', category: 'injury', applies_to: ['both'], severity: 'medium', decay: 'next',
    phrases: ['sore all over', 'doms', 'really stiff', 'aching all over'],
    effects: { recovery_tilt: true } },
  { id: 'sharp_pain', category: 'injury', applies_to: ['both'], severity: 'critical', decay: 'until_resolved',
    phrases: ['sharp pain', 'something tweaked', 'felt a pull', 'tweaked'],
    effects: { flag: 'needs_review', recovery_tilt: true, note: true } },

  // ── 2. Fatigue, energy & readiness ──────────────────────────────────
  { id: 'exhausted', category: 'fatigue', applies_to: ['both'], severity: 'high', decay: 'next',
    phrases: ['exhausted', 'wiped', 'nothing left', 'completely spent', 'i died'],
    effects: { recovery_tilt: true, intensity: 'hold' } },
  { id: 'dead_legs', category: 'fatigue', applies_to: ['both'], severity: 'medium', decay: 'next',
    phrases: ['dead legs', 'legs heavy', 'heavy legs'],
    effects: { recovery_tilt: true } },
  { id: 'dead_arms', category: 'fatigue', applies_to: ['both'], severity: 'medium', decay: 'next',
    phrases: ['arms gone', 'shoulders fried', 'arms dead'],
    effects: { recovery_tilt: true } },
  { id: 'fresh_strong', category: 'fatigue', applies_to: ['both'], severity: 'info', decay: 'next',
    phrases: ['felt fresh', 'felt strong', 'full of energy', 'felt great'],
    effects: { intensity: 'increase' } },
  { id: 'sluggish', category: 'fatigue', applies_to: ['both'], severity: 'medium', decay: 'next',
    phrases: ['sluggish', 'felt flat', "couldn't get going"],
    effects: { intensity: 'hold' } },
  { id: 'under_recovered', category: 'fatigue', applies_to: ['both'], severity: 'high', decay: 'next',
    phrases: ['still tired from', 'not recovered', 'not fully recovered'],
    effects: { recovery_tilt: true } },
  { id: 'poor_sleep', category: 'fatigue', applies_to: ['both'], severity: 'medium', decay: 'next',
    phrases: ['slept badly', 'barely slept', 'bad sleep', 'no sleep'],
    effects: { intensity: 'hold', note: true } },
  { id: 'under_fuelled', category: 'fatigue', applies_to: ['both'], severity: 'info', decay: 'next',
    phrases: ["hadn't eaten", 'low energy', 'hungry'],
    effects: { note: true } },
  { id: 'dehydrated', category: 'fatigue', applies_to: ['both'], severity: 'medium', decay: 'next',
    phrases: ['dehydrated', 'thirsty'],
    effects: { note: true } },

  // ── 3. Intensity perception ─────────────────────────────────────────
  { id: 'too_easy', category: 'intensity', applies_to: ['both'], severity: 'medium', decay: 'next',
    phrases: ['too easy', "could've done more", 'could have done more', 'not challenging', "wasn't hard"],
    effects: { intensity: 'increase', volume: 'increase' } },
  { id: 'too_hard', category: 'intensity', applies_to: ['both'], severity: 'medium', decay: 'next',
    phrases: ['too hard', 'brutal', "couldn't keep up", 'way too tough'],
    effects: { intensity: 'decrease' } },
  { id: 'just_right', category: 'intensity', applies_to: ['both'], severity: 'info', decay: 'next',
    phrases: ['just right', 'challenging but doable', 'good challenge'],
    effects: { intensity: 'normal' } },
  { id: 'couldnt_hold_pace', category: 'intensity', applies_to: ['pool'], severity: 'medium', decay: 'next',
    phrases: ["couldn't hold the pace", 'faded off target', "couldn't hold pace", 'faded'],
    effects: { intensity: 'hold' } },
  { id: 'held_targets', category: 'intensity', applies_to: ['both'], severity: 'info', decay: 'next',
    phrases: ['hit all targets', 'held pace', 'held the pace', 'held swolf', 'hit my targets'],
    effects: { intensity: 'increase' } },
  { id: 'targets_too_aggressive', category: 'intensity', applies_to: ['both'], severity: 'medium', decay: 'next',
    phrases: ['targets were unrealistic', 'no chance at that time', 'targets too aggressive'],
    effects: { intensity: 'decrease' } },

  // ── 4. Completion & adherence ───────────────────────────────────────
  { id: 'cut_short', category: 'adherence', applies_to: ['both'], severity: 'high', decay: 'this',
    phrases: ['cut it short', 'stopped early', 'only did half', 'cut short', "didn't finish"],
    effects: { data_quality: 'partial', note: true } },
  { id: 'terminated_injury', category: 'adherence', applies_to: ['both'], severity: 'high', decay: 'this',
    phrases: ['stopped because of', 'had to stop because', 'stopped due to'],
    effects: { data_quality: 'partial', note: true } },
  { id: 'skipped_set', category: 'adherence', applies_to: ['both'], severity: 'medium', decay: 'this',
    phrases: ['skipped the', 'missed a set', 'skipped a set'],
    effects: { data_quality: 'partial_set' } },
  { id: 'added_extra', category: 'adherence', applies_to: ['both'], severity: 'info', decay: 'this',
    phrases: ['added an extra', 'did more than planned', 'added a set'],
    effects: { note: true } },
  { id: 'out_of_order', category: 'adherence', applies_to: ['both'], severity: 'info', decay: 'this',
    phrases: ['out of order', 'different order'],
    effects: { note: true } },
  { id: 'missed_intervals', category: 'adherence', applies_to: ['pool'], severity: 'medium', decay: 'this',
    phrases: ['missed the interval', 'missed intervals', "couldn't make the interval", 'fell off the interval'],
    effects: { note: true } },

  // ── 5. Technique ────────────────────────────────────────────────────
  { id: 'stroke_short', category: 'technique', applies_to: ['pool'], severity: 'medium', decay: 'next',
    phrases: ['stroke felt short', 'choppy', 'spinning my arms', 'short and choppy'],
    effects: { technique: 'dps' } },
  { id: 'stroke_long', category: 'technique', applies_to: ['pool'], severity: 'info', decay: 'next',
    phrases: ['stroke felt long', 'good dps', 'gliding well', 'felt long'],
    effects: { technique: 'maintain_dps', note: true } },
  { id: 'catch_slipping', category: 'technique', applies_to: ['pool'], severity: 'medium', decay: 'next',
    phrases: ['slipping', 'no catch', 'arm slipping'],
    effects: { technique: 'catch' } },
  { id: 'pushoff_weak', category: 'technique', applies_to: ['pool'], severity: 'medium', decay: 'next',
    phrases: ['weak off the wall', 'no push-off', 'weak push off', 'poor push-off'],
    effects: { technique: 'pushoff' } },
  { id: 'lost_stroke_count', category: 'technique', applies_to: ['pool'], severity: 'medium', decay: 'next',
    phrases: ['stroke count crept', 'stroke count went up', 'count crept up', 'strokes crept'],
    effects: { technique: 'efficiency' } },
  { id: 'body_position', category: 'technique', applies_to: ['pool'], severity: 'medium', decay: 'next',
    phrases: ['low in the water', 'hips dropping', 'hips sinking'],
    effects: { technique: 'body_position' } },

  // ── 6. Breathing ────────────────────────────────────────────────────
  { id: 'breathing_broke', category: 'breathing', applies_to: ['pool'], severity: 'medium', decay: 'next',
    phrases: ['breathing broke', 'had to breathe more', "couldn't hold the breathing"],
    effects: { technique: 'co2' } },
  { id: 'gasping', category: 'breathing', applies_to: ['pool'], severity: 'medium', decay: 'next',
    phrases: ['gasping', 'out of breath fast', 'so out of breath'],
    effects: { recovery_tilt: true, note: true } },

  // ── 7. Equipment & environment ──────────────────────────────────────
  { id: 'equipment_rings_only', category: 'equipment', applies_to: ['dryland'], severity: 'medium', decay: 'block',
    phrases: ['only had rings', 'rings only', 'just rings'],
    effects: { equipment: 'rings' } },
  { id: 'equipment_park_bars', category: 'equipment', applies_to: ['dryland'], severity: 'medium', decay: 'block',
    phrases: ['calisthenic park', 'bars only', 'park bars', 'just bars'],
    effects: { equipment: 'bars' } },
  { id: 'equipment_bodyweight', category: 'equipment', applies_to: ['dryland'], severity: 'medium', decay: 'block',
    phrases: ['no equipment', 'bodyweight only', 'just bodyweight'],
    effects: { equipment: 'bodyweight' } },
  { id: 'equipment_dumbbells', category: 'equipment', applies_to: ['dryland'], severity: 'medium', decay: 'block',
    phrases: ['had dumbbells', 'dumbbells available', 'dbs available'],
    effects: { equipment: 'dumbbells' } },
  { id: 'slippery_bars', category: 'equipment', applies_to: ['dryland'], severity: 'medium', decay: 'this',
    phrases: ['bars were slippery', 'slippery bars', "couldn't grip"],
    effects: { data_quality: 'grip_compromised' } },
  { id: 'pool_crowded', category: 'environment', applies_to: ['pool'], severity: 'info', decay: 'this',
    phrases: ['pool was packed', 'sharing a lane', 'pool was crowded', 'crowded pool'],
    effects: { data_quality: 'disrupted', note: true } },
  { id: 'cold_water', category: 'environment', applies_to: ['pool'], severity: 'info', decay: 'this',
    phrases: ['water was cold', 'freezing', 'cold water'],
    effects: { note: true } },

  // ── 8. Mental & motivation ──────────────────────────────────────────
  { id: 'unmotivated', category: 'mental', applies_to: ['both'], severity: 'info', decay: 'next',
    phrases: ["couldn't be bothered", 'dreaded it', 'forced myself', 'no motivation'],
    effects: { intensity: 'hold', note: true } },
  { id: 'motivated', category: 'mental', applies_to: ['both'], severity: 'info', decay: 'stored',
    phrases: ['felt motivated', 'loved it', 'fired up', 'really enjoyed'],
    effects: { note: true } },
  { id: 'mental_fatigue', category: 'mental', applies_to: ['both'], severity: 'medium', decay: 'next',
    phrases: ['mentally drained', 'brain fried', 'mentally exhausted'],
    effects: { intensity: 'hold', note: true } },

  // ── 9. Performance ──────────────────────────────────────────────────
  { id: 'claimed_pr', category: 'performance', applies_to: ['both'], severity: 'high', decay: 'this',
    phrases: ['pr', 'best ever', 'fastest yet', 'personal best'],
    effects: { note: true } },
  { id: 'missed_target', category: 'performance', applies_to: ['both'], severity: 'info', decay: 'next',
    phrases: ['missed target', 'off the time', 'missed the target'],
    effects: { note: true } },
];

// ──────────────────────────────────────────────────────────────────────────
// Matching + resolution
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {string} text - free-text athlete feedback
 * @param {object} [opts] - { context: 'pool'|'dryland' } to scope signals
 * @returns {{ matched: object[], resolved: object }}
 */
export function mapFeedback(text, opts = {}) {
  const lower = ' ' + String(text ?? '').toLowerCase().replace(/[’]/g, "'") + ' ';
  const context = opts.context;

  const matched = [];
  for (const sig of FEEDBACK_SIGNALS) {
    if (context && !sig.applies_to.includes('both') && !sig.applies_to.includes(context)) continue;
    if (sig.phrases.some(p => lower.includes(p))) matched.push(sig);
  }

  return { matched, resolved: resolve(matched) };
}

function resolve(matched) {
  const flags = [];
  const technique = new Set();
  const dataQuality = new Set();
  const contextNotes = [];
  let equipment = null;
  const intensityVotes = [];
  const volumeVotes = [];
  let recoveryTilt = false;

  for (const m of matched) {
    const e = m.effects ?? {};
    if (e.flag && !flags.includes(e.flag)) flags.push(e.flag);
    if (e.intensity) intensityVotes.push(e.intensity);
    if (e.volume) volumeVotes.push(e.volume);
    if (e.recovery_tilt) recoveryTilt = true;
    if (e.equipment) equipment = e.equipment;
    if (e.technique) technique.add(e.technique);
    if (e.data_quality) dataQuality.add(e.data_quality);
    if (e.note) contextNotes.push(m.id);
  }

  // Injury (critical/high in the injury category) forces recovery and blocks
  // any intensity increase — safety first.
  const hasInjury = matched.some(m => m.category === 'injury' && m.effects?.flag);
  if (hasInjury) recoveryTilt = true;

  // Conservative resolution: decrease > hold/recovery > increase.
  let intensity = 'normal';
  if (intensityVotes.includes('decrease')) intensity = 'decrease';
  else if (intensityVotes.includes('hold') || recoveryTilt) intensity = 'hold';
  else if (intensityVotes.includes('increase') && !hasInjury) intensity = 'increase';

  let volume = 'normal';
  if (volumeVotes.includes('decrease') || recoveryTilt) volume = 'decrease';
  else if (volumeVotes.includes('increase') && !hasInjury) volume = 'increase';

  return {
    flags,
    intensity,
    volume,
    recovery_tilt: recoveryTilt,
    equipment,
    technique_focus: [...technique],
    data_quality: [...dataQuality],
    context_notes: contextNotes,
  };
}
