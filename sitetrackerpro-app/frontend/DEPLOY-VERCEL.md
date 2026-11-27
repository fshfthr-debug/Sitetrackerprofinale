# Deploying the frontend on Vercel

The app is a Create React App. Vercel builds it with `npm run build` and serves
`build/`; the included `vercel.json` sets that up and rewrites unknown paths to
`index.html` so a refresh never lands on a 404.

## 1. Import the project

1. In Vercel: **Add New → Project**, then import the GitHub repository
   (`fshfthr-debug/Sitetrackerprofinale`).
2. Set **Root Directory** to `sitetrackerpro-app/frontend`. This matters: the
   repository root also holds the marketing site and the backend, which are not
   part of this build.
3. Framework preset should read **Create React App**. Build command
   `npm run build`, output directory `build` (already in `vercel.json`).
4. Add one environment variable, for all environments:

   | Name | Value |
   | --- | --- |
   | `REACT_APP_API_URL` | `https://sitetrackerprofinale-caqf.onrender.com` |

   This is the API origin, no trailing slash. Without it the app calls `/api`
   on the Vercel domain and every screen comes up empty.
5. **Deploy.** The first build takes a few minutes (the 3D and CAD libraries are
   large).

## 2. Let the API accept the Vercel domain

The backend only answers cross-origin requests from origins listed in
`CORS_ORIGIN`, so the new domain must be added or sign-in and data will fail
with a CORS error in the browser console.

In the Render dashboard for `sitetrackerprofinale-caqf` → **Environment**, set:

```
CORS_ORIGIN=https://your-project.vercel.app
```

Comma-separate several origins if you need more than one, with no trailing
slashes. A `*` is refused by design. Save; Render redeploys in about two minutes.

## 3. Deploying again later

Push to `main`. Vercel rebuilds the frontend and Render rebuilds the backend
automatically. Remember to redeploy the Vercel project after changing
`REACT_APP_API_URL`, because environment variables are baked in at build time.

## Notes

- Preview deployments get a fresh hostname each time. Either add that hostname
  to `CORS_ORIGIN` temporarily, or attach a custom domain to production and
  share that.
- Large IFC / CAD / DEM uploads go straight to the Render API, not through
  Vercel, so Vercel's request size limits do not apply.
- The marketing pages (`index.html`, `sitetrackerpro.html`, `training.html`) at
  the repository root are a separate static site; they are not part of this
  Vercel project.
