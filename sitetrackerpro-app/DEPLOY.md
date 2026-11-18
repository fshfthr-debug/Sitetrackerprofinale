# Deploying the real SiteTrackerPro

This folder is the production build of SiteTrackerPro v3: the React app is already
compiled into `backend/public`, and the Express API serves both it and the database
endpoints from a single origin. Clients get one URL, real logins and shared data.

**Why it needs its own host:** the marketing site is static files on a global CDN.
SiteTrackerPro is a Node.js server with a PostgreSQL database and file uploads —
a long-running process that must stay awake. That is why it cannot live in the same
place as the website.

---

## What you need

| Item | Detail |
|---|---|
| Server | Any Ubuntu 22.04/24.04 machine, 1 GB RAM is enough to start |
| Database | PostgreSQL 14 or newer (installed by the script) |
| Domain | Optional but recommended, e.g. `app.timonageospatialsurvey.com` |
| Cost | Roughly $11–14/month on a managed host; a small VPS is similar |

---

## Route A — no server to look after: managed database + managed host (easiest)

This is the route to take if you do not want to administer a server. Two free-tier
services do all the machine-keeping:

- **Neon** (`neon.tech`) — the PostgreSQL database. Free plan, no card required.
- **Render** (`render.com`) — runs the Node app and gives you an HTTPS address.

The app understands a single `DATABASE_URL`, so the five separate `DB_*` settings
are not needed here.

### 1. Create the database (Neon)

1. Sign up at `neon.tech`, create a project. Choose the region closest to your
   users (Europe/Frankfurt is the shortest path from Ethiopia).
2. Copy the **connection string** it shows you. It looks like
   `postgresql://user:password@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`.
   Treat it like a password.
3. Load the tables: open **SQL Editor** in Neon, paste the whole contents of
   `database/schema.sql` from this folder, and run it once. (Alternative, if you
   have `psql` installed: `psql "PASTE_THE_URL" -f database/schema.sql`.)
   Running it twice is harmless — every statement is `IF NOT EXISTS`.

### 2. Put the app online (Render)

1. Sign up at `render.com` and put this folder in a GitHub repository (Render
   deploys from Git). Private repository is fine.
2. **New → Web Service**, pick the repository.
3. Fill in exactly these:

   | Field | Value |
   |---|---|
   | Root Directory | `sitetrackerpro-app/backend` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |

4. Under **Environment**, add:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from step 1 |
   | `JWT_SECRET` | a long random string, 32+ characters (see below) |
   | `NODE_ENV` | `production` |
   | `TRUST_PROXY` | `1` |

   `JWT_SECRET` signs every login token; the app refuses to start without a real
   one. Generate it with `openssl rand -hex 32` (or `python3 -c "import secrets;print(secrets.token_hex(32))"`),
   or simply type 40+ random characters. Never reuse it anywhere else.

5. Deploy. The first build takes a few minutes. When it finishes, open the URL
   Render gives you — that is the app, with the login screen.
6. **Create the first account** (it is your admin login), then set
   `DISABLE_REGISTRATION=1` in the environment and redeploy so nobody else can
   sign themselves up.

### 3. Your own address

In Render: **Settings → Custom Domains**, add `app.timonageospatialsurvey.com`,
then create the CNAME record Render shows you at your domain registrar. HTTPS is
issued automatically.

### What the free tiers do and do not do

- Neon free: one small database, plenty for a first deployment. Take the backup
  before you grow into it.
- Render free: the app **sleeps after ~15 minutes idle** and takes ~50 seconds to
  wake on the next visit. Fine for a pilot; move to the paid instance (~$7/month)
  when clients use it daily.
- Uploaded BIM files live on the host's disk, which is wiped on each redeploy on
  the free plan. The database is unaffected. Keep the original take-off files.

---

## Route B — a managed server you control

