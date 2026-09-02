// Orchestrator — the single entry point for generating the next session.
//
// Flow (Option C, agreed with the athlete):
//   1. Deterministic core decides type/subtype/targets/flags (always).
//   2. If an LLM is configured & reachable: ask Gemini to build the sets+cues,
//      then VALIDATE. Valid → use it. Invalid → retry once with the errors.
//      Still invalid → fall back to the library.
//   3. On any LLM failure (offline, rate limit, auth, parse) → fall back.
//   4. The deterministic validator gates everything; the LLM never writes the
//      catalogue and never decides the maths.
//
// Returns a structured result the UI uses to render the session and, when
// falling back, show the right popup (offline vs per-minute vs daily quota).

import { determineNextSession } from './block-state.js';
import { computeTargets } from './targets.js';
import { validateGeneratedSession } from './validator.js';
import { POOL_VOLUME_TARGETS_M } from './schema.js';
import { volumeTargetsForPhase } from './phases.js';
import { buildFallbackSession } from './fallback-library.js';
import { guidanceForFlags } from './flag-rules.js';
import { callGemini } from './gemini.js';
import { phaseHasSprintFinish } from './phases.js';
import { archetypeMenuText, recentArchetypeIds, archetypeById } from './set-archetypes.js';

function today() { return new Date().toISOString().slice(0, 10); }

// Template ids the athlete has recently been given, newest first, so the
// fallback library can avoid handing back a session they just swam.
//
// This is DERIVED from the catalogue rather than supplied by the caller: the
// web app never passed `recentTemplateIds`, so `buildFallbackSession` always
// received `[]` and the library had zero anti-repetition memory — it re-picked
// the same template every time Gemini was unavailable. Deriving it here means
// no call site can forget. `opts.recentTemplateIds` still overrides (tests).
const RECENT_TEMPLATE_LOOKBACK = 6;
export function recentTemplateIdsFrom(catalogue) {
  return (catalogue?.sessions ?? [])
    .slice(0, RECENT_TEMPLATE_LOOKBACK)
    .map(s => s?.plan?.template_id ?? s?.template_id)
    .filter(Boolean);
}

// Equipment the athlete can toggle before generating (pre-session checkboxes).
const EQUIP_LABELS = {
  paddles: 'paddles', pull_buoy: 'pull buoy', bars: 'pull-up/dip bars',
  rings: 'gymnastic rings', weights: 'dumbbells/weights',
};
function prettyEquipment(list) { return list.map(k => EQUIP_LABELS[k] ?? k).join(', '); }

// One prompt line telling the LLM exactly what's on hand. `undefined` = caller
// didn't specify (leave the model free); an array (even empty) = honour it.
function equipmentInstruction(equipmentAvailable) {
  if (!Array.isArray(equipmentAvailable)) return '';
  if (equipmentAvailable.length === 0) {
    return 'No equipment available: plain swimming only (no paddles or pull buoy); any dryland must be bodyweight only.';
  }
  return `Available equipment: ${prettyEquipment(equipmentAvailable)}. Only prescribe equipment from this list. If pull buoy or paddles are not listed, write pull/drill sets as plain swimming. For a dryland session use only the listed apparatus (rings / bars / weights); if none are listed, bodyweight only.`;
}

// ──────────────────────────────────────────────────────────────────────────
// Prompt construction
// ──────────────────────────────────────────────────────────────────────────

