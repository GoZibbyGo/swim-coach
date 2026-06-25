import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { logSession, resolveFlag } from '../src/catalogue-writer.js';
import { parseGarminCsv } from '../src/garmin-parser.js';
import { determineNextSession } from '../src/block-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = join(__dirname, '..', 'fixtures', 'activity_22919208781.csv');
const realCsv = existsSync(csvPath) ? readFileSync(csvPath, 'utf8') : null;

function baseCat(overrides = {}) {
  return {
    training_phase: { current: 1, phase_goals: { swolf_target: 30, best_25m_target_s: 14, best_50m_target_s: 30 } },
    rolling_bests: {
      best_25m_sprint_protocol_s: 16.8, best_25m_split_s: 16.1,
      best_avg_swolf: 31, best_sprint_swolf: 24,
      best_threshold_pace_per_100m: '1:36', best_50m_equiv_s: 38.0,
    },
    weekly_block_tracking: { current_block_number: 2, current_block_pool_count: 1, current_block_dryland_count: 1 },
    sessions: [],
    ...overrides,
  };
}

function syntheticPool(best25) {
  return { summary: { best_25m_split_s: best25, best_25m_context: 'INT 9.1', total_distance_m: 1600, avg_swolf: 31 }, intervals: [], lengths: [], glitches: [] };
}

// ──────────────────────────────────────────────────────────────────────────

test('logs a pool session: assigns id, increments pool count, adds record', () => {
  const { catalogue, session } = logSession(baseCat(), { type: 'pool', date: '2026-05-20', parsed: syntheticPool(17.0), subtype: 'sprint' });
  assert.equal(session.id, 1);
  assert.equal(catalogue.weekly_block_tracking.current_block_pool_count, 2);
  assert.equal(catalogue.sessions[0].id, 1);
  assert.equal(session.metrics.best_25m_split_s, 17.0);
});

test('updates rolling_bests on a new sprint PR', () => {
  const { catalogue, records } = logSession(baseCat(), { type: 'pool', date: '2026-05-20', parsed: syntheticPool(15.9), subtype: 'sprint' });
  assert.equal(records.best_25m_sprint_protocol_s, 15.9);
  assert.equal(catalogue.rolling_bests.best_25m_sprint_protocol_s, 15.9);
  assert.equal(catalogue.rolling_bests.best_25m_sprint_protocol_session_id, 1);
  assert.equal(catalogue.rolling_bests.best_25m_split_s, 15.9); // also a raw best
});

test('rolls over the block when it completes (3 pool + 1 dryland)', () => {
  const cat = baseCat({ weekly_block_tracking: { current_block_number: 2, current_block_pool_count: 2, current_block_dryland_count: 1 } });
  const { catalogue } = logSession(cat, { type: 'pool', date: '2026-05-20', parsed: syntheticPool(17.0), subtype: 'sprint' });
  const t = catalogue.weekly_block_tracking;
  assert.equal(t.current_block_number, 3);
  assert.equal(t.current_block_pool_count, 0);
  assert.equal(t.current_block_dryland_count, 0);
  assert.equal(t.last_completed_block, 2);
});

test('external session: marks source, sets plan advisory, infers subtype', { skip: !realCsv }, () => {
  const parsed = parseGarminCsv(realCsv);
  const { catalogue, session, subtype_inference } = logSession(baseCat(), {
    type: 'pool', date: '2026-05-20', parsed, source: 'external',
  });
  assert.equal(session.source, 'external');
  assert.equal(session.subtype, 'threshold'); // inferred
  assert.equal(subtype_inference.subtype, 'threshold');
  assert.equal(catalogue.weekly_block_tracking.current_block_plan_advisory, true);
  assert.match(session.notes, /External session/);
});

test('feedback text activates a flag and sets pending adjustments', () => {
  const { catalogue, signals } = logSession(baseCat(), {
    type: 'pool', date: '2026-05-20', parsed: syntheticPool(17.5), subtype: 'threshold',
    feedbackText: 'left quad cramped on the last rep, felt exhausted',
  });
  assert.ok(catalogue.active_flags.left_quad_cramp);
  assert.equal(catalogue.active_flags.left_quad_cramp.sessions_since, 0);
  assert.equal(signals.recovery_tilt, true);
  assert.equal(catalogue.pending_adjustments.recovery_tilt, true);
  assert.equal(catalogue.pending_adjustments.intensity, 'hold');
});

