# Feedback-Signal Library

**Purpose.** The complete vocabulary of "how the session went" feedback an athlete can give about a pool or dryland session, mapped to **structured signals** the deterministic core can act on. This is the spec the **symptom mapper** (`src/symptom-mapper.js`, task #13) encodes. The LLM may also map novel free-text to these same signal IDs — but every signal listed here must be handleable deterministically (offline) too.

**The flow:** free-text → matched signal(s) → structured signal stored on the session/catalogue → deterministic core applies it on the next generation. The LLM/mapper only *translates*; the core *decides*.

*Grounded in: sRPE training-load monitoring [source: https://pmc.ncbi.nlm.nih.gov/articles/PMC7739345/], mental-fatigue effects on perceived effort [source: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12014620/], and swim log-book practice [source: https://www.yourswimlog.com/5-things-to-track-in-your-log-book-besides-your-swim-practices/].*

---

## Signal schema

Each signal has:

| Field | Meaning |
|---|---|
| `id` | unique key |
| `category` | grouping (injury, fatigue, intensity, …) |
| `applies_to` | `pool` / `dryland` / `both` |
| `signal_type` | what kind of structured output it produces (see below) |
| `payload` | the structured value the core consumes |
| `core_action` | what the deterministic core does with it |
| `severity` | `critical` / `high` / `medium` / `info` |
| `decay` | when the signal stops being active |

### Signal types
- `flag` — activates an injury/condition restriction (ties to `flag-rules.js`)
- `intensity_adjustment` — `increase` / `hold` / `decrease` the next-session target step
- `volume_adjustment` — `increase` / `hold` / `decrease` next volume
- `recovery_tilt` — bias the next session toward recovery/technique
- `equipment_constraint` — set available equipment for the next dryland block
- `technique_focus` — bias drill/cue selection toward a theme
- `data_quality` — mark logged metrics partial/unreliable
- `record` — a performance result (feeds the flag detector / rolling bests)
- `context_note` — stored for LLM context only; no automatic core action

### Decay rules (so flags don't accumulate forever)
- Injury flags: active until the athlete reports resolved **or** N symptom-free sessions (default 2 for pre-cramp, 3 for full cramp).
- Adjustment signals: apply to the **next session only**, then clear.
- Equipment constraints: persist for the block they were set on.
- Context notes: retained as history, never auto-expire.

---

## 1. Injury & pain  (severity: critical/high — these gate the next session)

| id | applies_to | phrases (examples) | signal_type | payload | core_action | decay |
|---|---|---|---|---|---|---|
| `left_quad_cramp` | both | "left quad cramped", "left thigh seized" | flag | left_quad_cramp | No dolphin kick / explosive push-off; ≥2min sprint rest; stop on tightness | resolved or 3 sessions |
| `right_quad_cramp` | both | "right quad cramped" | flag | right_quad_cramp | as above | resolved or 3 sessions |
| `right_quad_pre_cramp` | both | "right quad nearly cramped", "quad pre-cramp", "felt it about to go" | flag | right_quad_pre_cramp | controlled quad loading only; short isometric holds | resolved or 2 sessions |
| `left_quad_pre_cramp` | both | "left quad nearly cramped" | flag | left_quad_pre_cramp | as above | resolved or 2 sessions |
| `calf_cramp` | both | "calf cramp", "calf locked up" | flag | calf_cramp | reduce hard kick; check hydration/relaxed feet | resolved or 2 sessions |
| `hip_flexor_tightness` | both | "hip flexor tight", "hip flexors sore" | flag | hip_flexor_tightness | limit sustained hip-flexor isometrics (L-sit) | resolved or 2 sessions |
| `shoulder_discomfort` | both | "shoulder sore", "shoulder pinch", "shoulder hurt" | flag | shoulder_discomfort | avoid lat pullover & ballistic overhead pulls; favour scap stability | resolved or 3 sessions |
| `lower_back_discomfort` | both | "lower back sore", "back tight" | flag | lower_back_discomfort | reduce loaded extension; core stability emphasis | resolved or 2 sessions |
| `general_soreness` | both | "sore all over", "DOMS", "stiff" | recovery_tilt | mild | slight volume reduction; mobility emphasis | next session |
| `sharp_pain` | both | "sharp pain", "something tweaked", "felt a pull" | flag + context_note | needs_review | back off; flag for human review before next hard session | until reviewed |

---

## 2. Fatigue, energy & readiness  (severity: high/medium)

| id | applies_to | phrases | signal_type | payload | core_action | decay |
|---|---|---|---|---|---|---|
| `exhausted` | both | "exhausted", "wiped", "nothing left", "died" | recovery_tilt + intensity_adjustment | hold | hold targets, tilt next toward recovery/technique | next session |
| `dead_legs` | both | "dead legs", "legs heavy" | recovery_tilt | legs | reduce kick/leg load next session | next session |
| `dead_arms` | both | "arms gone", "shoulders fried" | recovery_tilt | upper | reduce pulling volume next session | next session |
| `fresh_strong` | both | "felt fresh", "strong", "full of energy" | intensity_adjustment | increase | allow normal/aggressive target step | next session |
| `sluggish` | both | "sluggish", "flat", "couldn't get going" | intensity_adjustment | hold | hold targets; check recovery context | next session |
| `under_recovered` | both | "still tired from last session", "not recovered" | recovery_tilt | high | insert easier session or reduce volume | next session |
| `poor_sleep` | both | "slept badly", "barely slept" | context_note + intensity_adjustment | hold | note; soften expectations | next session |
| `under_fuelled` | both | "hadn't eaten", "low energy / hungry" | context_note | — | note for interpreting metrics | next session |
| `dehydrated` | both | "dehydrated", "thirsty/cramped" | context_note + cramp-risk | — | hydration reminder; raises cramp watch | next session |

---

## 3. Intensity perception (RPE)  (severity: medium)

| id | applies_to | phrases | signal_type | payload | core_action | decay |
|---|---|---|---|---|---|---|
| `rpe_value` | both | "RPE 8", "effort 7/10" | context_note | numeric RPE | session-load tracking | stored |
| `too_easy` | both | "too easy", "could've done more", "not challenging" | intensity_adjustment + volume_adjustment | increase | tighten target step / add a rep or set | next session |
| `too_hard` | both | "too hard", "brutal", "couldn't keep up" | intensity_adjustment | decrease | ease target step next session | next session |
| `just_right` | both | "just right", "challenging but doable" | intensity_adjustment | normal | proceed with standard step | next session |
| `couldnt_hold_pace` | pool | "couldn't hold the pace", "faded off target" | intensity_adjustment | hold | hold pace target; check fatigue context | next session |
| `held_targets` | both | "hit all targets", "held pace/SWOLF" | intensity_adjustment | increase | normal/aggressive step | next session |
| `targets_too_aggressive` | both | "targets were unrealistic", "no chance at that time" | intensity_adjustment | decrease | reduce step size | next session |

---

## 4. Completion & adherence  (severity: high — affects data trust)

| id | applies_to | phrases | signal_type | payload | core_action | decay |
|---|---|---|---|---|---|---|
| `cut_short` | both | "cut it short", "stopped early", "only did half" | data_quality + context_note | partial | mark distance/metrics partial; don't treat as full-session baseline | this session |
| `terminated_injury` | both | "stopped because of cramp/pain" | data_quality + flag | partial | partial data + activate the relevant injury flag | this session |
| `skipped_set` | both | "skipped the X set", "missed a set" | data_quality | partial_set | note omission; adjust volume accounting | this session |
| `added_extra` | both | "added an extra set", "did more than planned" | volume_adjustment + context_note | over | note; engine may nudge next volume | this session |
| `out_of_order` | both | "did the sets out of order" | context_note | — | note (affects pre-fatigue comparisons, esp. dryland) | this session |
| `missed_intervals` | pool | "missed the interval on reps 6-8" | context_note | — | note pacing failure point | this session |

---

## 5. Technique observations  (severity: info/medium — bias future focus)

| id | applies_to | phrases | signal_type | payload | core_action | decay |
|---|---|---|---|---|---|---|
| `stroke_long` | pool | "stroke felt long", "good DPS", "gliding well" | technique_focus | maintain_dps | reinforce DPS focus; positive note | next session |
| `stroke_short` | pool | "stroke felt short/choppy", "spinning my arms" | technique_focus | dps | bias toward DPS / catch drills | next session |
| `catch_good` | pool | "catch felt solid", "holding water" | context_note | — | positive note | stored |
| `catch_slipping` | pool | "slipping", "no catch", "arm slipping through" | technique_focus | catch | bias toward scull/fist/catch drills | next session |
| `pushoff_strong` | pool | "push-offs felt explosive/strong" | context_note | — | positive note (watch quad) | stored |
| `pushoff_weak` | pool | "weak off the wall", "no push-off" | technique_focus | pushoff | bias toward (controlled) push-off glide drills | next session |
| `lost_stroke_count` | pool | "stroke count crept up", "10-11 by the end" | technique_focus | efficiency | flag efficiency drift; reinforce count target | next session |
| `held_stroke_count` | pool | "held 7 strokes throughout" | context_note | — | positive note | stored |
| `body_position` | pool | "felt low in the water", "hips dropping" | technique_focus | body_position | bias toward kick/balance drills + core | next session |

---

## 6. Breathing / CO2  (severity: info/medium — pool)

| id | applies_to | phrases | signal_type | payload | core_action | decay |
|---|---|---|---|---|---|---|
| `breathing_held` | pool | "held every-5", "breathing pattern stayed" | context_note | — | positive CO2-tolerance note | stored |
| `breathing_broke` | pool | "breathing broke down", "had to breathe more" | technique_focus | co2 | maintain/raise CO2-tolerance cool-down emphasis | next session |
| `gasping` | pool | "gasping", "out of breath fast" | context_note + recovery_tilt | mild | note; check intensity/recovery | next session |

---

## 7. Equipment & environment  (severity: medium — constrains generation)

| id | applies_to | phrases | signal_type | payload | core_action | decay |
|---|---|---|---|---|---|---|
| `equipment_rings_only` | dryland | "only had rings", "rings only this block" | equipment_constraint | rings | build dryland around rings | this block |
| `equipment_park_bars` | dryland | "calisthenic park", "bars only" | equipment_constraint | bars | build around bars | this block |
| `equipment_bodyweight` | dryland | "no equipment", "bodyweight only" | equipment_constraint | bodyweight | bodyweight-only session | this block |
| `equipment_dumbbells` | dryland | "had dumbbells", "DBs available" | equipment_constraint | dumbbells | allow DB exercises | this block |
| `slippery_bars` | dryland | "bars were slippery", "couldn't grip" | data_quality | grip_compromised | mark grip-dependent results unreliable | this session |
| `pool_crowded` | pool | "pool was packed", "sharing a lane" | data_quality + context_note | — | note (pacing/rest disrupted) | this session |
| `cold_water` | pool | "water was cold", "freezing" | context_note + cramp-risk | — | note; raises cramp watch | this session |
| `facility_issue` | both | "pool closed early", "equipment broken" | context_note | — | note disruption | this session |

---

## 8. Mental, motivation & focus  (severity: info)

| id | applies_to | phrases | signal_type | payload | core_action | decay |
|---|---|---|---|---|---|---|
| `motivated` | both | "felt motivated", "loved it", "fired up" | context_note | positive | morale note | stored |
| `unmotivated` | both | "couldn't be bothered", "dreaded it", "forced myself" | context_note + intensity_adjustment | hold | note; consider variety/recovery next | next session |
| `distracted` | both | "distracted", "couldn't focus", "head not in it" | context_note | — | note (interpret metrics with caution) | this session |
| `focused` | both | "locked in", "really focused" | context_note | positive | positive note | stored |
| `mental_fatigue` | both | "mentally drained", "brain fried (work/study)" | context_note + intensity_adjustment | hold | note — mental fatigue inflates RPE; soften expectations | next session |

---

## 9. Performance & result  (severity: high — feeds records)

| id | applies_to | phrases | signal_type | payload | core_action | decay |
|---|---|---|---|---|---|---|
| `claimed_pr` | both | "PR", "best ever", "fastest yet" | record | candidate_pr | cross-check against rolling bests via flag detector | this session |
| `felt_fast` | pool | "felt fast", "flying" | context_note | positive | positive note (verify vs data) | stored |
| `felt_slow` | pool | "felt slow", "no speed today" | context_note | — | note (verify vs data) | stored |
| `beat_target` | both | "beat the target", "went under" | context_note | positive | positive note; supports aggressive next step | next session |
| `missed_target` | both | "missed target", "off the time" | context_note | — | note; supports holding step | next session |

---

## Conflict resolution

When multiple signals fire, the core applies precedence:
1. **Injury/critical flags** override everything (safety first).
2. **Recovery tilts** override intensity increases (don't push a tired/sore athlete).
3. **Intensity decrease** beats **increase** if both are present (be conservative).
4. **Data-quality** signals are independent — they mark metrics, not training direction.
5. Remaining signals stack as context for the LLM.

## What needs new engine capability vs already works

| signal_type | status |
|---|---|
| `flag` | ✅ works (flag-rules.js + block-state activeFlags + validator) |
| `equipment_constraint` | ✅ works (block_N_dryland_equipment + generator) |
| `data_quality` | ✅ works (parser partial-rep + flag detector) |
| `record` | ✅ works (flag detector PR path) |
| `context_note` | ✅ works (stored in session.notes / coach_notes) |
| `intensity_adjustment` | ⚠️ needs targets-engine hook (apply a step multiplier next session) |
| `volume_adjustment` | ⚠️ needs generator hook (nudge target volume within subtype range) |
| `recovery_tilt` | ⚠️ needs block-state hook (bias subtype toward recovery/technique) |
| `technique_focus` | ⚠️ needs drill-selection hook (bias the fallback library / LLM prompt) |

The four ⚠️ hooks are small, well-scoped additions — they'll be wired when building the symptom mapper (#13) and the generator/orchestrator (#10–#12).
