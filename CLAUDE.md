# Workouts Tracker

Personal single-user workout tracker hosted at workouts.cmon1975.com
on my Digital Ocean droplet.

## Stack (locked)
- Backend: Node + Fastify + better-sqlite3
- Frontend: vanilla HTML/CSS/JS, no bundler, no framework
- Auth: single bcrypt-hashed password in env var, signed session cookie
- Deploy: `git pull && systemctl restart workouts` on the droplet

## Non-negotiables
- Mobile-first. Must survive iPhone tab sleep / eviction without
  data loss — this is the #1 requirement.
- No build step. No frameworks. One package.json.
- Local-first persistence on every input change, server sync on
  debounce.

## Droplet context
- Ubuntu, nginx + certbot already configured for other subdomains
- Will add a new server block for workouts.cmon1975.com
- Systemd unit for the Node process