test('active flags become removal candidates (not auto-deleted), then resolveFlag clears them', () => {
  // left_quad_cramp decays after 3 symptom-free sessions.
  let cat = baseCat();
  cat = logSession(cat, { type: 'pool', parsed: syntheticPool(17.5), subtype: 'threshold', feedbackText: 'left quad cramped' }).catalogue;
  assert.ok(cat.active_flags.left_quad_cramp);

  // Subsequent symptom-free sessions; the flag stays ACTIVE until decay, then
  // becomes a removal candidate surfaced via expiring_flags.
  let expiredReport = [];
  for (let i = 0; i < 3; i++) {
    const r = logSession(cat, { type: 'pool', parsed: syntheticPool(17.5), subtype: 'technique' });
    cat = r.catalogue;
    expiredReport = r.expiring_flags;
  }
  // Still present (not silently deleted), now flagged pending_clear.
  assert.ok(cat.active_flags.left_quad_cramp);
  assert.equal(cat.active_flags.left_quad_cramp.pending_clear, true);
  assert.ok(expiredReport.includes('left_quad_cramp'));

  // Athlete confirms removal.
  cat = resolveFlag(cat, 'left_quad_cramp', 'remove');
  assert.equal(cat.active_flags.left_quad_cramp, undefined);
});

test('a recurrence resets a flag and drops pending_clear', () => {
  let cat = baseCat();
  cat = logSession(cat, { type: 'pool', parsed: syntheticPool(17.5), subtype: 'threshold', feedbackText: 'left quad cramped' }).catalogue;
  // age it to pending_clear
  for (let i = 0; i < 3; i++) cat = logSession(cat, { type: 'pool', parsed: syntheticPool(17.5), subtype: 'technique' }).catalogue;
  assert.equal(cat.active_flags.left_quad_cramp.pending_clear, true);
  // recurs → reset
  cat = logSession(cat, { type: 'pool', parsed: syntheticPool(17.5), subtype: 'sprint', feedbackText: 'left quad cramped again' }).catalogue;
  assert.equal(cat.active_flags.left_quad_cramp.pending_clear, false);
  assert.equal(cat.active_flags.left_quad_cramp.sessions_since, 0);
});

test('athlete "quad resolved" note lifts the quad flag immediately (no decay wait)', () => {
  let cat = baseCat();
  cat = logSession(cat, { type: 'pool', parsed: syntheticPool(17.5), subtype: 'threshold', feedbackText: 'left quad cramped' }).catalogue;
  assert.ok(cat.active_flags.left_quad_cramp, 'flag should be active after the cramp');
  // Next session — athlete reports the quad is fine. Should clear immediately,
  // not wait the 3-session decay window.
  cat = logSession(cat, { type: 'pool', parsed: syntheticPool(17.5), subtype: 'technique', feedbackText: 'quad cramps were no longer a problem' }).catalogue;
  assert.equal(cat.active_flags.left_quad_cramp, undefined);
});

test('coach_flags renders athlete notes as readable text, never a raw "Feedback: <token>" tag', () => {
  const { catalogue } = logSession(baseCat(), {
    type: 'pool', parsed: syntheticPool(17.5), subtype: 'sprint',
    feedbackText: 'really enjoyed it', // matches the `motivated` signal (note: true)
  });
  const s = catalogue.sessions[0];
  // No raw internal token like "Feedback: motivated" — readable prose only.
  assert.ok(!s.coach_flags.some(f => /^Feedback: [a-z_]+$/.test(f)),
    `expected no raw token tags, got: ${JSON.stringify(s.coach_flags)}`);
  // The note IS surfaced, just in readable form.
  assert.ok(s.coach_flags.some(f => /Athlete note:.*motivated/.test(f)),
    `expected "Athlete note: motivated.", got: ${JSON.stringify(s.coach_flags)}`);
});

test('"PR" in the athlete note no longer leaks "Feedback: claimed_pr"', () => {
  const { catalogue } = logSession(baseCat(), {
    type: 'pool', parsed: syntheticPool(17.5), subtype: 'sprint',
    feedbackText: 'felt like a PR attempt',
  });
  assert.ok(!catalogue.sessions[0].coach_flags.some(f => /claimed_pr/.test(f)),
    `claimed_pr should be suppressed (engine handles PRs), got: ${JSON.stringify(catalogue.sessions[0].coach_flags)}`);
});

