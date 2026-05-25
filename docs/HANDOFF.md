# Swim Coach — session handoff (current state: 2026-05-23, SW cache v10)

Self-contained quick-start for a fresh Claude Code session. **Read order:** this file → `../README.md` (full architecture) → `coaching-project-brief.md` / `eval-grading-brief.md` / `coaching-checks.md` → `src/*`.

---

## 1. What this is & where it lives
- A personal swim-coaching **PWA** for **Julian** (goal: **sub-30s 50m freestyle, 25 m pool**). **Deterministic engine + optional Google Gemini (free tier)** LLM layer. Vanilla **ES modules, no build step**, Node built-in test runner.
- ⚠️ **The app lives in `Swimming Coach_app/`, a SIBLING of the usual cwd `Swimming Coach_code/`.** Globbing the cwd looks almost empty — the code is next door.
- **Deployed & live:** <https://gozibbygo.github.io/swim-coach/> (GitHub Pages, repo **`GoZibbyGo/swim-coach`**, public, branch `main` / root).
- **Catalogue sync repo:** **`GoZibbyGo/swim-catalogue`** (private) holds `catalogue.json`; the app reads/writes it via a fine-grained PAT entered in Settings per device.
- **202 tests** pass (`npm test`). **SW cache currently `swimcoach-v10`** (bump on every precached-file change).
- `.env` (gitignored, app root) holds the real `GEMINI_API_KEY` for eval re-runs. Never put the key in chat/commits.

## 2. How to run
```
npm test                                   # 202 tests (Node built-in runner)
node scripts/serve.js                       # dev server → http://localhost:5173/web/  (note the /web/ suffix)
GEMINI_API_KEY=… node scripts/eval-batch.js [N]   # training-camp self-play eval → eval-output/ (read-only on the catalogue)
```
Preview tool: `.claude/launch.json` exists in the **code dir** (cwd) with `autoPort:true`; serve.js honours `PORT`. The app must be opened at `/web/` (relative assets break at `/`).

## 3. Deploy / update procedure
1. Edit → `npm test` → commit → `git -C "<app>" push origin main` (cached creds work; **`gh` is NOT installed**).
2. **Bump `CACHE` in `sw.js`** (v10 → v11 …) whenever a precached file changes, AND add any *new* precached file to the `SHELL` array in `sw.js`.
3. Pages rebuilds in ~15–60s; verify: `curl https://gozibbygo.github.io/swim-coach/sw.js | grep swimcoach-v`.
4. Devices: reopen the installed PWA **twice while online** (first reopen downloads the update, second runs it) to pick up the new shell.

## 4. Architecture
- **Deterministic core ALWAYS runs**: decides session type/subtype/targets/safety, computes metrics/PRs, owns the catalogue, and **validates** every session. **Gemini** writes the sets/cues + the feedback prose. On any LLM failure (offline/rate-limit/auth/parse/validation) → deterministic **fallback library**. **Dryland always uses the library** (the LLM JSON contract is pool-shaped, so LLM dryland produced empty plans — now routed to the library).
- `src/` modules: `schema.js` (enums incl. dryland subtypes `pulling_strength`+`push_core_legs`, validators, `migrateCatalogue`), `garmin-parser.js` (CSV→intervals/lengths/summary; needs an `Intervals` column or it throws), `phases.js` (3 phases, block-based advancement, pool_priority + volume bands + targets), `block-state.js` (next session: **priority-weighted pool frequency** + **dryland subtype rotation** + rotating dryland slot + cross-block guard), `targets.js`, `flags.js` (records + **first-length-gap on any multi-length rep**), `flag-rules.js`, `classify.js`, `validator.js` (distance/rest/structure/**empty-block**/volume/flags), `fallback-library.js` (10 pool templates + 2 dryland families × bars/rings/bodyweight, equipment-aware), `symptom-mapper.js`, `catalogue-writer.js` (**only mutator**; stores `pending_session`, `plan` on logged sessions, advances block/phase), `session-analysis.js` (LLM debrief + deterministic fallback), `gemini.js`, `github-sync.js`, `orchestrator.js` (`generateSession` + `buildPrompt`), `block-report.js` (`buildBlockReportMarkdown`), `renderer.js`, `series.js`.
- **Web (`web/app.js`, one file):** tabs Today / Log / Feedback / Graphs / History / Settings.
  - **Today:** greeting, phase ring with the **`blocks_done.sessions_this_block` figure (e.g. `1.2`)**, metric tiles + sparklines, **equipment checkboxes** (paddles/pull buoy/bars/rings/weights → `equipmentAvailable` into generation), generate/regenerate.
  - **Log:** Planned vs External; pool CSV upload OR "describe the sets"; dryland per-set boxes; on a block-completing log → **"Block finished" export card**; **"Download coaching project brief"** button.
  - **GitHub sync:** auto-pull on open (when clean), **auto-push** (debounced) after any change, conflict resolver, manual Pull/Push in Settings. The pending generated session is part of the catalogue (`pending_session`) so it syncs.
  - **PWA:** `sw.js` at the app **root** (root scope so it covers `/web/` AND `/src/`), precaches the shell, cache-first, navigations fall back to the shell; self-hosted Inter (`web/fonts/`) + Chart.js (`web/vendor/`). **No in-app runtime tuning** (removed by design — all coaching improvements come back as code changes).
  - Graphs + Today sparklines hide bad early data via `trendSeries` / `TREND_AFTER_DATE = '2026-04-10'` (display-only).