const SESSION_CONTRACT = `Return ONLY JSON matching:
{
  "blocks": [
    { "name": string, "volume_m": number, "cue": string, "target": string|null, "archetype_id"?: string,
      "sets": [ { "reps": number, "distance_m": number, "effort": string, "rest_s": number, "rep_class": string, "drill"?: string, "breathing"?: string, "equipment"?: string } ] }
  ]
}
Rules: warm-up + main set + cool-down are required. **BLOCK NAMES ARE CHECKED LITERALLY:** the warm-up block's name must contain "warm", the primary work block's name must contain "main" (e.g. "Main Set — Sprints", "Main Set: 4×100 threshold"), and the cool-down block's name must contain "cool". You may still add extra descriptive blocks (drill, primer, sprint finish) — just don't name your main block something creative like "Sprint Power & Race Pace" without also including "Main". Every block MUST contain at least one real set (reps×distance) — never emit an empty block. Distances MUST add up exactly (each block.volume_m = sum of reps×distance; you will be rejected otherwise). Sprint/max reps need rest_s >= 120. Threshold reps over 400m need rest_s >= 30. For progressive-build sets, write effort as "build 70-100%" or "build" (or name the block "Primer") — those are exempt from the sprint-rest rule because only the last rep hits full effort. Never prescribe dolphin kick if a quad flag is active.

CONTINUOUS vs REPS — be unambiguous. A rest_s of 0 across multiple reps means the athlete never stops, which makes "4×50m with 0s rest" identical to a straight 200m swim — just written confusingly. So: if you mean a continuous swim, emit ONE rep of the total distance ("reps": 1, "distance_m": 200). Only split a continuous swim into reps when something genuinely varies per length — a breathing pattern ("breathing": "every-5") or an alternating drill — and even then the athlete does not stop at the wall. If you want the athlete to actually pause between reps, give a real rest_s of at least 10. Never emit multiple reps at rest_s 0 with no per-length instruction.

Coaching rules:
- Targets/cues must be stated as EFFORT (RPE / %/ "max") plus stroke-count and/or SWOLF — NEVER as /100m pace. The athlete's watch shows no live pace, so a pace target is useless mid-set.
- Vary the main-set STRUCTURE from the recent same-type sessions listed below — alternate broken 50s, descending 25s, ladders, etc. Do not reuse the previous same-type session's set shape.
- For a THRESHOLD session, rotate the main set across the camp (e.g. broken 300s/400s, descending 200s, or a 200/300/400 ladder) — do NOT default to 6×200 every time.
- In a SPRINT session, the main set must be true max/alactic sprint quality (short max reps with full rest) plus at most one race-style 50m effort, and vary the alactic backbone run-to-run (descending 25s, broken 50s, 25/50 mixes). Do NOT fill the sprint main set with threshold or steady pull work.`;

