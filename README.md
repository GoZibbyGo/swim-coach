# Swimming Coach App

Personal swim-coaching app for Julian (goal: **sub-30s 50m freestyle, 25m pool**). Runs in the browser on phone + desktop. Replaces the old Claude-skill workflow with a zero-cost app: a **deterministic engine** that always runs, plus an **optional LLM layer (Google Gemini, free tier)** for richer prose. No build step — vanilla ES modules.

> **This README is the handoff/state doc.** If continuing in a fresh session, read this first, then `knowledge/*.md` and the source files.

## How to run
```
npm test                 # 198 tests (Node built-in runner)
node scripts/serve.js     # dev server → http://localhost:5173/web/
node scripts/serve.js     # demo with fake data → http://localhost:5173/web/?demo
node scripts/make-demo.js # regenerate web/seed-catalogue.demo.json
node scripts/demo-generate.js   # CLI: deterministic session generation
# Training-camp self-play eval (read-only; writes eval-output/ only):
#   $env:GEMINI_API_KEY="..."; node scripts/eval-batch.js   # 10 sessions; omit key for fallback engine
# Live Gemini check (key via env, never committed):
#   $env:GEMINI_API_KEY="..."; node scripts/live-gemini-test.js
```
Node 18+ (developed on v24). No npm dependencies.

## Architecture (Option C — agreed with athlete)
- **Deterministic core ALWAYS runs**: decides session type/subtype/targets/flags, computes all metrics/PRs, owns the catalogue, and **validates** any LLM output (distances auto-repaired from sets; rest/structure/flag safety enforced).
- **LLM (Gemini) is an optional layer**: writes the session sets+cues and the post-session feedback prose. On no-key / offline / rate-limit / validation-fail → **falls back** to the deterministic template library. The LLM never writes the catalogue and never decides the maths.
- Model: **`gemini-flash-latest`** (currently Gemini 3.5 Flash — `gemini-2.0-flash` has a 0 free-tier quota). maxOutputTokens 8192 (thinking model).

## Engine modules (`src/`)
| File | Role |
|---|---|
| `schema.js` | Catalogue enums, validators, `migrateCatalogue` (seeds `best_threshold_pace_per_100m`=1:36, `blocks_in_phase`) |
| `garmin-parser.js` | Garmin CSV → intervals/lengths/summary/glitches. Handles stroke "Unknown"/"Drill"/"--"(inherit), DPS, stroke-rate, rest_after_s |
| `phases.js` | **Single source of truth for phases.** Block-based advancement: P1=6, P2=6, P3=4 blocks (P3 terminal). Phase-specific volumes + priorities + sprint-finish rules + targets |
| `block-state.js` | Decides next session type/subtype (block balance, rotating dryland slot `block%4`, anti-repetition, advisory plan for external sessions) |
| `targets.js` | Next-session targets from rolling_bests (tunable `TARGET_STEPS`) |
| `flags.js` | Coach flags from CSV: PRs, stroke drift, first-length gap, cool-down HR, sprint consistency/fade, rest adherence |
| `flag-rules.js` | Injury-flag → restriction contract (quad → no dolphin kick, etc.) shared by validator + symptom mapper |
| `classify.js` | `inferPoolSubtype` for external sessions (sprint/threshold/technique/race_pace) |
| `validator.js` | Validates a generated session: distance tally, rest mins, structure, phase-volume range, flag respect |
| `fallback-library.js` | LLM-free session generation: 10 pool + 3 dryland (equipment-aware) templates; volumes computed from sets. Honors a pre-session availability list (`equipmentAvailable`): dryland template choice (rings>bars>bodyweight) + strips unavailable pool gear (paddles/pull buoy) |
| `symptom-mapper.js` | Free-text feedback → structured signals (~55: injury/fatigue/intensity/adherence/technique/equipment…) |
| `catalogue-writer.js` | **Only mutator.** Logs session, updates rolling_bests, advances block + phase (block-based), flag decay (pending_clear → confirm), pending_adjustments, external `source` |
| `session-analysis.js` | LLM post-session debrief (Records/Breakdown/Flags/Takeaways) + deterministic fallback |
| `gemini.js` | Gemini REST caller; categorises errors: offline / rate_limit_minute / rate_limit_daily / auth / api / parse |
| `github-sync.js` | Catalogue read/write to a private GitHub repo (REST Contents API). UTF-8-safe base64, blob-`sha` conflict detection, error categorisation (offline/auth/not_found/conflict/rate_limit/api/parse). `fetch` injectable |
| `block-report.js` | `buildBlockReportMarkdown(catalogue, blockNumber)` — plans + performance + feedback + raw JSON, for the block-finished export |
| `orchestrator.js` | `generateSession`: Gemini → validate (auto-repair) → retry×2 → fallback; returns {status,source,fallback_reason,retry_after,session} |
| `renderer.js` | Structured session → markdown |
| `series.js` | Time-series extraction for graphs |