## 5. Coaching feedback loop (how the app improves)
Two inputs, same output (code changes a Code session makes):
- **(a) Block review** — finish a real block → Log "Block finished" export → claude.ai project primed by `docs/coaching-project-brief.md`.
- **(b) Training-camp self-play** — `scripts/eval-batch.js` runs the engine through 10 self-play sessions (generate → synthesise a realistic Garmin CSV with the push-off gap + intra-rep fatigue → log → feedback, catalogue evolving). Writes one file to `eval-output/` (gitignored). Hand to a claude.ai project primed by `docs/eval-grading-brief.md`. **Read-only on the catalogue**; stops early on `rate_limit_daily`.
- Either returns a **feedback file** of code-change instructions → implement in a Code session → deploy.
- **Done so far:** Round 1 (graded **C+ / D**) and Round 2 (**B+ / B-**) both fully implemented + deployed, plus the round-2 deferred items (pool-priority frequency weighting; `push_core_legs` dryland subtype variety). **All findings from rounds 1–2 are addressed.**
- **Gemini free daily quota is low (~one full 10-session eval/day; resets US-Pacific midnight ≈ the user's evening).** Suggest `node scripts/eval-batch.js 7` to fit the cap. The eval output now includes the **complete per-interval table** the feedback received, so grading judges fabrication accurately.

## 6. Current state & immediate next step
- Everything above is implemented, tested, committed, and **live at v10**.
- **Next:** when the Gemini quota resets, re-run the eval (`7`) → grade in the claude.ai project → bring the feedback file back → implement. Goal: confirm rounds 1–2 pushed grades toward A-range.
- **Known open issue (mobile):** the installed Android PWA's file picker doesn't return the selected file (a known Android standalone-PWA limitation) — confirmed it works in a Chrome **tab** and on desktop but not the installed app. **User's decision: log pool CSVs on the desktop (syncs to phone via GitHub); phone is for generate/view/dryland/"describe the sets" logging.** A **Web Share Target** fix (share a CSV → opens in the app) is designed but **shelved** unless the user asks ("let's do the share target"). The `accept` filters were already removed from all file inputs (helped desktop/tab; didn't fix installed-PWA).

## 7. Gotchas
- App is the **sibling** dir; don't get fooled by the empty-looking cwd.
- `sw.js` is **root-scoped** with **relative** precache paths (resolved via `import.meta.url` for registration). Any deploy must keep `/web/`, `/src/`, `/knowledge/`, `/docs/` reachable from the same origin root.
- **Bad early data:** `rolling_bests.best_25m_split_s = 16.1` (and the 04-08/04-10 readings) are faulty. Hidden from graphs and dropped from the feedback prompt, but **still in the catalogue** — a clean scrub/recompute is unaddressed.
- Gemini key lives only in `.env` (gitignored) + per-device localStorage. The model is `gemini-flash-latest` (a thinking model; analysis uses `maxOutputTokens: 16384`).
- LF→CRLF git warnings on Windows are harmless.

## 8. Possible future work (not requested yet)
- Re-run eval to confirm round-1/2 grade gains (the active thread).
- Web Share Target for phone CSV upload (if the user wants it).
- Scrub the bad 16.1 reading from `rolling_bests` at the source.
- Optional: a version label in Settings (to confirm which build a device is running).
- Remaining roadmap item from README: it's already deployed; no build slices left.
