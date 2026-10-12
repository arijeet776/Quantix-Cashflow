# Quantix Cashflow — Engineering audit (2026-10-12)

Database of record: **Supabase** (`STORAGE_BACKEND=supabase_rest`). Google Sheets is legacy/fallback only.
Evidence labels: **[RUN]** executed here · **[READ]** code read, not executed · **[BLOCKED]** needs network/accounts.

## 1. Netlify / frontend
| Item | Result |
|---|---|
| Repo layout [READ] | `up/frontend` (Vite), `up/backend` (FastAPI), `up/gas` (legacy), `up/docs`. Netlify config now at `frontend/netlify.toml` (no `base`) + `frontend/public/_redirects`. The real base/publish dir configured in Netlify is **unknown [BLOCKED]**: base must be the folder that holds `package.json`; publish = `dist`. |
| `VITE_API_BASE_URL` required [RUN] | `frontend/scripts/check-env.mjs` runs first in the Netlify build command; fails the build when unset / not https / localhost / any `VITE_*SECRET*`. Tested 5 cases locally. Does not print the value. Backend `ALLOWED_ORIGINS` must contain the exact Netlify origin. |
| Typecheck / build / tests [BLOCKED] | npm registry and PyPI return HTTP 403 (org network policy) and the npm cache is empty. Only a parse-level syntax check passed (66 files). `npm run build` runs `tsc --noEmit`, so ONE type error fails the Netlify deploy (publishing nothing -> "Page not found"). **Run `npm install && npm run build` on any normal machine first.** |
| Side-effect review of new code [READ] | ErrorBoundary: wraps the router, uses existing CSS classes, reload/login links are full page loads — no side effects found. `_redirects`: `/assets/*` 404s when missing, other existing files are served as-is, everything else -> index.html (200). The same rules also live in netlify.toml (harmless duplicate). API non-JSON guard: runs only after the `!res.ok` branch and only in `apiRequest`; CSV/JSON downloads use separate `fetch` (`api/download.ts`, `ReportsView`) so they are unaffected. Refresh now also rejects a 200 reply without `access_token`. |
| Routing fix verified? | **NO.** Needs a real Netlify deploy + direct-open/refresh/login/logout test **[BLOCKED]**. |

## 2. Authorization (145 routes) — full matrix at the end
Route-level guards [RUN via AST scan]: SUPER_ADMIN 63 · PUBLISHER 30 · MANAGER+SUPER_ADMIN 20 · all roles 9 · MANAGER 6 · public 17.
Public routes reviewed [READ]: `/auth/login|refresh|logout|forgot-password|reset-password` (rate-limited), `/auth/_dev/*` (hard 403 outside development, hidden from schema), `/t/{campaign}/{link}` click (rate-limited by design), `/health/*`, `/api/reports/summary` (API-key checked inside, scope `reports:read`), `/invites/{token}`, `/onboarding/*` (invite-token, rate-limited), `/otp/*` (rate-limited), `/appearance` (read-only theme), inbound postback `/postback/inbound/{platform}/{token}` (token = secret, 404 when unknown/disabled, rate-limited).
Object-level scope [READ, sampled, NOT runtime-tested]: publishers list/detail (manager pinned to own `manager_id`), support tickets (`_can_view`), financial scope check (`financial_service` ~L48-62, 218-268), export download (owner-scoped, id regex), manager/publisher reports (`manager_id`/`publisher_id` pinned server-side), publisher responses drop revenue/margin. No bypass found in what was read. A full per-endpoint runtime test needs FastAPI (not installable here) — recommended next step for Emergent.

