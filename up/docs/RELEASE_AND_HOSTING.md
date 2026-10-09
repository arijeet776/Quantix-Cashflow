# Release, Hosting and Connection Check

## Topology
- **Frontend**: static Vite/React build → Netlify (`netlify.toml`, SPA fallback, security headers). Needs only `VITE_API_BASE_URL` (public) = `https://<backend-host>/api/v1`.
- **Backend**: FastAPI container (`backend/Dockerfile`) on a separate host (Render, Fly.io, Railway, a VPS, Cloud Run…). **Netlify does not host it.** Netlify Functions are not a substitute.
- **Storage**: `STORAGE_BACKEND=google_sheets` (Apps Script web app) or `mongodb_supabase`. Only the backend talks to Apps Script.

## Secrets (backend private environment only)
`GOOGLE_SHEETS_API_SECRET`, `GOOGLE_SHEETS_{CORE,TRACKING,FINANCE}_API_URL` (the URL itself is also treated as private: anyone with URL + secret can use the API), JWT/other secrets as in `backend/.env.example`. Put them in the host's secret manager. Never in `VITE_*` variables, the repo or the ZIP. If a real secret was ever committed or pasted somewhere public, rotate it (change the `API_SECRET` Script Property and the backend variable together).

## Backend variables to set on the host
`APP_ENV=production`, `STORAGE_BACKEND=google_sheets`, the three Sheets URLs (same `/exec` URL is fine), `GOOGLE_SHEETS_API_SECRET`, `ALLOWED_ORIGINS=https://<your-netlify-site>` (exact origin, no `*`), `FORWARDED_ALLOW_IPS=<proxy>`, plus the other production values in `backend/.env.example`. Auth uses bearer tokens (no cookies), so cross-origin CORS is enough.

## Verify the real Apps Script connection (run where the backend runs)
```
export GOOGLE_SHEETS_CORE_API_URL=... GOOGLE_SHEETS_TRACKING_API_URL=... GOOGLE_SHEETS_FINANCE_API_URL=...
export GOOGLE_SHEETS_API_SECRET=...        # set in your shell/secret manager, do not paste into files
python3 backend/tools/check_sheets_connection.py
```
Checks ping/auth, wrong-secret refusal, read-only counts on Users/Clicks/FinancialLedger, then writes one `__quantix_connection_test__<time>` row in `Settings`, reads it back and deletes it. It never touches conversions, ledger, wallet or withdrawals and never prints the secret. Exit 0 = pass, 1 = fail, 2 = not configured.

## Netlify steps (manual, as no Netlify connector was available)
1. Connect the repo (or drag-drop the built `frontend/dist`); `netlify.toml` supplies base/command/publish/redirects.
2. Site settings → Environment variables → `VITE_API_BASE_URL=https://<backend-host>/api/v1`.
3. Deploy a **preview** first; promote to production only after the backend is live and `ALLOWED_ORIGINS` includes the site origin.
4. A `package-lock.json` is not in the repo: run `npm install` once, commit the lockfile, then change the build command to `npm ci`.
