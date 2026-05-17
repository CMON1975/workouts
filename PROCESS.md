# PROCESS.md
Running log of work done with Claude Code.

---
## 2026-05-10 — Migrated repo from WSL Ubuntu to the_box
**What:** Pushed full `workouts/` directory (incl. `.git`, `node_modules`, `.env`) from WSL 2 Ubuntu to `the_box` via `scp -r` over Tailscale into `~/website_projects/workouts`. Created `~/website_projects/` parent first.
**Why:** Consolidating active dev onto the_box; WSL no longer the primary environment.
**Notes:** 3295 files / 58M transferred. Git clean on `main`, full history preserved. `node_modules` copied verbatim — recommend `rm -rf node_modules && npm install` before first run in case of any native-module mismatch (both ends are x86_64 glibc, so likely fine). Future migrations: exclude `node_modules` on the source side and reinstall locally — faster than scp'ing thousands of tiny files.

---
## 2026-05-10 — Rebuilt native modules after WSL → Arch port
**What:** `npm test` failed with `NODE_MODULE_VERSION 127` vs `137` on `better-sqlite3`. `npm rebuild` fixed it; all 88 tests pass.
**Why:** WSL ran Node 22 (ABI 127); Arch on the_box runs Node 24 (ABI 137). Prebuilt `.node` binaries shipped over from WSL were ABI-incompatible.
**Notes:** `npm rebuild` was sufficient — no need for the full `rm -rf node_modules && npm install` from the prior entry. Lighter touch: keeps lockfile and tree intact, just recompiles natives. Worth trying first whenever a port hits ABI mismatch.

---
## 2026-05-10 — First end-to-end deploy from the_box; documented in DEPLOY.md
**What:** Shipped three features (swipe-to-delete, home-screen cleanup, markdown export) as four commits to `main`, pushed to GitHub, and synced the droplet. Service is `active` at workouts.cmon1975.com. 110/110 tests green.
**Why:** Features were ready and the prior deploy path was undocumented; the_box is the new dev machine post-WSL.
**Notes:** Several surprises that are now captured in DEPLOY.md so future-me doesn't re-derive them:
- Droplet's `/var/www/workouts` had no `.git` (was originally `scp`'d in). Bootstrapped with `git init -b main` + `git remote add origin … github.com:CMON1975/workouts.git` + `git fetch` + `git reset --hard origin/main`.
- No GitHub deploy key existed for the `c` user on the droplet. Generated `~/.ssh/id_ed25519`, added the pubkey to the repo's Deploy Keys (read-only).
- ACL had to grant **both** `c` (rwx for deploys) **and** `workouts` (rX for the systemd service). First attempt only added `c`; new files post-reset locked out the service and it crash-looped 50+ times until `setfacl -R -m u:workouts:rX -d -m u:workouts:rX` landed.
- Prod DB is at `/var/lib/workouts/workouts.db`, not `/var/www/workouts/data/` (the latter is empty on the droplet — `DB_PATH` in `/etc/workouts.env` points at `/var/lib/...`, and the systemd unit's `ReadWritePaths` matches). So git operations on the working tree *cannot* affect prod data.
- SQLite backup gotcha: with WAL mode and an uncheckpointed WAL (large `.db-wal` vs small `.db`), plain `cp` and `sqlite3 .backup` both produced empty backup files. **`VACUUM INTO` worked** — produces an atomic consistent snapshot regardless of WAL state.
- `err.log` is append-only; we wasted ~20 min chasing old EACCES entries that had been resolved by the ACL fix. `systemctl status` for current state is the source of truth.

---
## 2026-05-17 — Added `--since Nd` flag to markdown export
**What:** Extended `scripts/export.js` with `--since <Nd>` (e.g. `--since 7d`) to limit the rendered Markdown to sessions finalized within the last N days. Window is also printed in the header as `_Window: last 7 days_` so the consuming LLM knows what it's looking at. 114/114 tests green.
**Why:** The export script previously dumped all finalized sessions, which was fine when the prod DB only held a few days of data but no longer matches how I want to feed weekly snapshots to an LLM.
**Notes:** TDD'd — added failing tests for the renderer header, CLI happy path, and invalid-duration rejection before implementing. Parser intentionally accepts only `Nd` (whole days); didn't add `Nh`/`Nw`/absolute dates since YAGNI. Filter applied in SQL (`finalized_at >= @since`); workouts with no in-window children just produce no output since the renderer flattens children to top-level entries anyway.

---
## 2026-05-17 — Export filenames now dated; same-day re-run overwrites only that day
**What:** Changed `scripts/export.js` to write `workouts-YYYY-MM-DD.md` (UTC) instead of a fixed `workouts.md`. JSON output (`--with-json`) gets the same date suffix. Updated top-of-file doc + CLI usage string.
**Why:** Avoid silently destroying older snapshots when running the export weekly. Each run becomes a new dated file; only re-runs within the same UTC day overwrite.
**Notes:** No flag — replaced the default outright. Same-day re-runs intentionally still clobber (typical case is "redo, I made a mistake"). Consumer side is just a Claude Code instance pointed at the directory, no script update needed there.
