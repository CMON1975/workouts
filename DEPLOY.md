# Deployment

End-to-end process for shipping changes to <https://workouts.cmon1975.com>.

## Local

```
git push origin main
```

## Droplet

SSH to the droplet (hostname kept locally, not in this repo).

```
cd /var/www/workouts
git pull
sudo systemctl restart workouts
```

## Verify

Tail the journal for ~10 seconds — make sure the new process boots clean:

```
sudo journalctl -u workouts -f
```

Then load <https://workouts.cmon1975.com> and click through the changed
feature.

## Notes

- **`npm install`** isn't needed unless `package.json` dependencies actually
  changed — check the diff first. Native modules (`better-sqlite3`, `bcrypt`)
  may need `npm rebuild` if Node's major version changed on the droplet.
- **Migrations** run idempotently on every boot via `openDb()` in
  `server/db.js`. Adding a new `server/migrations/NNN_*.sql` is enough; the
  restart picks it up.
- **Static client files** in `public/` are served directly by Apache from
  `/var/www/workouts/public`. They go live as soon as `git pull` finishes;
  the systemd restart isn't strictly required for client-only changes,
  but it's harmless.
- **`data/`** is gitignored — the production DB is untouched by `git pull`.
- **Apache** doesn't need a restart for code changes; it only proxies
  `/api/*` to `127.0.0.1:8787` and serves `public/`. Restart Apache (and
  copy the file into `/etc/apache2/sites-available/`) only if you edit
  `deploy/apache-workouts.conf`.
- **Rollback**: on the droplet,
  `git reset --hard HEAD~1 && sudo systemctl restart workouts`
  (or check out a known-good SHA).

## First-time setup

See `deploy/workouts.service`, `deploy/apache-workouts.conf`,
`deploy/logrotate-workouts`. Required env vars are listed in `.env.example`;
the production env file lives at `/etc/workouts.env` (chmod 600).
