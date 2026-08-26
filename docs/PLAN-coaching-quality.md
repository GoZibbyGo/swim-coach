# Coaching-quality overhaul — multi-session plan (opened 2026-08-26)

**Read this before starting any of the three workstreams.** It records the *diagnosis*
(already done, don't re-derive it — that's the expensive part) and chunks the work so any
session can pick up the next unit without re-reading the whole codebase.

**Status legend:** ☐ not started · ◐ in progress · ☑ shipped (note the version)

---

## 0. Where this came from

User request (2026-08-26), three tasks:

1. Fix four recurring feedback defects: (a) misreads actual CSV splits against the session
   plan, (b) subtly restates/alters the plan in the debrief, (c) obsesses over the L1-vs-L2
   gap — which is just dead-stop-start physics, (d) lack of creativity lately.
2. Research what would make the app more responsive to performance + feedback — session
   *structure* (kick work, block/start work, pyramids, paced sets) and feedback quality.
3. Make the Gemini layer more responsive and realistic.

---

## 1. Diagnosis (COMPLETE — do not redo)

All four Task-1 symptoms were traced to concrete code. This table is the payoff of the
recon pass; trust it.

| Symptom | Root cause | Location |
|---|---|---|
| Misreads actual splits vs plan | **`buildAnalysisPrompt` never passes `session.plan`.** The LLM is told to "go block by block (warm-up, drills, main set…)" but only receives a *flat list of intervals* — it has to guess block boundaries, and guesses wrong. | `src/session-analysis.js:94-106` (userPrompt), rule at `:63` |
| Alters/reinvents the plan | Same root cause — there is no authoritative plan text for it to restate, so it reconstructs one. `detectPlanDeviations` strings arrive as bare flags with no plan context, which it then over-interprets. | `src/session-analysis.js:104` |
| L1/L2 gap nagging | Three reinforcing causes: **(a)** flag threshold is `gap >= 0.5s`, but a dead-stop L1 vs a turn-aided L2 is *expected* to differ ~0.5–1.2s, so it fires on essentially every session with 50m+ reps; **(b)** a hard prompt rule literally says "**ALWAYS** compare each rep's first length to its later length(s) and explicitly call out the wall push-off"; **(c)** the deterministic fallback auto-appends "Attack the wall push-off" whenever the flag exists. | `src/flags.js` first-length-gap block (`detectTechnical`); `src/session-analysis.js:73`; `src/session-analysis.js:147` |
| Lack of creativity | **(a)** generation `temperature: 0.5` (low); **(b)** the entire structural vocabulary is "broken 50s, descending 25s, ladders" repeated in 3 prompt lines; **(c)** `lastMainDesc` uses `.find()` — only **one** prior same-subtype session, so it can ping-pong A/B/A/B forever; **(d)** **`recentTemplateIds` is never passed from `app.js`** → `buildFallbackSession` always receives `[]`, so the fallback library has *zero* anti-repetition memory and repeats templates whenever Gemini fails. | `src/orchestrator.js:73-77`, `:217`; `web/app.js` (missing call site) |

### 1.1 The L1/L2 physics — get this right

In a 25 m pool, a 50 m rep is: **L1 = push start from a stationary wall**, **L2 = turn,
arriving with velocity**. The turn-aided length is *supposed* to be faster. For a swimmer
at ~16–17 s/25 m the normal advantage is roughly **0.5–1.2 s**. Flagging `>= 0.5s` therefore
flags normal physics as a defect — the athlete is right.

**The informative reframe** (implement this, not a bigger threshold):

- advantage **< ~0.4 s** → *the turn isn't converting* — real, coachable (streamline, breakout timing)
- advantage **> ~1.8 s** → L1 is being paced, or L2 is over-glided — worth a note
- **0.4–1.8 s** → normal. **Say nothing.**

Better still, add the comparison that actually matters: **L1 vs the athlete's own standalone
standing-start 25 m best** (`rolling_bests.best_25m_sprint_protocol_s`, already tracked). If
L1 of the 50s is much slower than his standalone 25 m best, he's pacing the first length —
a far more useful finding than "L1 is slower than L2".

---

## 2. Workstream A — feedback fidelity (Tasks 1a/1b/1c) → ☑ **SHIPPED v29**

