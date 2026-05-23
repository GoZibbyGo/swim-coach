// Block-state engine — decides what the next session should be.
//
// A "block" = 3 pool sessions + 1 dryland session, completed in any order.
// Blocks do NOT reset on calendar days — they roll over when all 4 sessions
// are fulfilled.
//
// This module is pure logic. It reads the catalogue, applies the rules from
// SKILL_session_generator.md (Phase 1), and returns the next session's
// type/subtype plus the rationale. It does NOT generate the session content
// itself — that's the orchestrator's job downstream.
//
// Phase 2 and Phase 3 are intentionally stubbed: callers asking for a
// Phase 2/3 decision get a structured error rather than a silently-wrong
// session.

import { drylandSlotForBlock, POOL_SUBTYPES, BLOCK_TARGET } from './schema.js';
import { phasePriority } from './phases.js';

// Pool subtype priority by phase now lives in phases.js (single source of
// truth). All three phases are defined there.
function resolvePhasePriority(phaseNumber) {
  return phasePriority(phaseNumber);
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function currentBlockNumber(catalogue) {
  return catalogue?.weekly_block_tracking?.current_block_number ?? 1;
}

function currentBlockPlan(catalogue) {
  const blockN = currentBlockNumber(catalogue);
  const key = `block_${blockN}_plan`;
  const plan = catalogue?.weekly_block_tracking?.[key];
  return Array.isArray(plan) ? plan : null;
}

function blockCounts(catalogue) {
  const t = catalogue?.weekly_block_tracking ?? {};
  return {
    pool: t.current_block_pool_count ?? 0,
    dryland: t.current_block_dryland_count ?? 0,
  };
}

function isBlockComplete(counts) {
  return counts.pool >= BLOCK_TARGET.pool && counts.dryland >= BLOCK_TARGET.dryland;
}

// Recent sessions of a given type, most-recent-first (catalogue order is
// already most-recent-first, so we just filter).
function recentSessionsOfType(catalogue, type, limit) {
  const all = (catalogue?.sessions ?? []).filter(s => s?.type === type);
  return all.slice(0, limit);
}

function recentSubtypes(catalogue, type, count) {
  return recentSessionsOfType(catalogue, type, count).map(s => s?.subtype).filter(Boolean);
}

function activeFlags(catalogue) {
  // Prefer the explicit active_flags map maintained by the catalogue writer
  // (it applies decay rules). Fall back to scanning recent sessions for
  // legacy catalogues that predate the writer.
  const explicit = catalogue?.active_flags;
  if (explicit && typeof explicit === 'object' && Object.keys(explicit).length) {
    return Object.keys(explicit);
  }
  // Pull active injury/condition flags from the most recent session(s).
  // A flag is "active" if it appears in the latest session's injury_flags
  // or coach_notes.immediate_priorities mentions a flag keyword.
  const flags = new Set();
  const sessions = catalogue?.sessions ?? [];
  if (sessions.length > 0 && sessions[0].injury_flags) {
    for (const key of Object.keys(sessions[0].injury_flags)) flags.add(key);
  }
  // Also pull from the second-most-recent if it's within 7 days — handles
  // cases where a flag was raised in session N-1 but session N (e.g. light
  // technique) didn't re-record it.
  if (sessions.length > 1 && sessions[1]?.injury_flags) {
    const daysAgo = daysBetween(sessions[1].date, sessions[0].date);
    if (daysAgo != null && daysAgo <= 7) {
      for (const key of Object.keys(sessions[1].injury_flags)) flags.add(key);
    }
  }
  return [...flags];
}

function daysBetween(isoA, isoB) {
  if (typeof isoA !== 'string' || typeof isoB !== 'string') return null;
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(Math.abs(b - a) / 86400000);
}

// ──────────────────────────────────────────────────────────────────────────
// Subtype selection (pool)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pick a pool subtype using PRIORITY-WEIGHTED FREQUENCY + no immediate repeat.
 *
 * Higher-priority subtypes (Phase 1: Sprint > Technique > Threshold) recur more
 * often than lower-priority ones, but never back-to-back, and lower-priority
 * subtypes still surface periodically. Score = priority_weight / (recent_count
 * + 1) over a sliding window; the highest score wins, ties break by priority.
 * This replaced a plain "exclude the last 2" rule, which forced every subtype to
 * appear equally often (threshold as frequent as sprint).
 */
function pickPoolSubtype(catalogue, phaseNumber, override = null) {
  const priority = resolvePhasePriority(phaseNumber);
  const window = recentSubtypes(catalogue, 'pool', priority.length * 2); // sliding window
  const last1 = window[0] ?? null;

  if (override) {
    return {
      subtype: override,
      reason: `Athlete override: ${override}.`,
      anti_repetition_warning: last1 === override
        ? `Repeats the immediately previous pool session (${last1}).`
        : null,
    };
  }

  const weight = {};
  priority.forEach((s, i) => { weight[s] = priority.length - i; }); // sprint=3, technique=2, threshold=1
  const count = {};
  for (const s of window) count[s] = (count[s] ?? 0) + 1;

  // Candidates: phase subtypes except the immediately previous one. (If the
  // phase defines only one subtype, allow the repeat.)
  const candidates = priority.filter(s => s !== last1);
  const pool = candidates.length ? candidates : priority;

  let best = pool[0];
  let bestScore = -Infinity;
  for (const s of pool) {                 // iterated in priority order → ties favour higher priority
    const score = weight[s] / ((count[s] ?? 0) + 1);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return {
    subtype: best,
    reason: `Phase ${phaseNumber} priority-weighted pick (favours ${priority[0]}), not repeating the previous session${window.length ? ` (recent: ${window.slice(0, 3).join(', ')})` : ''}.`,
    anti_repetition_warning: best === last1 ? `Repeats subtype "${best}" (only one subtype available this phase).` : null,
  };
}

// Dryland subtype rotation — alternate the two complementary dryland families
// (pull-focused vs press/legs/core) so consecutive blocks' dryland sessions
// differ instead of repeating the same plan.
const DRYLAND_ROTATION = ['pulling_strength', 'push_core_legs'];
function pickDrylandSubtype(catalogue) {
  const lastDry = (catalogue?.sessions ?? []).find(s => s?.type === 'dryland')?.subtype;
  return DRYLAND_ROTATION.find(s => s !== lastDry) ?? DRYLAND_ROTATION[0];
}

// ──────────────────────────────────────────────────────────────────────────
// Main decision function
// ──────────────────────────────────────────────────────────────────────────

/**
 * Determine the next session's type and subtype.
 *
 * @param {object} catalogue - the full athlete catalogue
 * @param {object} [opts]
 * @param {string} [opts.explicit_type] - athlete request: 'pool' | 'dryland'
 * @param {string} [opts.explicit_subtype] - athlete request: 'sprint' | etc.
 * @returns {object} decision
 */
export function determineNextSession(catalogue, opts = {}) {
  const phase = catalogue?.training_phase?.current ?? 1;
  resolvePhasePriority(phase); // throw early if phase is unsupported

  const blockN = currentBlockNumber(catalogue);
  const counts = blockCounts(catalogue);
  const plan = currentBlockPlan(catalogue);
  const flags = activeFlags(catalogue);

  // ── Case 1: block is complete → start a new block ─────────────────────
  if (isBlockComplete(counts)) {
    const newBlockN = blockN + 1;
    const drySlot = drylandSlotForBlock(newBlockN);
    const subtypeChoice = pickPoolSubtype(catalogue, phase, opts.explicit_subtype);

    return {
      type: opts.explicit_type === 'dryland' ? 'dryland' : 'pool',
      subtype: opts.explicit_type === 'dryland'
        ? (opts.explicit_subtype ?? pickDrylandSubtype(catalogue))
        : subtypeChoice.subtype,
      block_number: newBlockN,
      session_in_block: 1,
      is_new_block: true,
      dryland_slot: drySlot,
      block_plan: null,
      rationale: [
        `Block ${blockN} complete (${counts.pool}/${BLOCK_TARGET.pool} pool + ${counts.dryland}/${BLOCK_TARGET.dryland} dryland).`,
        `Starting Block ${newBlockN}.`,
        opts.explicit_type === 'dryland'
          ? `Athlete requested dryland to start the block.`
          : subtypeChoice.reason,
      ].join(' '),
      active_flags: flags,
      anti_repetition_warning: subtypeChoice.anti_repetition_warning,
    };
  }

  // ── Case 2: explicit block plan exists → follow it ────────────────────
  // ...unless the plan has gone advisory. A plan goes advisory once an
  // external (non-app-generated) session has been logged into the block, or
  // the catalogue writer flags divergence — at which point a rigid 4-slot
  // sequence no longer reflects reality and we fall through to phase-priority
  // scheduling (which still guarantees the 3:1 split via the rotating slot).
  const planAdvisory = catalogue?.weekly_block_tracking?.current_block_plan_advisory === true;
  if (plan && !planAdvisory) {
    const sessionInBlock = counts.pool + counts.dryland + 1;
    const planned = plan.find(p => p.session === sessionInBlock);
    if (planned && planned.status !== 'completed') {
      // Honor explicit_type/subtype override but flag the deviation.
      const usingOverride = !!(opts.explicit_type || opts.explicit_subtype);
      const type = opts.explicit_type ?? planned.type;
      const subtype = opts.explicit_subtype ?? planned.subtype;
      return {
        type,
        subtype,
        block_number: blockN,
        session_in_block: sessionInBlock,
        is_new_block: false,
        dryland_slot: drylandSlotForBlock(blockN),
        block_plan: plan,
        rationale: usingOverride
          ? `Block ${blockN} plan says session ${sessionInBlock} should be ${planned.type}/${planned.subtype}, but athlete overrode to ${type}/${subtype}.`
          : `Following Block ${blockN} plan: session ${sessionInBlock} = ${type}/${subtype}.`,
        active_flags: flags,
        anti_repetition_warning: null,
        deviates_from_plan: usingOverride,
      };
    }
  }

  // ── Case 3: no plan → schedule by the rotating dryland slot ───────────
  // Dryland falls on the slot given by block_number % 4 (option 1). When the
  // athlete is sitting on that slot and dryland is still due, dryland is the
  // pick. As a safety net, if the pool quota is already full, force dryland
  // regardless of slot (the block can't complete otherwise).
  const drySlot = drylandSlotForBlock(blockN);
  const sessionInBlock = counts.pool + counts.dryland + 1;
  const drylandDue = counts.dryland < BLOCK_TARGET.dryland;
  const poolDue = counts.pool < BLOCK_TARGET.pool;

  // Whether the rotating rule wants dryland this session. Guard the block
  // boundary: if the previous session was dryland and pool is still due, defer
  // dryland (otherwise a block that closes on dryland can open the next block on
  // dryland too — two dryland days back to back). The !poolDue safety net below
  // still guarantees the block gets its dryland.
  const lastWasDryland = (catalogue?.sessions?.[0]?.type) === 'dryland';
  const slotWantsDryland = drylandDue && (sessionInBlock === drySlot || !poolDue) && !(lastWasDryland && poolDue);

  // Athlete explicitly asked for a type → honour it.
  if (opts.explicit_type === 'dryland') {
    return {
      type: 'dryland',
      subtype: opts.explicit_subtype ?? pickDrylandSubtype(catalogue),
      block_number: blockN,
      session_in_block: sessionInBlock,
      is_new_block: false,
      dryland_slot: drySlot,
      block_plan: null,
      rationale: `Athlete requested dryland mid-block.`,
      active_flags: flags,
      anti_repetition_warning: null,
    };
  }
  if (opts.explicit_type === 'pool') {
    const subtypeChoice = pickPoolSubtype(catalogue, phase, opts.explicit_subtype);
    return {
      type: 'pool',
      subtype: subtypeChoice.subtype,
      block_number: blockN,
      session_in_block: sessionInBlock,
      is_new_block: false,
      dryland_slot: drySlot,
      block_plan: null,
      rationale: [
        subtypeChoice.reason,
        slotWantsDryland
          ? `Note: dryland slot is session ${drySlot} this block — athlete chose pool instead.`
          : null,
      ].filter(Boolean).join(' '),
      active_flags: flags,
      anti_repetition_warning: subtypeChoice.anti_repetition_warning,
      dryland_still_due: drylandDue,
    };
  }

  // No override → follow the rotating rule.
  if (slotWantsDryland) {
    return {
      type: 'dryland',
      subtype: opts.explicit_subtype ?? pickDrylandSubtype(catalogue),
      block_number: blockN,
      session_in_block: sessionInBlock,
      is_new_block: false,
      dryland_slot: drySlot,
      block_plan: null,
      rationale: poolDue
        ? `Dryland slot this block is session ${drySlot} (block ${blockN} % 4) — this is session ${sessionInBlock}.`
        : `Pool quota met (${counts.pool}/${BLOCK_TARGET.pool}); dryland is the only remaining session in Block ${blockN}.`,
      active_flags: flags,
      anti_repetition_warning: null,
    };
  }

  // Otherwise pool — pick subtype by phase priority + anti-repetition.
  const subtypeChoice = pickPoolSubtype(catalogue, phase, opts.explicit_subtype);
  return {
    type: 'pool',
    subtype: subtypeChoice.subtype,
    block_number: blockN,
    session_in_block: sessionInBlock,
    is_new_block: false,
    dryland_slot: drySlot,
    block_plan: null,
    rationale: [
      subtypeChoice.reason,
      drylandDue
        ? `Dryland (${counts.dryland}/${BLOCK_TARGET.dryland}) due on session ${drySlot} this block.`
        : null,
    ].filter(Boolean).join(' '),
    active_flags: flags,
    anti_repetition_warning: subtypeChoice.anti_repetition_warning,
    dryland_still_due: drylandDue,
  };
}

// Exposed for tests + downstream engines that need just the subtype choice.
export { pickPoolSubtype, activeFlags, recentSubtypes, isBlockComplete };
