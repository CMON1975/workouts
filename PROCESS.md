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
