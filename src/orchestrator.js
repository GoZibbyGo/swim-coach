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

function today() { return new Date().toISOString().slice(0, 10); }

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
    { "name": string, "volume_m": number, "cue": string, "target": string|null,
      "sets": [ { "reps": number, "distance_m": number, "effort": string, "rest_s": number, "drill"?: string, "breathing"?: string } ] }
  ]
}
Rules: warm-up + main set + cool-down are required. Every block MUST contain at least one real set (reps×distance) — never emit an empty block. Distances MUST add up exactly (each block.volume_m = sum of reps×distance; you will be rejected otherwise). Sprint/max reps need rest_s >= 120. Threshold reps over 400m need rest_s >= 30. Never prescribe dolphin kick if a quad flag is active.

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

  // The most recent same-subtype session's prescribed main set — fed back so the
  // LLM can make THIS session structurally different (not the same 6×200 twice).
  const lastSame = (catalogue?.sessions ?? []).find(s => s.subtype === decision.subtype && Array.isArray(s.plan?.blocks));
  const lastMain = lastSame && lastSame.plan.blocks.find(b => /main/i.test(b.name ?? ''));
  const lastMainDesc = lastMain?.sets?.length
    ? lastMain.sets.map(s => `${s.reps}×${s.distance_m}m${s.effort ? ' ' + s.effort : ''}`).join(' + ')
    : null;

  const systemPrompt = [
    'You are an expert sprint-freestyle swim coach generating one training session.',
    'Effort is descriptive (%/RPE/"max") — the watch shows no live pace. Tone: direct, motivating, concise.',
    opts.knowledge ? `\nDomain context:\n${opts.knowledge}` : '',
    `\n${SESSION_CONTRACT}`,
  ].join('\n');

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
    lastMainDesc ? `Your most recent ${decision.subtype} MAIN SET was: ${lastMainDesc}. Make THIS session's main set structurally DIFFERENT (different rep length/shape) — do NOT repeat it.` : '',
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
  return {
    date,
    type: decision.type,
    subtype: decision.subtype,           // deterministic — not the LLM's call
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
  const targets = computeTargets(catalogue, decision.subtype);
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
      temperature: 0.5,
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
    recentTemplateIds: opts.recentTemplateIds ?? [],
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