Highest value: this is what irritates the athlete *every single session*. Self-contained,
high confidence, no research needed.

- ☑ **A1 — Feed the plan into the analysis prompt.** *(v29)* `session.plan` IS stored
  (`catalogue-writer.js:268` `plan: input.planned ?? null`). Render it verbatim in
  `buildAnalysisPrompt`'s userPrompt as `PRESCRIBED PLAN (authoritative — restate it exactly,
  never paraphrase into different numbers)`.
- ☑ **A2 — Engine-computed plan↔actual reconciliation table.** Don't make the LLM do the
  matching; it's why it gets it wrong. Reuse the round-5 `buildPlanTags(plan, breakdown)`
  (already maps interval → plan block) to emit a deterministic table:
  `Warm-up (prescribed 4×100m @20s) → INT 1-4, actual 400m ✓` /
  `Cool-down (prescribed 200m) → INT 17-18, actual 100m ⚠ 100m short`.
  Add a hard rule: *"The reconciliation table is engine-computed and authoritative. Do NOT
  recompute plan-vs-actual yourself; do not claim a deviation the table doesn't show."*
  New export, likely `buildPlanReconciliation()` in `flags.js` or a new `src/reconcile.js`.
- ☑ **A3 — Fix the first-length-gap flag.** Replace the `>= 0.5` threshold with the
  band from §1.1 (`TURN_ADVANTAGE_NORMAL = { min: 0.4, max: 1.8 }`); emit *different* flag
  text for too-small (turn not converting) vs too-large (L1 paced). Emit **nothing** in the
  normal band.
- ☑ **A4 — Add the L1-vs-standing-start-best check** (the genuinely useful signal).
- ☑ **A5 — Prompt surgery:** delete the "ALWAYS … call out the wall push-off" rule
  (`session-analysis.js:73`); replace with *"discuss the push-off/turn ONLY when the engine
  flags it as anomalous."* Gate the fallback takeaway at `:147` on the anomalous flags only.
- ☑ **A6 — Tests:** normal gap (0.9 s) → no flag; small gap (0.2 s) → turn flag; large gap
  (2.4 s) → paced-L1 flag; reconciliation table matches a known plan+breakdown pair;
  analysis prompt contains the plan text.

## 3. Workstream B — training science + creativity (Task 2, and Task 1d) → ☑ **SHIPPED (v30 + v31)**

- ☑ **B0 — Research pass (web).** *(v30 — written into `knowledge/swimming-coaching-kb.md`)* Sprint-freestyle development for an adult targeting
  **sub-30 s 50 m in a 25 m pool**, 3 pool + 1 dryland per block. Specifically: kick
  development (**constraint: quad-cramp history — the whole system bans dolphin kick and
  ballistic wall drives; find flutter/vertical/board alternatives**), push-start and turn
  work, pyramid/ladder structures, paced work (descending, negative-split, broken swims with
  rest added back), race-pace/tempo work without a tempo trainer (stroke-count-per-length
  proxies), and alactic vs lactate-tolerance programming. Write findings to
  `knowledge/` so they're reusable and never re-researched.
- ☑ **B1 — `src/set-archetypes.js`:** *(v31)* a named catalogue of main-set architectures, each with
  `{ id, name, rep_class, structure, rest_rule, when_to_use, phase_fit, subtype_fit }`.
  This is the creative vocabulary the prompts currently lack.
- ☑ **B2 — Wire archetypes into the generation prompt** as an explicit menu + "you used
  archetypes X, Y in this block — pick a different one."
- ☑ **B3 — Widen `lastMainDesc` from 1 → last 3 same-subtype sessions** (kills A/B ping-pong).
- ☑ **B4 — Fix the dead `recentTemplateIds` wiring in `web/app.js`** so the fallback library
  stops repeating templates. (One-line-ish fix, outsized payoff.)
- ☑ **B5 — Expand `fallback-library.js`** with the new archetypes — fallback sessions must
  vary too, since that's what ships whenever Gemini fails.
- ☑ **B6 — Kick / start / turn work as first-class blocks**, honouring the quad constraint.
- ☑ **B7 — Tests.**

## 4. Workstream C — LLM responsiveness & realism (Task 3) → ☑ **SHIPPED v32**

Deliberately **last**: C1 restructures the prompts, and doing it before A/B would mean
rewriting them twice. A does *surgical* prompt edits; C does the full restructure on top.

- ☑ **C1 — Restructure both prompts.** The analysis system prompt is now ~25 bullets of
  `NEVER`/`ALWAYS`. That volume of negative constraint is itself a cause of formulaic,
  low-creativity output — it crowds out actual coaching. Split into **(i)** a short
  data-integrity contract (non-negotiable, keep terse) and **(ii)** a positive coaching brief
  (what a good debrief *does*).
- ☑ **C2 — Temperature + model strategy.** Generation is `0.5`, analysis `0.6`. With the
  validator + archetypes constraining *shape*, generation temp can rise safely. Consider a
  stronger model for **analysis only** — it's one call per session, so quota-cheap.
- ☑ **C3 — Deterministic "lead with this" hint** so debriefs don't open identically every time.
- ☑ **C4 — Feed a short block-history digest** so cross-session trend claims are grounded.
- ◐ **C5 — Tests done; the EVAL RUN is still outstanding** → (`node scripts/eval-batch.js 7`) to grade the result.

---

## 5. Working rules for whoever picks this up

- **App lives in `Swimming Coach_app/`** — a *sibling* of the usual cwd. See `HANDOFF.md`.
- `npm test` must stay green (260 tests as of v28). Bump `CACHE` in `sw.js` every ship.
- Ship each workstream as its own version + HANDOFF entry — don't batch A+B+C into one deploy.
- **Tick the boxes in this file as you go** and note the shipped version. This file is the
  cross-session memory; a stale one costs a future session a full re-diagnosis.
- Gemini free quota ≈ one 10-session eval/day — don't burn it on casual checks.

---

## 6. Session log (append one line per working session)

- **2026-08-26 (session 1).** Diagnosed all four Task-1 symptoms → §1 table. Shipped
  **v29** (workstream A: plan reconciliation + L1/L2 reframe) and **v30** (B0 research into
  the KB, B3 3-deep main-set lookback, B4 dead `recentTemplateIds` wiring fixed).
  **Biggest single find:** the KB itself asserted "push-off is his single biggest technical
  gap" based on the bogus L1-vs-L2 inference, and the KB is fed into BOTH prompts — so
  fixing the flag alone would not have stopped the nagging. Added a hoisted
  `## 0. Non-negotiables` section because the analysis prompt only receives
  `knowledge.slice(0, 5000)` and athlete-critical rules were falling outside it.
  **Next session: start at B1.**
