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

---
## 2026-05-17 — Edit-routine add/remove parity + template safe-field edit dialog
**What:** Edit-routine view now exposes the available-exercises picker and the per-row remove button in edit mode (previously create-only). Added an inert info banner explaining that past workouts keep their original exercises. Replaced the Rename prompt in Manage with an Edit dialog covering name, description, default_rows, and rows_fixed (hidden for checkbox kind). 114/114 tests green.
**Why:** Routines were effectively frozen post-create; only reordering was possible. The user needs to iterate routine membership between workouts. Template metadata (description, default sets, locked-sets) was patchable via the server but had no UI.
**Notes:** Pure frontend change. Server PATCH /api/routines/:id and PATCH /api/templates/:id already covered everything; existing 409 guard on active workouts still applies. History stays safe because sessions reference live template_id and FK RESTRICT blocks hard deletes; removing a template from a routine never touches past finalized workouts. Column-level edits (rename/remove/value_type) deferred — would need a snapshot/versioning scheme to keep historical session_values interpretable.

---
## 2026-05-17 — Per-session notes (input, last-note hint, history display)
**What:** Wired the existing `sessions.notes` column end-to-end: optional textarea below the value rows in both standard and checkbox session forms; "Last note: ..." hint pulled from the previous finalized session of the same template ("No previous note." when absent); read-only notes shown in the History detail view (standalone sessions and workout-child rows). Server-side, added `notes` to the SELECT in `GET /api/templates/:id/last-session` and to both child-session SELECTs in `/api/workouts` (single and list). 117/117 tests green.
**Why:** The export pipeline at `scripts/export.js:77` already prints `**Notes:** ...` for the weekly LLM analysis, but the user had no UI to capture them. Per-session capture; no carry-forward — decay happens automatically when a session is left noteless (the textarea starts empty each session, so an unwritten session yields a `null` notes value, which surfaces as "No previous note." next time).
**Notes:** TDD'd the two SELECT gaps and pinned a drafts round-trip regression test. Frontend reuses the existing `onInput` mutator path in session-state.js — a single `d.notes = v === '' ? null : v` line keeps the debounce, shadow, IDB, and sendBeacon paths working with zero state-machine churn. No IDB schema bump (extra field on existing draft object). Textarea is `readonly` on finalized sessions. UUID-fixture collision with an existing sessions exclusion test cost a few minutes — bumped my fixture indexes from 40/41 to 80/81.

---
## 2026-05-17 — Column-level template editing (rename, unit, add, reorder)
**What:** Extended `PATCH /api/templates/:id` to accept a `columns` array. Each item may carry `{ id?, name, unit?, value_type? }`. Items with `id` update name/unit/position on an existing column; items without `id` insert new columns with `value_type` (default `number`). Position is implicit from array order. Omitting a column does NOT delete it (explicitly out of scope this pass). Active-workout guard: 409 if any unfinalized workout exists against any routine containing this template. The Edit Exercise dialog gained a column builder with up/down reorder for every row, name/unit inputs for every row, and an "+ Add column" button that creates new rows with a value-type selector + delete button. Unit changes on existing columns trigger a single confirm() warning before save. 126/126 tests green.
**Why:** The Edit dialog only let you rename the template, tweak description/default-rows/lock-sets. Column-level edits (name, unit) were immutable post-create, which meant the placeholder ghost text in the session form was effectively locked to whatever you typed first. The user wanted to be able to relabel "reps" → "repetitions" or change "kg" → "lb" (the latter is a foot-gun so it warns first).
**Notes:** Server uses a "shift positions by +10000 then re-stamp" trick inside the transaction so the unique `(template_id, position)` index doesn't fire mid-update during a reorder. Value-type changes on existing columns and column removal are deliberately excluded — both have history implications (`session_values.column_id` is `RESTRICT`, and a type flip would scramble `value_num` vs `value_text` rendering); deferred to a future pass with a proper snapshot/soft-delete design. Nine new server tests cover: rename preserves session_values, unit change, add, reorder, no-implicit-delete, blank name, foreign id, dup names, and the 409 active-workout guard with a follow-up assertion that the same patch succeeds after finalize.