export function buildPrompt(decision, catalogue, targets, opts = {}) {
  const phase = catalogue?.training_phase?.current ?? 1;
  const rb = catalogue?.rolling_bests ?? {};
  const guidance = guidanceForFlags(decision.active_flags ?? []);
  const pending = catalogue?.pending_adjustments;
  const recent = (catalogue?.sessions ?? []).slice(0, 3)
    .map(s => `${s.date} ${s.type}/${s.subtype}`).join('; ');

  // The last few same-subtype MAIN SETS — fed back so the LLM can make THIS
  // session structurally different. Looking at only ONE prior session (the old
  // `.find()`) let the generator ping-pong A/B/A/B forever: it avoided the
  // immediately-previous shape by returning to the one before it. Three deep
  // makes genuine rotation the cheapest way to satisfy the constraint.
  const SAME_SUBTYPE_LOOKBACK = 3;
  const describeMain = (s) => {
    const main = s.plan.blocks.find(b => /main/i.test(b.name ?? ''));
    if (!main?.sets?.length) return null;
    const shape = main.sets.map(x => `${x.reps}×${x.distance_m}m${x.effort ? ' ' + x.effort : ''}`).join(' + ');
    return `${s.date}: ${shape}`;
  };
  const recentMains = (catalogue?.sessions ?? [])
    .filter(s => s.subtype === decision.subtype && Array.isArray(s.plan?.blocks))
    .slice(0, SAME_SUBTYPE_LOOKBACK)
    .map(describeMain)
    .filter(Boolean);
  const lastMainDesc = recentMains.length ? recentMains.join('\n  ') : null;

  // Recent athlete free-text notes — fed to the prompt so the LLM can honour
  // standing preferences and react to "this was too short rest" / cool-down
  // swaps / injury resolutions / etc. Capped to keep the prompt lean.
  const recentNotes = (catalogue?.sessions ?? [])
    .slice(0, 3)
    .filter(s => typeof s?.athlete_feedback === 'string' && s.athlete_feedback.trim().length)
    .map(s => `- ${s.date} (${s.subtype || s.type}): "${s.athlete_feedback.trim().slice(0, 320)}"`)
    .join('\n');

  const systemPrompt = [
    'You are an expert sprint-freestyle swim coach generating one training session.',
    'Effort is descriptive (%/RPE/"max") — the watch shows no live pace. Tone: direct, motivating, concise.',
    '',
    'SESSION-STRUCTURE RULES (violating these makes the session unusable):',
    '- In a SPRINT or RACE-PACE session, NEVER place a threshold or RPE 7+ aerobic block between two sprint sets. Threshold work in a sprint session pollutes the alactic main set with lactate. If aerobic work is needed, put it BEFORE the main set as a primer, or AFTER the sprint finish as a flush — not sandwiched between sprint blocks.',
    '- When setting stretch targets for sprint reps, cap the step from the rolling best at ~0.3s for 25m and ~0.5s for 50m. Do NOT prescribe a phase-pace target (e.g. "15.5s phase pace") more than ~0.5s below the rolling best in a single session — it reads as unattainable and demoralises the set.',
    '- Honour STANDING ATHLETE PREFERENCES extracted from recent notes (see "Recent athlete notes" below). If the athlete has modified the same block in their last two sessions (e.g. swapped the cool-down to 4×50 with 20s rest and a low-stroke focus), incorporate that into this session\'s prescription rather than repeating the unwanted version.',
    '- TARGET-LADDER FIDELITY: the deterministic core hands you one authoritative "Targets to embed" object per session with the exact numbers to use (beat_25m_s, stretch_25m_s, implied_50m_from_stretch_s, sprint_swolf_target, stroke_count_target, phase_25m_target_s, and for race_pace the beat_50m_s / stretch_50m_s / phase_50m_target_s). RESTATE those numbers verbatim in your cue and target lines — never invent, round, or re-derive them. In a sprint session prescribing 50m reps, the 50m target MUST be `implied_50m_from_stretch_s` (which reconciles with 2×stretch_25m_s − turn savings). Do NOT quote the phase_50m_target_s in a sprint session\'s 50m cue — that\'s the long-horizon aspiration, not the per-session prescription.',
    '- In a TECHNIQUE session during a sprint-priority phase (Phase 1), bias at least one main sub-set toward FAST, LOW-STROKE-COUNT 25s (speed-technique) rather than making the whole main set 100m aerobic pulling. Long aerobic pull sets belong in threshold sessions; technique in a sprint phase should train stroke-count discipline at speed.',
    '- REP-CLASS TAXONOMY: every set you emit MUST include a `rep_class` field from {max_alactic, speed_endurance, speed_technique, build_finish, aerobic, drill}. The rest you prescribe must satisfy that class\'s minimum: max_alactic ≥120s, speed_endurance 60–180s, speed_technique 45–60s, build_finish 60–90s, aerobic ≥15s, drill ≥15s. NEVER label a set "max" (max_alactic) unless you are also giving it full alactic recovery (≥120s). Threshold/aerobic sets are NOT max_alactic even if the reps are short.',
    '- COVER THE SPEED-ENDURANCE MIDDLE: the 50m freestyle is a ~30–35s effort, which is glycolytic — not purely alactic. A programme of only max 25s (alactic) plus threshold work leaves the event\'s actual energy system untrained, producing a fast 25 that dies in the back half. Across a block, at least one pool session\'s main set should be `speed_endurance` (race-pace 25s at goal tempo, broken 50s, 50s at ~1:4 work:rest, or a sprint pyramid).',
    '- ARCHETYPE SELECTION: choose ONE archetype from the menu below as the spine of the main set and echo its id in the main block\'s `archetype_id` field. Never pick one listed as already used in this rotation. Adapt rep counts to hit the volume band, but keep the architecture recognisable — a "broken 50s" that is really just 4×50 straight is not the archetype.',
    '- POST-LAYOFF RE-ENTRY: when the "Targets to embed" object has `re_entry: true` (>10 days since the last pool session, so today\'s numbers are de-rated by 2.5%), say so in the session cue ("re-entry session — first swim back in N days"), frame the targets as re-entry benchmarks (not PR attempts), and cap the sprint main set at 3–4 max reps rather than a full 8-rep block.',
    '- ANTI-REPETITION WITHIN A BLOCK: no two pool sessions of the same subtype in a single 4-session block may share the same main-set architecture. If the previous same-subtype session used pull-buoy 100s + fast 25s, the next one MUST use a different structure (descending stroke-count ladders, negative-split 50s, broken 100s, etc.). The "Your most recent MAIN SET was:" line tells you what to differ FROM.',
    '- EVERY SET MUST CARRY A `rep_class`. A plan with untagged sets is rejected — the analyser uses the tag to decide which reps are max efforts, and an untagged plan makes it fall back to guessing from split times (which mis-flagged a build-to-max finish as an under-rested max effort).',
    '- EQUIPMENT CAP IN TECHNIQUE SESSIONS: pull buoy, kickboard and paddle work together may not exceed 30% of prescribed volume. Assisted reps develop neither stroke count nor the wall push-off, and a technique session that is mostly buoy work is aerobic filler against a 50m sprint goal.',
    '- RETURN TO TRAINING: when the targets object has `illness_recent: true`, keep every set non-max, cap total volume near 70% of the phase range, and SAY in the session cue that this is a return-to-training session. Do not schedule a max-effort day off the back of an illness.',
    '- 48-HOUR RULE AFTER MAX WORK: when `hours_since_last_max_effort` is under 48, do not prescribe another max_alactic main set. Use technique, aerobic or speed-technique work instead and say why.',
    '- STATE THE 50m TARGET ONLY as the value in `implied_50m_from_stretch_s`. Never restate a 50m goal in prose that the 25m targets in this same session cannot produce.',
    '- SPRINT WARM-UP CAP: in a SPRINT session, keep the warm-up + priming to ≤30% of total prescribed volume. The majority of the session must be quality work. A 700m warm-up in a 1700m sprint session is 42% — too much.',
    opts.knowledge ? `\nDomain context:\n${opts.knowledge}` : '',
    `\n${SESSION_CONTRACT}`,
  ].join('\n');

  // Explicit archetype menu + the ones already used this rotation. Without a
  // named vocabulary the model kept converging on the same few shapes.
  const archetypeMenu = archetypeMenuText(
    decision.subtype, phase, recentArchetypeIds(catalogue, decision.subtype));

  const range = volumeTargetsForPhase(phase, decision.subtype) ?? POOL_VOLUME_TARGETS_M[decision.subtype];
  const volumeLine = range
    ? `Total volume MUST be between ${range.min} and ${range.max} metres (aim near the middle).`
    : 'Use a sensible total volume for the session type.';
  let sprintFinish = false;
  try { sprintFinish = phaseHasSprintFinish(phase); } catch { sprintFinish = false; }
  const structureLine = (decision.subtype === 'sprint' || decision.subtype === 'race_pace') && sprintFinish
    ? 'Include a dedicated Sprint Finish block (its name must contain "Sprint" or "Finish") in addition to the main set.'
    : '';

  const userPrompt = [
    `Generate a ${decision.subtype} ${decision.type} session for Phase ${phase}.`,
    `Block ${decision.block_number}, session ${decision.session_in_block}.`,
    volumeLine,
    structureLine,
    equipmentInstruction(opts.equipmentAvailable),
    `Rolling bests: best 25m sprint ${rb.best_25m_sprint_protocol_s}s, best SWOLF ${rb.best_avg_swolf}, sprint SWOLF ${rb.best_sprint_swolf}, threshold pace ${rb.best_threshold_pace_per_100m}/100m.`,
    `Targets to embed: ${JSON.stringify(targets)}.`,
    decision.active_flags?.length ? `ACTIVE INJURY FLAGS: ${decision.active_flags.join(', ')}.\nFlag guidance:\n${guidance}` : 'No active injury flags.',
    pending ? `Recent feedback adjustments to honour: ${JSON.stringify({ intensity: pending.intensity, volume: pending.volume, recovery_tilt: pending.recovery_tilt, technique_focus: pending.technique_focus })}.` : '',
    recent ? `Recent sessions (avoid repeating the last 2 main-set structures): ${recent}.` : '',
    lastMainDesc ? `Your last ${recentMains.length} ${decision.subtype} MAIN SET(s), newest first:\n  ${lastMainDesc}\nMake THIS session's main set structurally DIFFERENT from ALL of them — not just the newest. Returning to the shape from two sessions ago still counts as repeating.` : '',
    archetypeMenu,
    recentNotes ? `Recent athlete notes (honour standing preferences; react to injury updates):\n${recentNotes}` : '',
  ].filter(Boolean).join('\n');

  return { systemPrompt, userPrompt };
}