test('feedback can create a NEW flag in the same log where another expires', () => {
  let cat = baseCat();
  cat = logSession(cat, { type: 'pool', parsed: syntheticPool(17.5), subtype: 'threshold', feedbackText: 'left quad cramped' }).catalogue;
  for (let i = 0; i < 2; i++) cat = logSession(cat, { type: 'pool', parsed: syntheticPool(17.5), subtype: 'technique' }).catalogue;
  // 3rd symptom-free session ALSO reports a new shoulder issue.
  const r = logSession(cat, { type: 'pool', parsed: syntheticPool(17.5), subtype: 'sprint', feedbackText: 'sore shoulder today' });
  assert.ok(r.expiring_flags.includes('left_quad_cramp')); // old one expiring
  assert.ok(r.catalogue.active_flags.shoulder_discomfort);   // new one created
});

test('equipment feedback sets the block dryland equipment', () => {
  const { catalogue } = logSession(baseCat(), {
    type: 'dryland', date: '2026-05-20', dryland: { exercises: [{ name: 'Pull-ups', sets: 4 }] },
    feedbackText: 'only had rings today',
  });
  const t = catalogue.weekly_block_tracking;
  assert.equal(t[`block_${t.current_block_number}_dryland_equipment`], 'rings');
  assert.equal(t.current_block_dryland_count, 2);
});

test('external session influences the next internal subtype (performance + balance)', () => {
  // Log an EXTERNAL sprint session; performance is pulled and the next
  // internal session must avoid repeating sprint (anti-repetition reads it).
  const cat = baseCat({ weekly_block_tracking: { current_block_number: 3, current_block_pool_count: 0, current_block_dryland_count: 0 } });
  const r = logSession(cat, { type: 'pool', date: '2026-05-20', parsed: syntheticPool(16.5), subtype: 'sprint', source: 'external' });
  // Performance pulled: 16.5 beats the sprint best → record updated.
  assert.equal(r.catalogue.rolling_bests.best_25m_sprint_protocol_s, 16.5);
  // Plan went advisory; next internal session is decided by phase priority +
  // anti-repetition — and must not be sprint (just done externally).
  assert.equal(r.catalogue.weekly_block_tracking.current_block_plan_advisory, true);
  const next = determineNextSession(r.catalogue);
  assert.notEqual(next.subtype, 'sprint');
});

test('phase advances after the phase block quota is completed', () => {
  // Phase 1 needs 6 blocks; sitting at 5, and this log completes block 6.
  const cat = baseCat({
    training_phase: { current: 1, blocks_in_phase: 5 },
    weekly_block_tracking: { current_block_number: 6, current_block_pool_count: 2, current_block_dryland_count: 1 },
  });
  const r = logSession(cat, { type: 'pool', date: '2026-06-01', parsed: syntheticPool(17.0), subtype: 'sprint' });
  assert.equal(r.catalogue.training_phase.current, 2);          // advanced
  assert.equal(r.catalogue.training_phase.blocks_in_phase, 0);  // reset
  assert.ok(r.phase_advancement);
  assert.ok(r.flags.some(f => /PHASE ADVANCED/.test(f)));
});

test('phase does NOT advance mid-quota', () => {
  const cat = baseCat({
    training_phase: { current: 1, blocks_in_phase: 2 },
    weekly_block_tracking: { current_block_number: 3, current_block_pool_count: 2, current_block_dryland_count: 1 },
  });
  const r = logSession(cat, { type: 'pool', date: '2026-05-25', parsed: syntheticPool(17.0), subtype: 'sprint' });
  assert.equal(r.catalogue.training_phase.current, 1);
  assert.equal(r.catalogue.training_phase.blocks_in_phase, 3); // ticked, not advanced
  assert.equal(r.phase_advancement, null);
});

test('does not mutate the input catalogue', () => {
  const cat = baseCat();
  const before = JSON.stringify(cat);
  logSession(cat, { type: 'pool', parsed: syntheticPool(15.0), subtype: 'sprint' });
  assert.equal(JSON.stringify(cat), before);
});