## Web app (`web/`)
- `index.html` (Inter font), `styles.css` (**Option B "Dashboard Hub"** dark teal palette), `app.js` (all UI; imports `../src/*` directly).
- Tabs: **Today** (greeting + phase block-progress ring **with current-block figure `blocks_done.sessions_this_block`, e.g. `1.2`** + metric tiles w/ sparklines + **equipment checkboxes** (paddles/pull buoy/bars/rings/weights — persisted per device, passed to generation) + session), **Log** (Planned vs External; pool CSV + plan-file; dryland per-set boxes; feedback + "completed fully"; **on a log that completes a block → "Block finished" card with a `.md` analysis export**), **Feedback** (LLM debrief of last session), **Graphs** (self-hosted Chart.js line charts + refresh; trend visuals — Graphs + Today sparklines — hide known-bad early data via `trendSeries`/`TREND_AFTER_DATE` in app.js, currently excluding dates ≤ 2026-04-10; display-only, catalogue untouched), **History** (rolling bests + session list), **Settings** (Gemini key/model + **GitHub sync** config/test/pull/push — all stored in localStorage; Gemini shared real+demo, sync real-only).

### Coaching feedback loop (improvements are code changes, not runtime tuning)
Two ways to review + improve the coaching, both ending in **code changes I (Claude Code) make** to the deterministic core and the Gemini prompts — there is **no in-app runtime tuning** (removed by design):
1. **Block review (real data):** finish a block → **Log → "Block finished"** card → download the analysis export (`buildBlockReportMarkdown`: plans + performance + feedback + raw JSON; logged app sessions store their prescribed `plan` for prescribed-vs-actual) → paste into a Claude.ai project primed by **`docs/coaching-project-brief.md`** → it returns a **feedback file** of code-change instructions → bring that here to implement.
2. **Training-camp self-play (synthetic):** `node scripts/eval-batch.js` runs the engine through **10 self-play sessions** (generate → synthesise a realistic Garmin CSV → log → feedback, catalogue evolving each step) and writes one eval file to `eval-output/`. **Read-only** w.r.t. your data (loads `web/seed-catalogue.json`, simulates in memory, writes only the eval file; no catalogue/localStorage/git writes). Hand the eval file to a Claude.ai project primed by **`docs/eval-grading-brief.md`** → it grades creation + feedback ability and returns a feedback file of code-change instructions → bring it here. (Set `GEMINI_API_KEY` to test real Gemini; omit it for the fallback engine.)
- **Header sync pill** (`#syncState`): tap → Settings. States: `DEMO DATA` / `sync off` (unconfigured) / `not synced` (configured, never synced) / `● unsynced` (local changes not yet pushed) / `synced`. **Auto-pulls on app open** when configured + clean; a *dirty* local copy is never auto-overwritten. **Auto-pushes** (debounced ~800ms, coalesces bursts) after any local change — generate/log/flag edit; success is silent (pill → `synced`), offline stays `unsynced` and retries on the next change. Manual Pull/Push buttons remain in Settings for first-time setup + conflict resolution. On a push conflict (remote moved since last sync) the app shows which logged sessions each choice would drop and lets the athlete pick "keep this device" (force-push) vs "keep GitHub" (pull) — the dropped session is re-logged as External. Block progression stays correct (counts are recomputed at log time).
- `?demo` = isolated storage namespace + `seed-catalogue.demo.json` (20 fake sessions + a pending dryland session). Real data untouched.
- Catalogue lives in browser localStorage (`swimcoach.catalogue`), seeded from `web/seed-catalogue.json` (copy of the real `../Swimming Coach_code/athlete_catalogue.json`).

