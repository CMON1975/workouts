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
- **`data/` is gitignored, but the production DB doesn't live there.** The
  systemd unit has `ReadWritePaths=/var/lib/workouts` and the prod env file
  at `/etc/workouts.env` sets `DB_PATH=/var/lib/workouts/workouts.db`. So
  the working tree at `/var/www/workouts/data/` is empty in prod; `git pull`
  cannot affect prod data.
- **Apache** doesn't need a restart for code changes; it only proxies
  `/api/*` to `127.0.0.1:8787` and serves `public/`. Restart Apache (and
  copy the file into `/etc/apache2/sites-available/`) only if you edit
  `deploy/apache-workouts.conf`.
- **Rollback**: on the droplet,
  `git reset --hard HEAD~1 && sudo systemctl restart workouts`
  (or check out a known-good SHA).
- **`err.log` is append-only.** Old crash entries persist forever; don't
  diagnose from a `tail` alone. After a fix, check
  `systemctl status workouts` for *current* state and `journalctl -u workouts
  --since "1 minute ago"` for recent restart attempts.

## Backing up the prod DB

Before risky operations, snapshot the live DB. Plain `cp` and
`sqlite3 .backup` can both produce stale copies if the WAL is
uncheckpointed (which is common — see file sizes; if `workouts.db-wal`
is large, the WAL has data the main file doesn't). **Use `VACUUM INTO`**:

```
mkdir -p ~/workouts-backups
sudo sqlite3 /var/lib/workouts/workouts.db \
  "VACUUM INTO '/home/c/workouts-backups/workouts-pre-deploy.db';"
sudo chown c:c /home/c/workouts-backups/workouts-pre-deploy.db
sqlite3 /home/c/workouts-backups/workouts-pre-deploy.db \
  "SELECT 'routines: ' || COUNT(*) FROM routines;
   SELECT 'templates: ' || COUNT(*) FROM templates;
   SELECT 'sessions: ' || COUNT(*) FROM sessions;
   SELECT 'workouts: ' || COUNT(*) FROM workouts;"
```

Confirm the counts match expectations before proceeding.

## First-time setup on a fresh droplet user

If you're deploying from a non-`workouts` user (e.g. `c`) and `git pull`
isn't documented as working yet, you need three things:

1. **GitHub deploy key**, owned by the deploying user:
   ```
   ssh-keygen -t ed25519 -C "droplet-deploy" -f ~/.ssh/id_ed25519 -N ""
   cat ~/.ssh/id_ed25519.pub
   ```
   Add the pubkey to <https://github.com/CMON1975/workouts/settings/keys>
   as a deploy key with "Allow write access" **unchecked** (pull-only is
   enough; reduces blast radius if the droplet is ever compromised).
   Test: `ssh -T git@github.com` → "Hi CMON1975/workouts! You've
   successfully authenticated…"

2. **ACL granting both the deploying user (writes) AND the service user
   (reads) access to `/var/www/workouts`.** Without the `workouts` entry,
   files created by `c` via `git reset --hard` will lock out the systemd
   service:
   ```
   sudo setfacl -R -m u:c:rwx,u:workouts:rX,m::rwx /var/www/workouts
   sudo setfacl -R -d -m u:c:rwx,u:workouts:rX,m::rwx /var/www/workouts
   ```
   The `-d` form sets the *default* ACL so files created by future
   `git pull`s inherit the same perms. `rX` on the workouts user means
   read on files, traverse on dirs.

3. **`safe.directory` in git config**, because the working tree is owned
   by `workouts:workouts` but you're running git as `c`:
   ```
   git config --global --add safe.directory /var/www/workouts
   ```

If the droplet never had a `.git` directory (e.g. the working tree was
`scp`'d in originally), bootstrap it once:
```
cd /var/www/workouts
git init -b main
git remote add origin git@github.com:CMON1975/workouts.git
git fetch origin
git reset --hard origin/main
```

## First-time droplet setup (whole-box)

See `deploy/workouts.service`, `deploy/apache-workouts.conf`,
`deploy/logrotate-workouts`. Required env vars are listed in `.env.example`;
the production env file lives at `/etc/workouts.env` (chmod 600).
