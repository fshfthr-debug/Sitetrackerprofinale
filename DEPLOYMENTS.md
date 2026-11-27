# Which deployment is which

There are two separate projects here, and two live copies of the app. Nothing in this file
changes how either one runs; it exists so the names stop getting mixed up.

## 1. The websites

| Project | GitHub repository | What it is |
|---|---|---|
| **Timona Geospatial Survey** (marketing site) | `fshfthr-debug/timonageospatialsurvey` | The public survey-company website: home page, services, training, contact. It also carries an old, cut-down copy of SiteTrackerPro (`frontend/src/App.jsx` only, no GIS, no icon set), which is not the app that is maintained. |
| **SiteTrackerPro** (the application) | `fshfthr-debug/Sitetrackerprofinale` | The real product. The app lives in `sitetrackerpro-app/`; the repository root also holds the static pages, `render.yaml` and the root `Dockerfile` used by Render. |

All application work — icons, themes, GIS, 3D viewer, CAD import — is committed to
`Sitetrackerprofinale`, branch `main`.

## 2. The two Render services

Both services build from the **same** repository and branch, so every push to `main` deploys
to both of them, usually within a few seconds of each other. They are identical in code and
differ only in their environment (database, storage, secrets).

| | Production | Preview / staging |
|---|---|---|
| Address | https://sitetrackerprofinale-caqf.onrender.com | https://sitetrackerpro-9xp5.onrender.com |
| Render service id | `srv-dc264eu8bjmc739tunj0` | `srv-dbugtrhsrm7s73er9c2g` |
| Render service name | `sitetrackerprofinale-caqf` | `sitetrackerpro-9xp5` |
| Database | the one holding the real accounts and projects | a separate database |
| Object storage bucket | `sitetrackerpro-files` | `sitetrackerprofinale` |
| Health check | `GET /health` | `GET /health` |

### The consequences, stated plainly

- **Sign-in only works on the service that holds the account.** An account created on the
  production service does not exist on the preview service, because they point at different
  databases. The password is correct; the user is simply not in that database. Registration is
  closed on both (`DISABLE_REGISTRATION=1`), so the account cannot be recreated from the login
  screen either.
- **Files uploaded to production are not currently being stored.** Its `/health` reports
  `storage.check.ok: false` with *"the storage keys were rejected"* for bucket
  `sitetrackerpro-files`. Imports and BIM models uploaded there will fail until its `S3_*`
  environment variables are corrected.

## 3. Fixing the two issues (Render dashboard, no code change)

Neither fix deletes anything.

**A. Same login on both services** — pick the database that holds the real accounts
(production) and give the preview service the same connection:

1. Render → the `sitetrackerprofinale-caqf` service → **Environment** → reveal `DATABASE_URL`
   and copy its value.
2. Render → the `sitetrackerpro-9xp5` service → **Environment** → paste that value into
   `DATABASE_URL` → Save (this triggers a redeploy).
3. Optional, so a session started on one service stays valid on the other: copy `JWT_SECRET`
   the same way. Changing it signs everybody out once.

If you would rather keep the preview database separate, then create your own account on the
preview service instead, by temporarily removing `DISABLE_REGISTRATION` on that service only,
registering, and setting it back to `1`.

**B. Working uploads on production** — copy the storage settings across from the preview
service, which is verified working (`/health` reports `storage.check.ok: true`):

1. On `sitetrackerpro-9xp5`, reveal and copy `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`.
2. Paste them into `sitetrackerprofinale-caqf` → Save.
3. Decide the bucket: either create/point `sitetrackerpro-files`, or set production's
   `S3_BUCKET` to `sitetrackerprofinale` so both services share the one bucket that works.
4. Re-check `https://sitetrackerprofinale-caqf.onrender.com/health` — `storage.check.ok` must
   read `true` before importing models on the production site.

## 4. How a change reaches you

```
edit → commit to Sitrackerprofinale/main → both Render services rebuild → verify /health and
the served build (index.html references the same main.<hash>.js on both)
```

Both services are checked after a deploy by comparing the JS/CSS hash in the served
`index.html` against the freshly built one; a successful upload alone is not treated as proof.
