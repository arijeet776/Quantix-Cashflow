# CHECKPOINT (resume here) — 2026-10-11

## Status legend
VERIFIED-OFFLINE = executed in sandbox with mocks/emulator · UNVERIFIED = written, not executed · BLOCKED = needs access.

## Done
| Item | Evidence |
|---|---|
| Sheets adapter + Apps Script (`gas/Code.gs`) | part18 87/87 (emulator running the real Code.gs) — VERIFIED-OFFLINE |
| Production-mode config guards | part19 32/32 — VERIFIED-OFFLINE |
| No-OTP approval login, DB-authoritative auth, parallel reads | part20 18/18 (simulated 50 ms latency, NOT real Apps Script) |
| First Super Admin CLI `backend/tools/create_first_super_admin.py` | part21 10/10 against in-memory fake storage; real adapter UNVERIFIED |
| Netlify SPA routing fix | `frontend/public/_redirects`, `frontend/netlify.toml`; syntax-checked only, NOT built/deployed |
| ErrorBoundary, 404 link, non-JSON API guard | syntax-checked only (no typecheck: npm registry unreachable) |

## Routing root causes (static analysis, unconfirmed on the live site)
1. `netlify.toml` lived at repo root with `base="frontend"`; if the Netlify base dir is already `up/frontend` it is never read -> no SPA fallback -> "Page not found" on /login and refresh. Fix: `_redirects` inside `public/` (always published) + config moved to `frontend/netlify.toml`.
2. If `VITE_API_BASE_URL` is unset, API calls go to the Netlify origin; the fallback answers them with index.html (200) -> login breaks silently. Fix: client now throws `API_UNREACHABLE` on non-JSON replies; **set `VITE_API_BASE_URL` in Netlify**.
3. No ErrorBoundary -> any render exception = white screen. Fixed.
4. Missing `/assets/*` must 404, not return HTML. Rule added.

## Env variables (names only)
Netlify: `VITE_API_BASE_URL` (REQUIRED, public https backend URL ending `/api/v1`). Never any secret in `VITE_*`.
Render required: `ENVIRONMENT=production`, `JWT_SECRET_KEY` (>=32 chars), `ALLOWED_ORIGINS` (exact Netlify origin, no `*`), `STORAGE_BACKEND=google_sheets`, `GOOGLE_SHEETS_CORE_API_URL`, `GOOGLE_SHEETS_TRACKING_API_URL`, `GOOGLE_SHEETS_FINANCE_API_URL`, `GOOGLE_SHEETS_API_SECRET` (>=32 chars, same as Apps Script `API_SECRET`).
Optional: `GOOGLE_SHEETS_TIMEOUT_SECONDS`, `GOOGLE_SHEETS_BUFFER_CLICKS`, `GOOGLE_SHEETS_CLICK_FLUSH_SECONDS`, `TRACKING_BASE_URL`, `BRAND_NAME`, `ACCESS_TOKEN_EXPIRE_MINUTES`, `REFRESH_TOKEN_EXPIRE_DAYS`.
Not needed in Sheets mode: `MONGO_URI`, `MONGO_DB_NAME`, `POSTGRES_DSN`. Conflicting: none found; `CORS_ALLOWED_ORIGINS` is an alias of `ALLOWED_ORIGINS` (set only one).
Apps Script Script Properties: `CORE_SPREADSHEET_ID`, `TRACKING_SPREADSHEET_ID`, `FINANCE_SPREADSHEET_ID`, `API_SECRET`.
Email: no provider exists (Console only) — password-reset OTP is not deliverable until one is added.

## First Super Admin
Existing `superadmin` row has role `superadmin` (invalid enum) -> can never log in. Do NOT edit it automatically. Safest: run the CLI to create a separate verified admin, log in, then decide about the old row manually.
`cd backend && python -m tools.create_first_super_admin --email <admin email>` (needs the Render env vars locally; prompts for the password; run only with your approval).

## Requirement matrix (honest, partial)
| Area | State |
|---|---|
| No-OTP registration + approval; pending/rejected login messages | Implemented, verified offline (mocks) |
| Collapsible sidebar / table scroll | Implemented; verified only on a static mock |
| Dashboard speed target 1–1.5 s | Implemented (parallel reads, Server-Timing); real latency BLOCKED (no Apps Script URL/secret here) |
| Netlify routing / white screens | Fix written; unverified until built+deployed |
| Full Publisher/Manager/Super Admin page-by-page audit | NOT done (needs running app) |
| Tracking / postback / financial end-to-end | NOT verified; no external callback tested |
| Security audit | Partial: DB-authoritative RBAC, no secrets in React confirmed by reading; full audit NOT done |
| Storage architecture | Recommendation: keep Sheets only as temporary; move financial ledger + clicks to a real DB (Postgres code already exists) before scale; no migration without approval |

## Blockers / access needed
- npm registry unreachable here: frontend typecheck/build/tests/browser run BLOCKED -> run `npm install && npm run build` on Netlify or locally.
- Netlify: read-only access to deploy log + build settings (base dir, publish dir, env var names) to confirm cause 1/2.
- Render: env var names + service logs (read-only) and real timing via `Server-Timing` header.