1. Create a Node.js server plus a PostgreSQL database with your host.
2. Upload this folder to the server (Git, SFTP or the host's file manager).
3. Their panel gives you the database host, port, name, user and password.
4. Run the installer with those values:

```bash
sudo APP_DIR=/opt/sitetrackerpro \
  DB_NAME=your_db DB_USER=your_user DB_PASS='your_password' \
  DOMAIN=app.yourdomain.com \
  bash deploy/install-ubuntu.sh
```

If the database is managed remotely, load the schema yourself once, pointing at it:

```bash
psql "postgresql://USER:PASS@HOST:5432/DBNAME" -f database/schema.sql
```

then set `DB_HOST` to the managed host in `backend/.env`.

---

## Route C — your own Ubuntu server

```bash
sudo apt-get update && sudo apt-get install -y rsync
sudo mkdir -p /opt/sitetrackerpro
sudo rsync -a ./ /opt/sitetrackerpro/
cd /opt/sitetrackerpro
sudo DOMAIN=app.yourdomain.com bash deploy/install-ubuntu.sh
```

The script installs Node 20, PostgreSQL and Caddy, creates the database and role,
loads the schema, writes a production `.env` with a fresh 64-character
`JWT_SECRET`, registers a systemd service that restarts on failure, checks
`/health`, and issues an HTTPS certificate for your domain. It is safe to re-run.

---

## After it is live

1. **Open the URL and register the first account.** That is your admin login —
   use your real email.
2. **Create a project**, then run one cut & fill calculation. If the numbers come
   back and survive a page reload, the database round-trip is working.
3. **Load your rates.** Materials carry sample rates; replace them with your
   current supplier prices per project.
4. **Close public sign-up** once your team and clients have accounts:
   set `DISABLE_REGISTRATION=1` in `backend/.env` and
   `sudo systemctl restart sitetrackerpro`.
5. **Set up nightly backups** (the kit includes one):

```bash
sudo chmod +x deploy/backup.sh
sudo crontab -e
# 15 2 * * * /opt/sitetrackerpro/deploy/backup.sh >> /var/log/sitetrackerpro-backup.log 2>&1
```

Copy those backups off the machine as well — a backup on the same disk as the
database is not a backup.

---

## Operating it

```bash
sudo systemctl status sitetrackerpro     # is it running
sudo journalctl -u sitetrackerpro -f     # live logs
sudo systemctl restart sitetrackerpro    # after editing backend/.env
```

**Updating the app later:** replace the files, then

```bash
cd /opt/sitetrackerpro/backend && npm install --omit=dev && sudo systemctl restart sitetrackerpro
```

**If the frontend changes**, rebuild it and copy it across:

```bash
cd frontend && npm install && npm run build
rsync -a --delete build/ ../backend/public/
```

---

## Security notes

- `backend/.env` holds the database password and the token-signing secret. It is
  written with mode `600`; never commit it or email it.
- The app hashes passwords with bcrypt and issues signed, expiring tokens.
- **Sign-in throttling.** Two limits apply. Per network address: 10 failed attempts
  in 15 minutes (successful sign-ins are not counted). Per account: 5 failed
  attempts lock that account for 15 minutes, whatever address the attempts come
  from. Unknown addresses are counted the same way and get the same reply, so the
  lockout cannot be used to find out which accounts exist. Tune with
  `LOGIN_MAX_FAILS` and `LOGIN_LOCK_MINUTES` in `backend/.env`.
- **Password policy.** At least 12 characters, not a well-known password, not the
  account's own email, no single repeated character pattern, and no more than 72
  bytes (the limit bcrypt can actually read). The same check runs when a password
  is changed, so a weak password cannot be swapped in later.
- **No database text in replies.** Every failure returns a short JSON message;
  stack traces, SQL and table names are written to the server log only. Malformed
  JSON, oversized uploads and unknown API paths all return JSON too.
- **Password changes.** Signed-in users rotate their own password from the app:
  the "🔑 Password" button in the navigation opens a screen with current password,
  new password and confirmation. It requires the current password, so a stolen
  token alone cannot take over an account. Underneath it is
  `POST /auth/change-password` if you ever need to script it.
- Uploaded BIM files are stored on disk — include the uploads folder in backups
  (the backup script does).
- Accounts are per person. There is no shared login, and each project belongs to
  the user who created it.
