# Swim Coach — session handoff (state as of 2026-05-23)

Quick-start for a fresh Claude Code session. **Read order:** this file → `../README.md` (full architecture) → `coaching-project-brief.md` / `eval-grading-brief.md` → `src/*`.

## What this is & where it lives
- A personal swim-coaching **PWA** for Julian (goal: sub-30s 50m freestyle, 25 m pool). Deterministic engine + optional **Gemini** LLM layer. Vanilla ES modules, **no build step**, Node built-in test runner.
- **The app lives in `Swimming Coach_app/`** — a SIBLING of the usual cwd `Swimming Coach_code/`. (cwd globs look empty; the app is next door.)
- **Deployed & live:** <https://gozibbygo.github.io/swim-coach/> (GitHub Pages, repo `GoZibbyGo/swim-coach`).
- **Catalogue sync repo:** `GoZibbyGo/swim-catalogue` (private) holds `catalogue.json`; the app reads/writes it via a fine-grained PAT entered in Settings per device.
- **202 tests** pass (`npm test`). **SW cache currently `swimcoach-v9`.**

## How to run
```
npm test                       # 202 tests
node scripts/serve.js          # dev server → http://localhost:5173/web/  (note the /web/)
GEMINI_API_KEY=… node scripts/eval-batch.js [N]   # training-camp self-play eval → eval-output/
```
`.env` (gitignored) at the app root holds the real `GEMINI_API_KEY` for eval re-runs.

## Deploy / update procedure
1. Edit → `npm test` → commit → `git -C "<app>" push origin main` (cached creds work; `gh` not installed).
2. **Bump `CACHE` in `sw.js`** (v9 → v10 …) whenever a precached file changes, AND add any *new* precached file to the `SHELL` list in `sw.js`.
3. GitHub Pages rebuilds ~15–60s; verify `curl …/sw.js | grep swimcoach-v`.
4. On devices: reopen the installed PWA (online) to pick up the new shell.

## Architecture (one-liner per piece)
- **Deterministic core** decides session type/subtype/targets/safety and **validates** every session; **Gemini** writes the sets/cues + feedback prose; on any LLM failure → deterministic **fallback library**. Dryland always uses the library (the LLM JSON contract is pool-shaped).
- Key modules in `src/`: `block-state.js` (next session: priority-weighted pool frequency + dryland subtype rotation), `orchestrator.js` (`generateSession` + prompt), `validator.js` (incl. empty-block rejection), `fallback-library.js` (pool templates + 2 dryland families: `pulling_strength`, `push_core_legs`), `flags.js` (records + first-length-gap on any multi-length rep), `session-analysis.js` (LLM debrief + deterministic fallback), `catalogue-writer.js` (only mutator; stores `plan` on logged sessions), `block-report.js` (block export), `github-sync.js`, `phases.js`, `targets.js`, `series.js`, `renderer.js`, `garmin-parser.js`.
- Web (`web/app.js`): tabs Today/Log/Feedback/Graphs/History/Settings. Today shows the `1.2` block-progress figure + equipment checkboxes. Log has the block-finished export + "Download coaching project brief". GitHub-sync auto-pull-on-open + auto-push. There is **no in-app runtime tuning** (removed by design — all coaching improvements come back as code changes).

## Coaching feedback loop (how the app improves)
Two inputs, same output (code changes I make): **(a) block review** — finish a block → Log "Block finished" export → claude.ai project primed by `docs/coaching-project-brief.md`; **(b) training-camp self-play** — `scripts/eval-batch.js` (read-only on the catalogue; writes only `eval-output/`) → claude.ai project primed by `docs/eval-grading-brief.md`. Either returns a **feedback file** of code-change instructions → bring it to a Code session → implement → deploy.
- **Done so far:** round 1 (graded C+/D) and round 2 (B+/B-) both fully implemented + deployed, plus the round-2 deferred items (pool-priority frequency weighting; `push_core_legs` dryland subtype variety).
- **Gemini free daily quota is low (~one full 10-session eval/day; resets Pacific-midnight ≈ user's evening).** The eval script stops early on `rate_limit_daily`.

## Likely next step
Re-run the eval after the quota resets to confirm rounds 1–2 moved the grades (suggest `node scripts/eval-batch.js 7` to fit the cap), grade it, implement any new findings.

## Gotchas
- `sw.js` is **root-scoped** (registered relative via `import.meta.url`) with **relative** precache paths — deploy must keep `/web/`, `/src/`, `/knowledge/`, `/docs/` reachable from the same origin root.
- Bad early data: `rolling_bests.best_25m_split_s = 16.1` (and the 04-08/04-10 readings) are faulty. They're **hidden from graphs** (`TREND_AFTER_DATE` in app.js) and **dropped from the feedback prompt**, but still sit in the catalogue. A clean fix (scrub/recompute) is unaddressed.
- Don't put the Gemini key in chat/commits — it lives only in `.env` (gitignored) and per-device localStorage.
