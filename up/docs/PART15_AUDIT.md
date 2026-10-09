# Part 15 — Deployment audit: findings and changes

Scope: deployment/production-safety only. No business logic was changed.
Verification level: **static review** (files read, `py_compile`, AST checks). No suite was run.

## Defects found and fixed
| # | Finding | Fix |
|---|---|---|
| 1 | `httpx` is imported at runtime by postback and webhook delivery but was only in `requirements-dev.txt`; the production image would lack it, breaking all outbound postbacks/webhooks. | Added `httpx==0.28.1` to `backend/requirements.txt`. |
| 2 | Frontend used `VITE_API_BASE_URL ?? "/api/v1"`. The Dockerfile/compose/.env.example set it to an **empty string**, which `??` keeps, so API calls would go to `/auth/login` instead of `/api/v1/auth/login`. | Changed to `\|\|` in `api/client.ts`, `ReportsView.tsx`, `PublisherReportsPage.tsx`. |
| 3 | Production could start with the localhost defaults for `MONGO_URI`/`MONGO_DB_NAME`/`POSTGRES_DSN`, and with a copied placeholder JWT secret. | `Settings` now requires those three to be explicitly set in production and rejects placeholder-like JWT secrets. `CORS_ALLOWED_ORIGINS` accepted as an alias of `ALLOWED_ORIGINS`. |
| 4 | If MongoDB was down at startup, indexes (including unique `users.email`) were never created and nothing retried. | `ensure_indexes()` now reports success; `/health/ready` retries until done and reports `mongo_indexes`. |
| 5 | A failed or skipped Postgres migration was only a `WARNING`, and readiness could turn green without the schema. | Migration state is tracked; failure logs `ERROR`; `/health/ready` reports `migrations` and stays 503 until `ok` (retry cool-down 30 s). |
| 6 | Behind the bundled nginx, uvicorn did not trust the proxy (client IP = nginx for rate limiting/fraud) and nginx appended to a client-supplied `X-Forwarded-For` (spoofable). | nginx overwrites `X-Forwarded-For`; compose sets `FORWARDED_ALLOW_IPS` for the unpublished backend. |
| 7 | nginx had no asset cache policy. | Long cache for `/assets/`, `no-cache` for `index.html`, security headers preserved. |
| 8 | `frontend/src/pages/publisher/PublisherReportsPage.tsx` had a lost function header (`RowTable`) at line ~91 — a **syntax error that would fail `npm run build`**. It was present in the Part 13/14 zips. Found by parsing every frontend file with the TypeScript compiler. | Restored `function RowTable<T extends Record<string, any>>({` (no other change). All 57 frontend `.ts/.tsx` files now parse without syntax errors; full type-checking still needs `npm install`. |

## Reviewed, no change needed
- Migrations: idempotent (`IF NOT EXISTS`), per-file transaction, advisory lock, tracked; no `DROP`/`TRUNCATE`/`DELETE` in migrations or startup code; no seed/test data at startup.
- Dev-only `_dev/*` endpoints: 403 unless `ENVIRONMENT=development`. `/docs`, `/redoc` disabled in production.
- Unhandled exceptions return a generic body; details only in server logs.
- CORS: explicit origins from configuration; wildcard rejected in production.
- Health: `/live` has no dependencies; `/ready` exposes no hosts, DSNs or credentials.
- Logging: no log call includes tokens, passwords, API keys or DSNs (keyword scan of logger calls).
- Docker: non-root backend, production requirements only, no secret in image or compose file, `.env*` excluded by `.dockerignore`.

## Known limitations (documented, not changed)
- No `frontend/package-lock.json` (needs an environment with registry access); Dockerfile uses `npm install`.
- Rate limiter is in-process memory.
- Ledger append-only-ness is by application convention, not database constraint.
- Tracking domain must point at the backend, not the SPA nginx.
- Custom postback adapter remains fail-closed (spec insufficient).

## New test (not executed here)
`backend/tests/part15_test.py` — production config guards and readiness fields.
