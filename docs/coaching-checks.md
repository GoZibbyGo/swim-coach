# Coaching checks — what to do (cheat-sheet)

Two ways to review + improve the coaching. Both end the same way: a **feedback file** that you bring to a Claude Code session, which implements the fixes in the app. (Nothing is pasted back into the app — there's no runtime tuning.)

## One-time setup
1. App → **Log** tab → **⬇ Download coaching project brief**.
2. In **claude.ai → Projects**, create a project (e.g. "Swim Coach review") and paste that brief in as the project's instructions/knowledge. Done once; reuse forever.

## A. Block check (after each real block)
1. Train through a block in the app (3 pool + 1 dryland). Log every session.
2. When you log the session that completes the block, a **"🎉 Block finished"** card appears on the **Log** tab → **download the `.md` export right then** (there's no re-download later).
3. Open your review project → paste the export → "Review this block per your instructions and return the feedback file."
4. It returns a **feedback file** (grades + "Changes for Claude Code").
5. Open a **Claude Code** session, paste the feedback file → it implements + deploys.
6. Reopen the app on each device (online) to pick up the update.

## B. Training-camp eval (synthetic, for testing the engine broadly without waiting for real blocks)
1. Make sure `.env` (in `Swimming Coach_app/`) has your `GEMINI_API_KEY`.
2. In a Claude Code session, run: `node scripts/eval-batch.js` (or `node scripts/eval-batch.js 7` to fit the daily quota). It writes one file to `eval-output/`. (Read-only on your real data.)
3. Paste that file into a claude.ai project primed with **`docs/eval-grading-brief.md`** → it grades and returns a feedback file.
4. Bring the feedback file to a Claude Code session → implement + deploy.

## Good to know
- **Gemini's free daily quota is low** — about one full 10-session eval per day; it resets at US-Pacific midnight (≈ your evening). The eval stops early if the quota's hit; partial runs are still gradeable.
- **Grades so far:** round 1 = C+ / D, round 2 = B+ / B- (both implemented). Aiming to confirm further gains on the next run.
- If a feedback file proposes **deterministic-core** changes (rest rules, volumes, target maths) they're implemented in code (by Claude Code), not applied at runtime — that keeps the safety gate trustworthy.