### PWA / offline (installable)
- `web/manifest.webmanifest` (+ `web/icons/icon.svg`, maskable, brand teal→blue): standalone, portrait, `start_url`/`scope` `./`, theme/bg `#0c0f14`. Linked from `index.html` (+ apple-touch meta).
- `sw.js` **at the app root** (registered `/sw.js`, scope `/`) — deliberately root-scoped because the app at `/web/` imports engine modules from `/src/`, so both trees must be cached. Precaches the full shell (31 files: shell + 19 `src/*.js` + knowledge md + the coaching-project brief + font + chart). **Cache-first** for same-origin assets; navigations fall back to the cached shell. Cross-origin (GitHub + Gemini APIs) is **not** intercepted → hits network, fails gracefully offline. `activate` deletes old caches; `skipWaiting`+`clients.claim`. **Bump `CACHE` (`swimcoach-v1`→…) whenever a precached file changes.**
- **Self-hosted** (no CDN at runtime): Inter variable font `web/fonts/InterVariable.woff2` (via `@font-face` in `styles.css`); Chart.js UMD `web/vendor/chart.umd.js` (loaded lazily via a `<script>` tag → `window.Chart`). `serve.js` serves `.woff2` as `font/woff2`.

## Key decisions
- Phases advance by **completed blocks**, not calendar weeks or metric gates (targets are progress only). Per `../Swimming Coach/training_phase_plan.md`.
- External sessions: pull performance + count toward block balance/anti-repetition; structure never templated. They DO count toward block progression.
- Font: **Inter** (self-hosted variable `woff2`; no font CDN). Layout: **Option B** dashboard.
- Mockups for design choices live in `web/mockups/` (layout options a–d, font options).

## Done
Engine (all modules, 198 tests). Web app: Today/Log/Feedback/Graphs/History/Settings. Phases 1–3 block-based. Demo. Live Gemini verified. **GitHub sync** (pull/push catalogue to a private repo; auto-pull on open; auto-push; conflict resolution). **PWA / offline** (manifest + maskable icon; root-scoped service worker; self-hosted Inter + Chart.js). **DEPLOYED & LIVE** at `https://gozibbygo.github.io/swim-coach/` (GitHub Pages; catalogue sync repo `GoZibbyGo/swim-catalogue`). **Equipment checkboxes** → generation. **Current-block `1.2` figure**. **Coaching feedback loop** — block-finished export + `scripts/eval-batch.js` self-play, both → a Claude.ai project (briefs in `docs/`) → a feedback file → **code changes by Claude Code** (no in-app runtime tuning; that was removed). SW cache currently `swimcoach-v6` (bump on every shell change).

## Remaining
All build slices are complete. To go live, follow **Deploy** below (operational: create a GitHub repo, push, enable Pages — no code left to write).

## Deploy (GitHub Pages)
The app is path-agnostic, so a project sub-path (`user.github.io/swim-coach/`) works. Pages output is **public** even from a private repo (the public seed catalogue was a deliberate choice — see the seed note).
1. **Create a repo** at <https://github.com/new> (e.g. `swim-coach`, public or private). Do **not** add a README/.gitignore (this dir already has a commit).
2. **Push** from this dir:
   ```
   git remote add origin https://github.com/<you>/swim-coach.git
   git push -u origin main
   ```
3. **Enable Pages**: repo → Settings → Pages → Source **Deploy from a branch** → branch `main`, folder `/ (root)` → Save. Wait ~1–2 min.
4. **Open** `https://<you>.github.io/swim-coach/` (username lowercased) → redirects to `…/web/`. In Chrome (Pixel) use ⋮ → **Install app / Add to Home screen**.
5. **Updating later**: commit + push changes, and **bump `CACHE`** in `sw.js` (`swimcoach-v1`→`v2`…) whenever a precached file changed, so the service worker re-fetches the new shell.

### GitHub sync — setup notes
- Create a **private** repo (e.g. `swim-catalogue`) and a **fine-grained PAT** scoped to it with **Contents: read & write**. Enter token + owner + repo in Settings → GitHub sync; path defaults to `catalogue.json`, branch to `main`. "Save & test" hits `GET /repos/{owner}/{repo}`.
- First device: configure → **Push** (creates the file). Other device: configure → opens and **auto-pulls**. Day-to-day: just open (auto-pulls) and use it — generating/logging **auto-pushes** in the background.
- The **generated/pending session is part of the catalogue** (`pending_session`), so it syncs too: generate on the phone (auto-pushes) → the desktop sees the plan on its next open and can log it as *Planned* (full fidelity — subtype from the plan, not inferred). Logging the plan (or pulling a catalogue without one) clears it.

## Devices
Both target devices run Chromium browsers → fully supported: **Google Pixel 9a** (Chrome/Android — installable PWA) and **Dell Inspiron 2-in-1** (Edge/Chrome/Windows). The PWA is built (manifest + offline SW); the phone still needs the app **deployed to a URL** (remaining item 1) before it can install it — localhost only works on the machine running the server.