## 3. Tracking / postback [READ + existing tests]
* Click id match: the click must exist AND belong to the endpoint's campaign, else `unresolved` (no conversion).
* Duplicate protection: `idempotency_key = platform|external_conversion_id|event|click_id`, unique in DB (Supabase unique index). Race-safe: the insert returns `created=False` on conflict. Design note: two *different* real events with an empty `external_conversion_id`, same event name, same click collapse into one.
* Payout/campaign/publisher/manager come from stored records, never from callback params. Status changes on a duplicate update the SAME conversion and are audited.
* Publisher postback delivery: one delivery per conversion, 4 attempts with backoff, no redirects, logged.
* **Still needs a real external callback [BLOCKED]:** advertiser -> Quantix inbound URL, and Quantix -> publisher URL over the internet; no external network is reachable from here and no production URL was invented.

## 4. Security findings
| # | Finding | Severity | Status |
|---|---|---|---|
| S1 | **SSRF**: publisher postback/webhook URLs were only checked as text; a hostname resolving to a private/metadata IP, or `2130706433`/`0x7f.1`, passed, and 200 chars of the response were shown to the publisher | High | **FIXED** `core/net_safety.py` (resolve + require public IPs at save and at every send; no redirects). part25 16/16 [RUN]. Residual: DNS rebinding in the milliseconds between check and connect. |
| S2 | Click IP: left-most `X-Forwarded-For` (client-controlled) was stored and used for velocity | Medium | **FIXED** (`request.client.host` first). |
| S3 | **Rate limiter keyed by `request.client.host`**: behind Render's proxy this is the proxy IP unless uvicorn trusts it, so ALL users share one bucket (login 10/min, clicks 60/min, inbound postbacks 120/min total) | High if confirmed | **CONFIG ACTION [BLOCKED to verify]:** set env `FORWARDED_ALLOW_IPS=*` on Render (only Render's proxy can reach the container) and confirm via a test from two networks. The limiter is also in-memory per worker (2 workers = double limits) — acceptable now, move to Redis later. |
| S4 | Refresh token in `localStorage` (readable by any XSS). No `dangerouslySetInnerHTML` found. | Low-Med | Accepted/documented; httpOnly cookie is the later upgrade. |
| S5 | No CSP header | Low | Open (add on Netlify `_headers` after the build is verified). |
| S6 | Passwords bcrypt; JWT HS256 with >=32-char secret enforced in production; access tokens bound to server sessions; role/status re-read from DB each request; `/docs` off in production; CORS explicit origins; secrets never in repr/logs [READ] | — | OK |
| S7 | Supabase: RLS on all 27 tables, anon/authenticated revoked, only the secret key can call `qx_exec` [RUN on local PG16; you also ran the SQL on the real project]. Publishable key is refused by the app. | — | OK |
| S8 | First Super Admin CLI [RUN]: part22 Z1-Z7 on real PG with the real adapter: one row, real enums, legacy row byte-identical, no plaintext password anywhere, refuses duplicate email and a 2nd active admin. Unit part21 10/10. Against the Google Sheets adapter: not needed any more (Sheets is no longer the DB). | — | OK |

## 5. Latency and architecture
* Original cause of 8-10 s [READ+SIMULATED]: every storage call was an Apps Script round trip (hundreds of ms to seconds each) and a login chain needs several sequential calls. Parallelising (done earlier) cut the critical path but cannot beat the per-call cost.
* Measured [RUN]: in-database time per call on PostgreSQL 16 = 0.2-0.3 ms (tiny data). **Real login/dashboard time = network RTT(Render<->Supabase) x number of sequential calls + app time. Not measured [BLOCKED]** — read the `Server-Timing: storage;dur=..;desc="N calls"` header on `/auth/login` and `/admin/dashboard`.
* Known remaining app-side costs: lists with N+1 reads (publishers list does one `users` lookup per publisher); dashboard aggregations fetch rows then group in Python (cap 50k). Fine for small data; convert to SQL RPCs before scale.
| Option | Latency | Money integrity | Verdict |
|---|---|---|---|
| Optimised Sheets (batching, caching) | 0.3-2 s per call floor | no real transactions/locks beyond one script lock | Not suitable for finance at scale |
| Caching on top of Sheets | hides reads, not writes | stale balances risk | no |
| **Supabase (chosen, done)** | ms per call, same-region | transactions, unique constraints, append-only ledger trigger, per-publisher advisory lock | **Recommended** |
| Hybrid (Sheets for reports/export only) | — | — | optional later |