---
## 2026-05-19 — Convert auth from password to tailnet binding
**What:** Removed in-app password auth (bcrypt, signed cookies, login UI, rate-limited /api/login) and replaced it with the overmind-style pattern: Apache vhost binds to the droplet's tailscale IP, public DNS resolves to that 100.x address, cert issued via DNS-01. buildApp signature simplifies to `{ dbPath, logger }`. Strips ~80 frontend lines (login section, handleLogin, api.login/logout, logout button, CSS). Adds `deploy/install-apache.sh` to substitute `__TAILSCALE_IP__` and reload Apache. 4 commits on `refactor/tailnet-auth`; 118 tests green (was 126; 8 deletions: 5 "requires auth" cases + 1 wrong-password test + 2 login-rate-limit cases from hardening, replaced by 3 new hardening tests covering reachability + global rate-limit + per-XFF keying).
**Why:** Single-user app with the iPhone always on the tailnet; the password layer was overhead with no real attack surface left after closing public reachability. Same model already proven on overmind. Eliminates rotating the password hash and managing SESSION_SECRET, and any cookie-replay / credential-leak class of issues stops being a concern.
**Notes:** Branch not yet merged or deployed. One-time droplet migration documented in DEPLOY.md (DNS swap to tailnet IP, certbot reissue via DNS-01, run install-apache.sh, strip PASSWORD_HASH/SESSION_SECRET from /etc/workouts.env, restart). Also deleted scripts/dev-tunnel.sh (ngrok no longer needed — phone reaches the_box's tailscale IP directly during dev) and scripts/hash-password.js. PLAN.md left as-is — historical snapshot of original design intent.

---
## 2026-06-01 — Drag-and-drop reorder for routines
**What:** Routines now have a user-defined display order set by dragging cards on Routines -> Manage. New `sort_position` column (migration 005, backfilled alphabetically), `GET /api/routines` orders by it, new `PUT /api/routines/order {ids:[...]}` persists a reorder, and `POST` appends new routines to the end. Client: pointer-based drag controller (touch + mouse) in `renderRoutineManageList`, optimistic reorder with rollback in `handleRoutineReorder`, and both Home and Manage now sort by `sort_position`. 125 tests green (7 new in routines.test.js).
**Why:** User wanted to control the order routines appear in (and start workouts from), not the fixed alphabetical sort.
**Notes:** Native HTML5 DnD doesn't fire on iOS Safari (the primary device), so the handle uses Pointer Events with `setPointerCapture` + a fixed-position dragged card and a flow placeholder; handle has `touch-action:none` so vertical drags don't scroll. Only active routines are draggable; archived stay pinned at the bottom by name. No frontend test harness exists, so the drag interaction itself is verified manually on device; server side is TDD. Verified end-to-end locally: migration backfilled the existing data/workouts.db cleanly, reorder/404/400 all confirmed via curl.

---
## 2026-06-08 — Pulled latest prod data; regenerated markdown export
**What:** Snapshotted the live droplet DB and swapped it into local `data/workouts.db` (101 sessions / 26 workouts / 7 routines, latest finalized 2026-06-06), then `npm run export -- --out .` produced `workouts-2026-06-08.md` (257 sets). Backed up the prior local DB to `data/workouts.db.local-bak-20260608-091917`.
**Why:** Routine refresh of local data for LLM analysis.
**Notes:** Prod DB at `/var/lib/workouts/workouts.db` is mode 644 (world-readable), so `VACUUM INTO` runs as user `c` over plain `ssh cmon` — **no sudo needed**, unlike the DEPLOY.md "Backing up the prod DB" recipe. sudo on the droplet is NOT NOPASSWD, so the sudo path can't run non-interactively anyway; the 644 perms make it moot. WAL was 4MB uncheckpointed vs a 168KB main file — `VACUUM INTO` (not `cp`) was essential for a consistent snapshot. Migrations 001–005 all present in the pulled DB; `sort_position` confirmed.

---
## 2026-06-14 — Prescriptions: external weekly plan injection (server + client)
**What:** Added a "prescription" concept so an external health-planning workspace can POST a week of target reps/weights/cues per routine and the app renders them next to the inputs during execution. Two SQLite migrations (006 `prescriptions` + `prescription_targets`, 007 `workouts.prescription_id`), new `server/routes/prescriptions.js` exposing `POST /api/prescriptions/import` + `GET /api/prescriptions/active`, one-line workouts-route extension to stamp `prescription_id` at create, renderer/api/css additions to display `.target-hint` and (newly) standard-template `description`. 149 tests green (24 new in `prescriptions.test.js`).
**Why:** Replaces a manual loop where the prescription author was jamming target values into `template_columns.unit` (visible as `weight (12.5 lbs x 2)` placeholder text) and re-editing those strings every week. Now Sunday's workflow is a single POST.
**Notes:**
- `POST /api/prescriptions/import` is coarse-grained, single-transaction. Find-or-create routine + templates by name. Active-workout gate fires 409 unless `finalize_pending: true` (Sunday opt-in), then empty drafts get deleted and drafts-with-data get finalized at `now`. Hard caps `max_new_routines` / `max_new_templates` default to 2/5 to catch typos. Column-shape mismatches on existing templates return 409 `template_shape_mismatch` naming the offending column.
- Prescriptions are immutable per workout: `workouts.prescription_id` is stamped once at create via "most recent `starts_on <= started_at_date` for this routine" and never re-stamped on subsequent PATCH. Re-importing for the same `(routine, starts_on)` inserts a NEW row (no UNIQUE constraint), preserving the FK from old workouts.
- Description on import: when an existing template gets a `description` in the JSON, the route UPDATEs the template's description. Omitting `description` leaves the prior value alone. Standard templates now render `template.description` above the rows (was checkbox-only before).
- Renderer: `applyPreviousHints` signature extended to take `prescribed`. `.target-hint` is a distinct CSS class from `.prev-hint` so prescribed vs last-actual stay visually separable. Input placeholder dropped the `(unit)` interpolation so stale-target hacks in `template_columns.unit` don't ghost-render anymore; blue `.target-hint` carries the prescribed value with `cue`.
- Followups noted but not done: `template_columns.unit` is still rendered in `renderHistoryList`'s summary line and the detail-view table headers — same stale-target hack, same fix shape if/when user asks.
- Deploy: pushing both repos and bouncing the droplet's systemd unit; prod DB backup taken first via `VACUUM INTO`. Both migrations are pure additive (CREATE TABLE / ADD COLUMN NULL), no rewrites, no in-flight draft risk.
