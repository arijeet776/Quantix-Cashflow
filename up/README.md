# Quantix Cashflow

Affiliate/publisher network platform — Super Admin, Affiliate Manager, and
Publisher roles managing campaigns, tracking, conversions, postbacks, fraud
controls, reporting, financials/payments, integrations, and support.

## Architecture

- **Backend**: Python / FastAPI
- **Frontend**: React / TypeScript / Vite
- **MongoDB**: operational store (users, publishers, managers, campaigns,
  clicks, conversions, postbacks, tickets, audit logs, sessions, etc.)
- **PostgreSQL (Supabase)**: the *sole* financial system of record —
  `financial_ledger` and `withdrawals`. MongoDB is never used to store or
  derive an authoritative financial balance.

## Parts implemented

1. Foundation
2. Authentication & Onboarding
3. Super Admin
4. Affiliate Manager
5. Tracking Engine
6. Conversion / Postback / Fraud
7. Publisher
8. Reporting & Analytics
9. Financials & Payments
10. Integrations / API / Webhooks
11. Support & Security Operations
12. Production readiness (env examples, README)
13. Session/token revocation hardening, deployment files
14. End-to-end integration QA (tests written; runtime verification pending)
15. Production deployment & launch readiness (docs, config guards, readiness reporting)

## Running locally

### Backend

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env   # fill in MONGO_URI, POSTGRES_DSN, JWT_SECRET_KEY, etc.
# Postgres migrations in backend/migrations/ are applied automatically at
# startup (ordered, transactional, serialised by an advisory lock, recorded in
# schema_migrations). If Postgres is unreachable they are retried on next start.
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

`/health/live` is process liveness only. `/health/ready` checks both Mongo
and Postgres and returns 503 if either is unreachable — use that for
orchestrator readiness probes, not `/health/live`.

### Frontend

```bash
cd frontend
npm install
cp .env.example .env   # set VITE_API_BASE_URL if the API isn't same-origin
npm run dev             # or: npm run build && npm run preview
```

## Tests

```bash
cd backend
pip install -r requirements.txt -r requirements-dev.txt
python -m pytest tests/          # or run individual partN_*.py files directly
```

```bash
cd frontend
npm run typecheck
npm run build
npm run lint
```

## Production deployment

Portable (no cloud-provider assumptions). MongoDB and PostgreSQL/Supabase are
external services configured only through environment variables.

```bash
cp backend/.env.example backend/.env     # fill in real values — never commit it
docker compose up --build -d             # frontend on :8080, backend internal
```

- `backend/Dockerfile` — python:3.12-slim, non-root user, `uvicorn --proxy-headers`.
- `frontend/Dockerfile` + `frontend/nginx.conf` — static build served by nginx,
  `/api/` proxied to the backend (same-origin, so no CORS needed). For a split
  deployment set `VITE_API_BASE_URL` at build time.
- Point the **tracking domain** directly at the backend (short links are served
  at the domain root); put TLS termination (load balancer / reverse proxy) in front.
- Set `FORWARDED_ALLOW_IPS` to your proxy address(es) so client IPs used by
  fraud/click logic are trustworthy.

### Required environment (see `backend/.env.example`)

`ENVIRONMENT=production`, `MONGO_URI`, `MONGO_DB_NAME`, `POSTGRES_DSN`,
`JWT_SECRET_KEY`, `ALLOWED_ORIGINS`. In production the app **refuses to start**
if `JWT_SECRET_KEY` is shorter than 32 characters, `ALLOWED_ORIGINS` contains
`*`, or `POSTGRES_DSN` is the development placeholder. Store secrets in your
platform's secret manager, never in the repo or image.

### Health

- `GET /api/v1/health/live` — process liveness only.
- `GET /api/v1/health/ready` — checks MongoDB **and** PostgreSQL; 503 if either is down. Use for readiness probes.

### Database

- MongoDB: collections/indexes are created idempotently at startup (`ensure_indexes`).
- PostgreSQL: `backend/migrations/*.sql` applied automatically in order, each in a
  transaction, recorded in `schema_migrations`; concurrent starters are serialised.
  Migrations only create objects (`IF NOT EXISTS`); nothing is dropped or rewritten.
- Money lives only in PostgreSQL (`NUMERIC(18,2)`, append-only ledger).

### Sessions and revocation

Every access token is bound to its refresh session (`sid`). `get_current_user`
requires that session to be live and owned by the token's user, then re-reads the
user's role/status from the database. Therefore logout, admin revoke, revoke-all,
self `POST /auth/logout-all`, refresh rotation, session expiry and password reset
take effect on the **next request** — not at access-token expiry. Tokens without a
`sid` are rejected. Cost: one indexed session lookup per authenticated request.

## Known limitations

- **Custom postback adapter is not implemented**: the specification does not define
  the Custom platform's contract. Inbound `custom` postbacks fail closed. See
  `docs/CUSTOM_POSTBACK_SPEC_GAP.md` for exactly what is needed.
- No `package-lock.json` is committed; commit one and use `npm ci` for reproducible
  frontend builds.
- Country/city on clicks require a geo-IP source (not part of the current build).
- Row-level security on the Supabase tables has no policies (the backend connects
  with a direct role); review before exposing the Supabase API publicly.

## Deployment & launch docs (Part 15)

- [`docs/DEPLOYMENT_RUNBOOK.md`](docs/DEPLOYMENT_RUNBOOK.md) — env vars, secrets, Atlas/Supabase requirements, migrations, startup, nginx, health checks, smoke test, rollback.
- [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md) — every item is marked PENDING until verified in a real runtime.
- [`docs/BACKUP_RECOVERY.md`](docs/BACKUP_RECOVERY.md) — backup/recovery responsibilities (none verified).
- [`docs/PART15_AUDIT.md`](docs/PART15_AUDIT.md) — what the Part 15 audit found and changed.

**Verification status:** Parts 1–14 are statically verified; the test suites, frontend build
and live database connections have not been executed in the authoring environment.

## UI redesign (Part 16)
See `docs/PART16_UI_REDESIGN.md` for the global design system, accessibility and verification status.

- **Part 16.2.1** — Final Login/Register UI, dual invite flows (Manager / Super Admin), Approve & Assign Manager, profile data continuity: see `docs/PART16_UI_REDESIGN.md`.
- **Part 17** — Open publisher registration, optional-manager approval, Export Center, Global Postback, WhatsApp/manager support contact: see the Part 17 section of `docs/PART16_UI_REDESIGN.md`.

## Global accent theme (Part 16.2)
Super Admin → System Settings → Appearance. Default Deep Yellow. See `docs/PART16_UI_REDESIGN.md`.

## Temporary Google Sheets backend
See [docs/GOOGLE_SHEETS_BACKEND.md](docs/GOOGLE_SHEETS_BACKEND.md) (`STORAGE_BACKEND=google_sheets`).