## 6. Access needed (read-only, smallest)
* Netlify: Site configuration view — build settings (base/publish/command), env-var NAMES, latest deploy log, published redirects. Confirms routing root cause + `VITE_API_BASE_URL`. No deploy rights.
* Render: Environment variable NAMES (not values), service settings (Root Directory, Dockerfile path), logs, `Server-Timing` of live requests. Confirms Supabase mode, `FORWARDED_ALLOW_IPS`, latency. No deploy rights.
* Supabase: nothing more needed; never share the secret key in chat.

## 7. Route authorization matrix (generated)
| Route | Method | Roles allowed (route guard) | Module |
|---|---|---|---|
| /api/v1/admin/audit-logs | GET | SUPER_ADMIN | audit_logs |
| /api/v1/admin/campaigns/{campaign_id}/activate | POST | SUPER_ADMIN | campaigns |
| /api/v1/admin/campaigns/{campaign_id}/end | POST | SUPER_ADMIN | campaigns |
| /api/v1/admin/campaigns/{campaign_id}/history | GET | SUPER_ADMIN | campaigns |
| /api/v1/admin/campaigns/{campaign_id}/pause | POST | SUPER_ADMIN | campaigns |
| /api/v1/admin/campaigns/{campaign_id}/purge-preview | GET | SUPER_ADMIN | purge |
| /api/v1/admin/campaigns/{campaign_id}/purge-status | GET | SUPER_ADMIN | purge |
| /api/v1/admin/campaigns/{campaign_id}/purge | POST | SUPER_ADMIN | purge |
| /api/v1/admin/campaigns/{campaign_id}/resume | POST | SUPER_ADMIN | campaigns |
| /api/v1/admin/campaigns/{campaign_id} | GET | SUPER_ADMIN | campaigns |
| /api/v1/admin/campaigns/{campaign_id} | PATCH | SUPER_ADMIN | campaigns |
| /api/v1/admin/campaigns | GET | SUPER_ADMIN | campaigns |
| /api/v1/admin/campaigns | POST | SUPER_ADMIN | campaigns |
| /api/v1/admin/conversion-review/{conversion_id}/confirm | POST | MANAGER,SUPER_ADMIN | conversion_review |
| /api/v1/admin/conversion-review/{conversion_id}/reject | POST | MANAGER,SUPER_ADMIN | conversion_review |
| /api/v1/admin/conversion-review | GET | MANAGER,SUPER_ADMIN | conversion_review |
| /api/v1/admin/dashboard | GET | SUPER_ADMIN | admin_dashboard |
| /api/v1/admin/financials/adjustments | POST | SUPER_ADMIN | admin_financials |
| /api/v1/admin/financials/ledger/{conversion_id}/reverse | POST | SUPER_ADMIN | admin_financials |
| /api/v1/admin/financials/ledger | GET | MANAGER,SUPER_ADMIN | admin_financials |
| /api/v1/admin/financials/overview | GET | MANAGER,SUPER_ADMIN | admin_financials |
| /api/v1/admin/financials/wallets/{publisher_id} | GET | MANAGER,SUPER_ADMIN | admin_financials |
| /api/v1/admin/financials/withdrawals/{withdrawal_id}/approve | POST | MANAGER,SUPER_ADMIN | admin_financials |
| /api/v1/admin/financials/withdrawals/{withdrawal_id}/mark-paid | POST | SUPER_ADMIN | admin_financials |
| /api/v1/admin/financials/withdrawals/{withdrawal_id}/reject | POST | MANAGER,SUPER_ADMIN | admin_financials |
| /api/v1/admin/financials/withdrawals/{withdrawal_id} | GET | MANAGER,SUPER_ADMIN | admin_financials |
| /api/v1/admin/financials/withdrawals | GET | MANAGER,SUPER_ADMIN | admin_financials |
| /api/v1/admin/fraud/blocked-ips/{record_id}/close-investigation | POST | SUPER_ADMIN | fraud |
| /api/v1/admin/fraud/blocked-ips/{record_id}/investigate | POST | SUPER_ADMIN | fraud |
| /api/v1/admin/fraud/blocked-ips/{record_id}/keep-blocked | POST | SUPER_ADMIN | fraud |
| /api/v1/admin/fraud/blocked-ips/{record_id}/mark-safe | POST | SUPER_ADMIN | fraud |
| /api/v1/admin/fraud/blocked-ips/{record_id}/permanent-block | POST | SUPER_ADMIN | fraud |
| /api/v1/admin/fraud/blocked-ips/{record_id} | GET | SUPER_ADMIN | fraud |
| /api/v1/admin/fraud/blocked-ips | GET | SUPER_ADMIN | fraud |
| /api/v1/admin/fraud/blocked-ips | POST | SUPER_ADMIN | fraud |
| /api/v1/admin/fraud/overview | GET | SUPER_ADMIN | fraud |
| /api/v1/admin/integrations/api-keys/{key_id}/revoke | POST | SUPER_ADMIN | integrations |
| /api/v1/admin/integrations/api-keys | GET | SUPER_ADMIN | integrations |
| /api/v1/admin/integrations/api-keys | POST | SUPER_ADMIN | integrations |
| /api/v1/admin/integrations/webhook-deliveries/{delivery_id}/replay | POST | SUPER_ADMIN | integrations |
| /api/v1/admin/integrations/webhook-deliveries | GET | SUPER_ADMIN | integrations |
| /api/v1/admin/integrations/webhooks/{webhook_id}/disable | POST | SUPER_ADMIN | integrations |
| /api/v1/admin/integrations/webhooks/{webhook_id}/enable | POST | SUPER_ADMIN | integrations |
| /api/v1/admin/integrations/webhooks/{webhook_id}/toggle | POST | SUPER_ADMIN | integrations |
| /api/v1/admin/integrations/webhooks | GET | SUPER_ADMIN | integrations |
| /api/v1/admin/integrations/webhooks | POST | SUPER_ADMIN | integrations |
| /api/v1/admin/managers/assignable | GET | SUPER_ADMIN | admin_managers |
| /api/v1/admin/managers/{user_id}/approve | POST | SUPER_ADMIN | admin_managers |
| /api/v1/admin/managers/{user_id}/publishers | GET | SUPER_ADMIN | admin_managers |
| /api/v1/admin/managers/{user_id}/reject | POST | SUPER_ADMIN | admin_managers |
| /api/v1/admin/managers/{user_id} | GET | SUPER_ADMIN | admin_managers |
| /api/v1/admin/managers | GET | SUPER_ADMIN | admin_managers |
| /api/v1/admin/postback/endpoints/{endpoint_id}/disable | POST | SUPER_ADMIN | postbacks |
| /api/v1/admin/postback/endpoints/{endpoint_id}/enable | POST | SUPER_ADMIN | postbacks |
| /api/v1/admin/postback/endpoints | GET | SUPER_ADMIN | postbacks |
| /api/v1/admin/postback/endpoints | POST | SUPER_ADMIN | postbacks |
| /api/v1/admin/postback/global-config | DELETE | PUBLISHER | postbacks |
| /api/v1/admin/postback/global-config | GET | PUBLISHER | postbacks |
| /api/v1/admin/postback/global-config | PUT | PUBLISHER | postbacks |
| /api/v1/admin/postback/logs | GET | SUPER_ADMIN | postbacks |
| /api/v1/admin/postback/macros | GET | PUBLISHER | postbacks |
| /api/v1/admin/postback/outbound/{outbound_id}/refire | POST | SUPER_ADMIN | postbacks |
| /api/v1/admin/postback/outbound | GET | SUPER_ADMIN | postbacks |
| /api/v1/admin/postback/platforms | GET | SUPER_ADMIN | postbacks |
| /api/v1/admin/postback/publisher-config/test | POST | PUBLISHER | postbacks |
| /api/v1/admin/postback/publisher-config | GET | PUBLISHER | postbacks |
| /api/v1/admin/postback/publisher-config | PUT | PUBLISHER | postbacks |
| /api/v1/admin/reports/export.csv | GET | SUPER_ADMIN | reports |
| /api/v1/admin/reports/manager/summary | GET | MANAGER | reports |
| /api/v1/admin/reports/publisher/export.csv | GET | PUBLISHER | reports |
| /api/v1/admin/reports/publisher/summary | GET | PUBLISHER | reports |
| /api/v1/admin/reports/summary | GET | SUPER_ADMIN | reports |
| /api/v1/admin/security/overview | GET | SUPER_ADMIN | admin_security |
| /api/v1/admin/security/sessions/{jti}/revoke | POST | SUPER_ADMIN | admin_security |
| /api/v1/admin/security/users/{user_id}/sessions/revoke-all | POST | SUPER_ADMIN | admin_security |
| /api/v1/admin/security/users/{user_id}/sessions | GET | SUPER_ADMIN | admin_security |
| /api/v1/admin/settings/appearance | PUT | SUPER_ADMIN | settings |
| /api/v1/admin/settings/support | GET | SUPER_ADMIN | settings |
| /api/v1/admin/settings/support | PUT | SUPER_ADMIN | settings |
| /api/v1/admin/settings/tracking-domain | GET | SUPER_ADMIN | settings |
| /api/v1/admin/settings/tracking-domain | PUT | SUPER_ADMIN | settings |
| /api/v1/api/reports/summary | GET | PUBLIC | integrations |
| /api/v1/appearance | GET | PUBLIC | settings |
| /api/v1/auth/_dev/deactivate | POST | PUBLIC | auth |
| /api/v1/auth/_dev/issue-token | POST | PUBLIC | auth |
| /api/v1/auth/forgot-password | POST | PUBLIC | auth |
| /api/v1/auth/login | POST | PUBLIC | auth |
| /api/v1/auth/logout-all | POST | MANAGER,PUBLISHER,SUPER_ADMIN | auth |
| /api/v1/auth/logout | POST | PUBLIC | auth |
| /api/v1/auth/me | GET | MANAGER,PUBLISHER,SUPER_ADMIN | auth |
| /api/v1/auth/refresh | POST | PUBLIC | auth |
| /api/v1/auth/reset-password | POST | PUBLIC | auth |
| /api/v1/campaign-access/applications/{access_id}/approve | POST | MANAGER,SUPER_ADMIN | campaign_access |
| /api/v1/campaign-access/applications/{access_id}/reject | POST | MANAGER,SUPER_ADMIN | campaign_access |
| /api/v1/campaign-access/applications | GET | MANAGER,SUPER_ADMIN | campaign_access |
| /api/v1/campaign-access/available | GET | PUBLISHER | campaign_access |
| /api/v1/campaign-access/{campaign_id}/access | POST | PUBLISHER | campaign_access |
| /api/v1/health/live | GET | PUBLIC | health |
| /api/v1/health/ready | GET | PUBLIC | health |
| /api/v1/invites/manager | POST | SUPER_ADMIN | invites |
| /api/v1/invites/publisher | POST | MANAGER,SUPER_ADMIN | invites |
| /api/v1/invites/{token}/revoke | POST | MANAGER,SUPER_ADMIN | invites |
| /api/v1/invites/{token} | GET | PUBLIC | invites |
| /api/v1/links | GET | MANAGER,PUBLISHER,SUPER_ADMIN | links |
| /api/v1/links | POST | MANAGER,SUPER_ADMIN | links |
| /api/v1/manager/campaigns/{campaign_id} | GET | MANAGER | manager |
| /api/v1/manager/campaigns | GET | MANAGER | manager |
| /api/v1/manager/dashboard | GET | MANAGER | manager |
| /api/v1/manager/me/mobile | PUT | MANAGER | manager |
| /api/v1/manager/me | GET | MANAGER | manager |
| /api/v1/onboarding/manager | POST | PUBLIC | onboarding |
| /api/v1/onboarding/publisher | POST | PUBLIC | onboarding |
| /api/v1/otp/send | POST | PUBLIC | otp |
| /api/v1/otp/verify | POST | PUBLIC | otp |
| /api/v1/publisher/account-manager | GET | PUBLISHER | publisher |
| /api/v1/publisher/campaigns/{campaign_id} | GET | PUBLISHER | publisher |
| /api/v1/publisher/campaigns | GET | PUBLISHER | publisher |
| /api/v1/publisher/clicks | GET | PUBLISHER | publisher |
| /api/v1/publisher/conversions/event-summary | GET | PUBLISHER | publisher |
| /api/v1/publisher/conversions | GET | PUBLISHER | publisher |
| /api/v1/publisher/dashboard | GET | PUBLISHER | publisher |
| /api/v1/publisher/exports/{job_id}/download | GET | PUBLISHER | publisher |
| /api/v1/publisher/exports | GET | PUBLISHER | publisher |
| /api/v1/publisher/exports | POST | PUBLISHER | publisher |
| /api/v1/publisher/postback-logs | GET | PUBLISHER | publisher |
| /api/v1/publisher/profile | GET | PUBLISHER | publisher |
| /api/v1/publishers/{user_id}/approve | POST | MANAGER,SUPER_ADMIN | publishers |
| /api/v1/publishers/{user_id}/manager | PUT | SUPER_ADMIN | publishers |
| /api/v1/publishers/{user_id}/reject | POST | MANAGER,SUPER_ADMIN | publishers |
| /api/v1/publishers/{user_id} | GET | MANAGER,SUPER_ADMIN | publishers |
| /api/v1/publishers | GET | MANAGER,SUPER_ADMIN | publishers |
| /api/v1/support/contact | GET | MANAGER,PUBLISHER,SUPER_ADMIN | support |
| /api/v1/support/tickets/{ticket_id}/reply | POST | MANAGER,PUBLISHER,SUPER_ADMIN | support |
| /api/v1/support/tickets/{ticket_id}/status | POST | MANAGER,PUBLISHER,SUPER_ADMIN | support |
| /api/v1/support/tickets/{ticket_id} | GET | MANAGER,PUBLISHER,SUPER_ADMIN | support |
| /api/v1/support/tickets | GET | MANAGER,PUBLISHER,SUPER_ADMIN | support |
| /api/v1/support/tickets | POST | MANAGER,PUBLISHER,SUPER_ADMIN | support |
| /api/v1/wallet/earnings | GET | PUBLISHER | wallet |
| /api/v1/wallet/ledger | GET | PUBLISHER | wallet |
| /api/v1/wallet/summary | GET | PUBLISHER | wallet |
| /api/v1/wallet/withdrawals/{withdrawal_id}/cancel | POST | PUBLISHER | wallet |
| /api/v1/wallet/withdrawals/{withdrawal_id} | GET | PUBLISHER | wallet |
| /api/v1/wallet/withdrawals | GET | PUBLISHER | wallet |
| /api/v1/wallet/withdrawals | POST | PUBLISHER | wallet |
| /api/v1?/{campaign_code}/{link_code} | GET | PUBLIC | click |