## Next
Build+deploy preview on Netlify, check /login direct open/refresh/logout; run CLI; measure `Server-Timing`; then page-by-page role audit.


---
# UPDATE 2026-10-12 — Supabase REST backend (user request: migrate off Google Sheets)

## Added
- `backend/migrations/supabase/001_quantix_schema.sql` (GENERATED, 27 tables, RLS on, anon/authenticated revoked, append-only ledger trigger, `qx_exec` engine). Generator: `tools/generate_supabase_sql.py` (+ `tools/supabase_functions.sql`).
- `backend/app/storage/supabase_adapter.py`, `runtime.py` / `config.py` wiring: `STORAGE_BACKEND=supabase_rest`, env `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_TIMEOUT_SECONDS`. Config refuses publishable/anon keys.
- `docs/SUPABASE_REST_BACKEND.md` (setup, keys, rollback). Server-Timing label is now `storage;`.

## Test evidence (executed here)
| Test | Result | Scope |
|---|---|---|
| part22 (part18 scenarios re-run + first-admin Z1-Z7) | 77/77 | REAL PostgreSQL 16 locally, real adapter/repositories; PostgREST/HTTPS replaced by psql call of same function |
| part23 | 22/22 | concurrency (6 parallel withdrawals -> exactly 2), rollback, CAS, append-only, SQL injection, anon/authenticated denied, RLS on all tables |
| part24 | 10/10 | config guards incl. publishable-key rejection (real config.py, shimmed pydantic_settings) |
| part18 / 19 / 20 / 21 | 87 / 32 / 18 / 10 | unchanged, still pass after the refactor |
| DB-side latency | ~0.2-0.3 ms per call (tiny data, local) | NOT real end-to-end latency |

## Still NOT verified (needs the real project / network)
Real Supabase SQL Editor run, PostgREST + HTTPS, `sb_secret_` key header behaviour, Render <-> Supabase latency/region, health endpoint on Render,
data migration from Sheets (no tool; none done), frontend typecheck/build (npm/pip blocked by org network policy 403), Netlify deploy/refresh test.

## Known limits / notes
- Dashboard aggregations still run via the Mongo-compat facade (rows fetched then grouped in Python, cap 50k). Fine for small data; move heavy ones to SQL RPCs before scale.
- `is_sheets()` name is historical: true for both adapter backends.
- Typecheck attempt with stubbed React types gave only stub-induced errors (not evidence of real errors or of success).

## Next
1. User runs the SQL in Supabase; sets Render env (secret key only in Render); redeploy.
2. Run first-admin CLI with approval; verify login `Server-Timing`.
3. Netlify: set `VITE_API_BASE_URL`, deploy, test direct routes/refresh.
4. Remaining audit: page-by-page role audit, tracking/postback end-to-end with real callback, full security review.

---
# UPDATE 2026-10-12 (2) — Supabase is now the production database
User confirmed: the SQL was run in the real Supabase SQL Editor (27 tables present). Google Sheets = legacy fallback only.

## Done this round
- Full audit written: `docs/AUDIT_REPORT.md` (route auth matrix of 145 routes, public-route review, object-level scope review, tracking/postback audit, security findings S1-S8, latency/architecture comparison, exact read-only access needed).
- Fixes: SSRF guard `app/core/net_safety.py` (postback + webhook), click IP no longer client-spoofable, `/health/ready` now returns `storage_backend`, Netlify build guard `frontend/scripts/check-env.mjs` (VITE_API_BASE_URL), Sheets docs marked LEGACY.
- Tests executed: part18 87/87, 19 32/32, 20 18/18, 21 10/10, 22 77/77 (real PG16), 23 22/22, 24 10/10, 25 16/16.

## Unresolved / needs real environment
1. Render env must be: STORAGE_BACKEND=supabase_rest, SUPABASE_URL, SUPABASE_SERVICE_KEY (secret key), ALLOWED_ORIGINS (Netlify origin), JWT_SECRET_KEY, ENVIRONMENT=production, **FORWARDED_ALLOW_IPS=\*** (else rate limits may be global). Remove GOOGLE_SHEETS_* . Verify with `GET /api/v1/health/ready` -> `"storage_backend":"supabase_rest"`.
2. Netlify: `VITE_API_BASE_URL` set; real base/publish dir confirmed; `npm run build` passes (BLOCKED here); deploy + direct-route/refresh/login/logout test.
3. Provision first Super Admin (CLI, needs the user's approval + email). Legacy Sheets rows are NOT in Supabase; recreate test data as needed.
4. Real external callbacks (advertiser -> inbound, Quantix -> publisher URL) untested.
5. Runtime role-by-role API test (needs FastAPI installed) — hand to Emergent.
6. Later: SQL RPCs for heavy dashboard aggregations / N+1 lists, Redis rate limiter, httpOnly refresh cookie, CSP.
