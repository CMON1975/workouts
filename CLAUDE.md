# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Workouts Tracker

Personal single-user workout tracker hosted at workouts.cmon1975.com
on my Digital Ocean droplet.

## Stack (locked)
- Backend: Node + Fastify + better-sqlite3
- Frontend: vanilla HTML/CSS/JS, no bundler, no framework
- Auth: none in-app. The Apache vhost is bound to the droplet's
  tailscale IP, so the tailnet is the auth boundary. See DEPLOY.md.
- Deploy: `git pull && systemctl restart workouts` on the droplet

## Non-negotiables
- Mobile-first. Must survive iPhone tab sleep / eviction without
  data loss — this is the #1 requirement.
- No build step. No frameworks. One package.json.
- Local-first persistence on every input change, server sync on
  debounce.

## Droplet context
- Ubuntu, Apache + certbot already configured for other subdomains
- Will add a new vhost for workouts.cmon1975.com (see `deploy/apache-workouts.conf`)
- Systemd unit for the Node process (see `deploy/workouts.service`)

## Commands

- `npm run dev` — Fastify with `--watch` and `--env-file=.env`. Default port 8787.
- `npm test` — Node's built-in test runner over `server/*.test.js` and `server/**/*.test.js`.
- `node --test --test-name-pattern='<regex>' server/routes/templates.test.js` — run a single file or filter by name.
- `npm run seed` — wipes `data/workouts.db` and reseeds broad fixtures. Refuses if `NODE_ENV=production` or `DB_PATH` escapes `./data`.
`.env` only needs `DB_PATH`, `PORT`, `HOST`, `NODE_ENV` (see `.env.example`). No secrets — there is no in-app auth.

## Architecture

### Data model (see `server/migrations/`)

- **templates** — exercise definitions. `kind = 'standard'` (rows × columns) or `'checkbox'` (done/not-done; `description` is required and rendered as the prompt). Standard templates have `template_columns` (ordered, with `value_type` ∈ number/text/duration) and `template_defaults` (default_rows, rows_fixed).
- **routines** — named ordered collections of templates (`routine_templates` join with `position`). Run as a single workout.
- **workouts** — one *run* of a routine. UUIDv7 string PK. `finalized_at` nullable.
- **sessions** — one template's worth of data. UUIDv7 string PK. May belong to a workout (`workout_id`) or be ad-hoc (`workout_id IS NULL`). `finalized_at` nullable distinguishes draft from finalized — there is no separate drafts table.
- **session_values** — tall/narrow `(session_id, row_index, column_id) → value_num | value_text`. Designed for SQL queries later (charts, PRs).

### Sync model — the load-bearing part

Client mints UUIDv7 ids so sessions/workouts can start fully offline and PATCHes are idempotent. Every mutation carries a monotonic `client_version`; server uses LWW by `client_version` (with `updated_at` only as tiebreaker) and rejects stale writes with 409 + `server_version`. Once `finalized_at` is set, draft PATCHes are no-ops.

Three-layer flush on `visibilitychange: hidden` / `pagehide` (in `public/js/persistence.js`):
1. Synchronous `localStorage` shadow write (survives mid-tick freeze).
2. IDB `put` (queued — WebKit usually drains before freeze).
3. `navigator.sendBeacon` to `/api/drafts/:id` (only network call guaranteed to leave during teardown — **do not** use `beforeunload`, unreliable on iOS).

Failed PATCHes go into an IDB `outbox` store; `drainOutbox` runs on `online` and `pageshow` with exponential backoff, supersedes older entries by `(url, method, draftId)` keeping highest `client_version`.

### Server

`server/index.js` exports `buildApp({ dbPath, logger })` for tests; the same module starts the listener when run directly. `server/db.js` opens the DB, sets pragmas (`WAL`, `synchronous=NORMAL`, `foreign_keys=ON`), and applies any unrun `migrations/*.sql` inside a transaction tracked in a `_migrations` table. Migrations are append-only — never edit an applied file; add a new numbered one.

Routes (`server/routes/`) do not gate on any in-app auth — Apache's tailnet-bound vhost is the network boundary. Global rate limit 300/min excludes `/assets/`. Body limits are tight (4–64 KiB per route).

### Frontend

Module split under `public/js/`:
- `app.js` — view router + top-level wiring; everything in `els` is queried from `index.html`.
- `api.js` — fetch wrapper.
- `idb.js` — IndexedDB stores: `drafts`, `meta`, `outbox`, `workouts`. Bump `DB_VER` and add an `onupgradeneeded` branch when schema changes.
- `persistence.js` — three-layer flush + outbox drainer described above.
- `session-state.js` — per-session state machine + debounced saver.
- `renderer.js` — renders forms from `template_columns` and history/detail views.
- `uuidv7.js` — ~20-line UUIDv7 impl.

## Testing

Use Node's built-in test runner (`node:test`, `node:assert/strict`). Each route has a sibling `*.test.js` that:
- builds a fresh app with `buildApp({ dbPath: <tmpdir>, logger: false })`,
- uses `app.inject({ method, url, payload })` rather than a live socket.

`server/hardening.test.js` exercises rate-limit and auth behavior end-to-end. Keep tests hermetic — no shared DB between files.

## Conventions worth knowing

- Numbered SQL migrations (`NNN_name.sql`) applied automatically on `openDb()`. Add a new file; never mutate an existing one.
- Reordering or replacing a routine's templates is rejected with 409 if any workout against that routine is unfinalized — the user must end or finalize first.
- Checkbox templates: server fills in the single `completed` column and `rows_fixed=1`; client only sends `name` + `description`.
- Apache vhost binds to the droplet's tailscale IP (not `*:80/443`), terminates TLS, serves `public/` directly, and proxies `/api/` to `127.0.0.1:8787` (`X-Forwarded-Proto: https`); Fastify runs with `trustProxy: true`. The cert is issued via certbot-dns-cloudflare DNS-01 because the host isn't publicly reachable.