- **2026-08-26 (session 1, continued).** Shipped **v31** (workstream B complete): `src/set-archetypes.js`
  (24 archetypes), archetype menu + rotation in the generation prompt, 4 structurally distinct new
  sprint templates, kick/turn cues. **Two latent bugs surfaced while doing it:** (1) the fallback
  seed was `block_number * 7 + session_in_block` and the sprint pool had just reached 7 templates,
  so `seed % 7` cancelled the block number out entirely — block 1 session 1 and block 8 session 1
  got the identical session forever; (2) `targetLineFor` matched only the literal block name
  "Sprint Main Set", so every new archetype template ("Main Set — Broken 50s" etc.) would have
  shipped with **no target line**. Both fixed with regression tests.
  **Next session: workstream C (C1 prompt restructure first).**
- **2026-08-26 (session 1, continued).** Shipped **v32** (workstream C): analysis system prompt
  restructured from ~22 flat NEVER/ALWAYS bullets into Part A (data contract) / Part B (athlete
  constraints) / Part C (what a good debrief does) — the undifferentiated prohibition wall was
  itself driving formulaic output. Added a deterministic `leadAngle()` so consecutive debriefs
  don't open identically, and a same-subtype trend digest so cross-session claims are grounded.
  Analysis temperature 0.6 → 0.85 (prose, no validator to fail); generation 0.5 → 0.65 on the
  first attempt only, dropping to 0.5 on correction retries.
  **ALL THREE WORKSTREAMS COMPLETE. Remaining: the C5 eval run** —
  `node --env-file=.env scripts/eval-batch.js 7` when the Gemini daily quota allows, then grade
  it in the claude.ai project to confirm the changes actually moved the grades.