// Merge LLM-provided blocks with deterministic, non-negotiable metadata.
// Volumes are RECOMPUTED from the sets — the LLM's stated volume_m/total are
// display numbers it sometimes gets slightly wrong; the sets are the real
// prescription. This auto-repair stops a cosmetic arithmetic slip from sinking
// an otherwise-valid session. Rest/structure/flag safety is still validated.
function assembleLlmSession(parsedJson, decision, catalogue, targets, date) {
  const rawBlocks = Array.isArray(parsedJson?.blocks) ? parsedJson.blocks : [];
  const blocks = rawBlocks.map(b => {
    const sets = Array.isArray(b.sets) ? b.sets : [];
    const volume_m = sets.reduce((s, x) => s + (Number(x.reps) || 0) * (Number(x.distance_m) || 0), 0);
    return { ...b, volume_m };
  });
  const total = blocks.reduce((s, b) => s + b.volume_m, 0);
  // Archetype the LLM declared on the main block — recorded so the next
  // generation can rotate off it. Only accept ids we actually know; a
  // hallucinated id would poison the rotation rather than help it.
  const declared = blocks.map(b => b.archetype_id).find(Boolean) ?? null;
  const archetype_id = declared && archetypeById(declared) ? declared : null;
  return {
    date,
    type: decision.type,
    subtype: decision.subtype,           // deterministic — not the LLM's call
    archetype_id,
    phase: catalogue?.training_phase?.current ?? 1,
    block_number: decision.block_number,
    session_in_block: decision.session_in_block,
    total_volume_m: total,
    blocks,
    targets,
    active_flags: decision.active_flags ?? [],
    source: 'app_generated',
    generator: 'llm',
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {object} catalogue
 * @param {object} [opts]
 *   - apiKey, model, knowledge (KB text)
 *   - callGeminiFn (inject; defaults to callGemini), fetchFn, isOnline
 *   - date, recentTemplateIds, forceFallback
 *   - explicit_type / explicit_subtype (athlete override → block-state)
 * @returns {Promise<object>} structured result
 */
export async function generateSession(catalogue, opts = {}) {
  const date = opts.date ?? today();
  const decision = determineNextSession(catalogue, {
    explicit_type: opts.explicit_type,
    explicit_subtype: opts.explicit_subtype,
  });
  const targets = computeTargets(catalogue, decision.subtype, { date });
  const callFn = opts.callGeminiFn ?? callGemini;

  const result = (extra) => ({ decision, targets, ...extra });

  // Dryland → deterministic library always. The library's dryland templates are
  // concrete and equipment-aware; the LLM JSON contract is pool-shaped (sets of
  // distance), so routing dryland through it produced empty, contentless plans.
  if (decision.type === 'dryland') {
    return result(fallback(decision, catalogue, targets, opts, {
      reason: 'dryland_library',
      message: 'Dryland sessions use the equipment-aware template library.',
    }));
  }

  // No LLM configured → straight to fallback (not an error).
  if (!opts.apiKey || opts.forceFallback) {
    return result(fallback(decision, catalogue, targets, opts, {
      reason: 'no_llm',
      message: 'No LLM configured — using the session template library.',
    }));
  }

  // Try the LLM (initial + 2 corrections = 3 attempts).
  const { systemPrompt, userPrompt } = buildPrompt(decision, catalogue, targets, opts);
  const MAX_ATTEMPTS = 3;
  let lastErrors = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt = attempt === 1
      ? userPrompt
      : `${userPrompt}\n\nYour previous attempt failed validation with these errors — fix them exactly:\n- ${lastErrors.join('\n- ')}`;

    const res = await callFn({
      apiKey: opts.apiKey, model: opts.model, systemPrompt, userPrompt: prompt,
      // Generation IS schema-validated, so temperature trades variety against
      // retry/fallback rate. Raised 0.5 → 0.65 now that the archetype menu
      // constrains STRUCTURE explicitly — variety no longer has to come from
      // sampling noise. Retries drop back to 0.5 so a correction attempt is
      // more literal about fixing the named errors.
      temperature: attempt === 1 ? 0.65 : 0.5,
      fetchFn: opts.fetchFn, isOnline: opts.isOnline,
    });

    if (!res.ok) {
      // LLM unavailable → fall back with the categorised reason + retry info.
      const e = res.error ?? {};
      return result(fallback(decision, catalogue, targets, opts, {
        reason: e.kind ?? 'api_error',
        retry_after_seconds: e.retry_after_seconds ?? null,
        retry_after_iso: e.retry_after_iso ?? null,
        message: e.message ?? 'LLM unavailable — using the template library.',
      }));
    }

    let parsed;
    try { parsed = JSON.parse(res.text); }
    catch { lastErrors = ['Response was not valid JSON.']; continue; }

    const session = assembleLlmSession(parsed, decision, catalogue, targets, date);
    const v = validateGeneratedSession(session, { activeFlags: decision.active_flags });
    if (v.valid) {
      return result({
        status: 'success', source: 'llm', fallback_reason: null,
        retry_after_seconds: null, retry_after_iso: null,
        message: 'Session generated by Gemini.',
        session, validation: { errors: v.errors, warnings: v.warnings },
      });
    }
    lastErrors = v.errors;
  }

  // Both LLM attempts failed validation → fall back.
  return result(fallback(decision, catalogue, targets, opts, {
    reason: 'validation_failed',
    message: `Gemini output failed validation twice — using the template library. (${(lastErrors ?? []).length} error(s))`,
  }));
}

function fallback(decision, catalogue, targets, opts, meta) {
  const { session } = buildFallbackSession(decision, catalogue, {
    date: opts.date ?? today(),
    recentTemplateIds: opts.recentTemplateIds ?? recentTemplateIdsFrom(catalogue),
    equipment: opts.equipment,
    equipmentAvailable: opts.equipmentAvailable,
  });
  const v = validateGeneratedSession(session, { activeFlags: decision.active_flags });
  return {
    status: 'fallback',
    source: 'library',
    fallback_reason: meta.reason,
    retry_after_seconds: meta.retry_after_seconds ?? null,
    retry_after_iso: meta.retry_after_iso ?? null,
    message: meta.message,
    session,
    validation: { errors: v.errors, warnings: v.warnings },
  };
}
