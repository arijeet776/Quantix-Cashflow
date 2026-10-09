# QUANTIX CASHFLOW — Project PRD / Continuity Memory

## Original Problem Statement
Multi-part production build of "Quantix Cashflow", an affiliate/performance-marketing network
(SUPER_ADMIN_OWNER > SUPER_ADMIN > MANAGER > PUBLISHER). Parts 1–3 are LOCKED and verified.
Agent must audit the supplied Part 3 ZIP before coding anything. User will supply a reference
video (primary visual direction: black/dark UI, orange accent in video → replace with Quantix
brand accent) and the official Quantix Q logo in a follow-up message. Part 4 (Manager Panel)
starts only after audit approval.

## Supplied Artifacts
- Part 3 ZIP (SHA-256 verified: cc1059de87fa75fa7b99d9bd4cadec21f43c209cda5ba2ec82a5885e03bac997)
  extracted at /app/quantix/quantix-cashflow (persistent; original ZIP at /app/quantix/part3.zip)
- Reference video: RECEIVED — /app/quantix/reference-video.mp4 (5:07, 864x1920 mobile portrait),
  frames extracted to /app/quantix/video-frames/. Publisher panel of "Hiqmobi" (promoter.hiq.mobi).
- Official Quantix logo: STILL PENDING. ZIP contains blue/teal Q logo assets
  (frontend/public/quantix-logo-*.png) — user must confirm if those are the official final versions.

## Reference Video Visual Analysis (locked design language)
- Base: near-black everywhere — page #0f0704 (warm-tinted black), card #030615, drawer #040814,
  inputs #0a0e19 (dark navy). No light gradients, no glass.
- Accent: vivid orange (#e67d4d family, gradient buttons brighter core ~#ff8a4c). USED FOR:
  primary buttons (full-width gradient), active nav pill (full-width rounded, white dot right edge),
  active date-preset pills, icon tiles (orange-tinted rounded square, top-left of cards),
  section micro-labels (uppercase, letter-spaced), table header text, checkbox checks, toggle-on,
  avatar. → Per spec §45: REPLACE this orange with official Quantix logo accent; keep everything else.
- Success green #16b282 (sub-metrics with ↗ arrow: CR %, EPC; Active pills; event value pills).
- KPI cards: muted small label, huge bold white number, green sub-metric, faint giant watermark
  icon bleeding off right edge.
- Sidebar: drawer style; logo top-left; "MAIN MENU" micro-label; expandable submenus with chevrons;
  bottom "SUPPORT & HELP" box; user card (avatar + green online dot + name + chevron).
- Reports: column-visibility orange checkboxes, date presets (Today/7d/30d/90d), date inputs,
  filter dropdowns, outline Export button.
- Postback settings: macro-token chip grid ({click_id},{payout},{p1}..{p10} etc.) with muted
  descriptions, orange toggle, red destructive button, grey Save, blue-tinted info callouts.
- Campaign detail: white logo tile, tiny orange "ELITE CAMPAIGN" label + REF#id, big name,
  green Active pill + outlined STANDARD pill, orange CTA, metadata rows with right-aligned orange
  icon tiles, tag pills, country pill with flag.
- Mobile-first (hamburger + drawer), topbar = page title + theme toggle + user icon.
- Typography: bold sans, oversized numerals, uppercase micro-labels with wide letter-spacing.

## Architecture (audited, verified)
- Backend: FastAPI (app factory, /api/v1 prefix), strict layering endpoint → service → repository.
- MongoDB (Motor) = operational store: users, managers, publishers, invites, otps,
  refresh_sessions, audit_logs, campaigns, campaign_config_versions, blocked_ips.
  Indexes centralized in app/db/mongodb.py::ensure_indexes().
- Postgres/Supabase (asyncpg) = reserved financial ledger (Part 9). Nothing writes to it yet.
- Frontend: React 18 + TypeScript + Vite, hand-rolled CSS with semantic tokens (styles.css),
  dark/light theme persisted (no-flash inline script in index.html), accent = deep sky blue
  (#0ea5e9) matching the blue/teal Q logo in the repo.
- Auth: JWT identity-only; role/status re-read from DB per request (core/rbac.py).
  Rotating jti-tracked refresh sessions; invite tokens sha256-hashed, atomic claim;
  OTP bcrypt-hashed with lockout/cooldown; email normalization; in-memory IP rate limiting.

## Verified Test Baseline (reproduced by this agent, not assumed)
- tests/smoke_test.py: 22/22 PASS
- tests/part2_test.py: 63/63 PASS
- tests/part3_test.py: 88/88 PASS
- Total: 173/173 PASS (matches locked claims)

## Key Audit Findings
1. No production domain hard-coded in business logic. Only references: QUANTIX_HANDOFF.md §15
   and frontend TrackingLinksPage.tsx note — BOTH still describe the OLD verbose URL format
   (track.quantixcashflow.com/click?campaign_id=...&pub_id=...) which the new master spec §20
   REPLACES with short URLs {domain}/{campaign-code}/{link-code}. Must be corrected in Part 5.
2. No tracking-domain configuration exists anywhere (no tracking_base_url, no settings
   collection, no System Settings → Domain & Tracking UI). New scope required (spec §16-19).
3. SUPER_ADMIN_OWNER tier not implemented (documented deferral, ARCHITECTURE §30). Additive
   Role enum value planned.
4. CampaignEvent schema has name/payout/completion_source but NO `mode` field (master spec §12
   requires mode). Gap for Part 5/6.
5. Campaign caps exist as fields; no enforcement/auto-pause yet (needs click data, Part 5).
6. Email = ConsoleEmailBackend only (no real provider). Rate limiter = in-memory single-process.
   Refresh token in localStorage (documented tradeoff). No MFA.
7. Apply Scope: config-versioning complete; retroactive application waits for lead records.

## Roadmap
Parts 1-3 LOCKED. Next: audit report → user sends video+logo → UI design direction →
Part 4 Manager Panel (backend scoped endpoints reusing _require_manager_scope + role-aware
frontend shell) → Part 5 Tracking Engine (incl. configurable tracking domain + short URLs) →
Parts 6-14 per master spec.

## Next Actions
- SHIPPED (this iteration): full runtime integration (Quantix codebase now runs the pod:
  /app/backend = FastAPI app package + server.py shim, /app/frontend = Vite+React TS on :3000),
  campaign data purge (backend+UI, 26/26 mandatory tests), tracking-domain config
  (System Settings → Domain & Tracking, DB-authoritative, audited), video-language UI restyle
  (near-black + Quantix blue #0ea5e9 gradient, Archivo font, dark default, KPI icon tiles +
  watermarks, sidebar user card), video-style Login + Register pages (invite-based 4-step flow:
  invite token → details → OTP → pending; deep links ?invite=/?token=/legacy ?page=...&invite=).
- Regression: 236/236 in-pod (22+63+88+63) + testing agent 21/21 live E2E. Report:
  /app/test_reports/iteration_1.json (no bugs; theme-default flag was a false positive —
  tester looked for a `dark` class, Quantix uses data-theme attr; dark default confirmed live).
- PART 4 MANAGER PANEL SHIPPED: backend /api/v1/manager/* (me, dashboard, campaigns list+detail;
  manager-role-only, scope from DB, active-campaigns-only projection, no advertiser tracking URL),
  reusing locked /publishers + /invites/publisher scope enforcement. Frontend: role-aware routing
  (ProtectedRoute roles prop, roleHome redirect), role-based sidebar, manager pages (dashboard,
  publishers+invite modal, campaigns, campaign detail, reports placeholder), publisher home
  placeholder. tests/part4_manager_test.py: 18/18. Full regression: 254/254 (22+63+88+63+18).
- Copy sweep done per user directive: all user-facing "Part X"/"fabricated"/placeholder jargon
  removed from every page; copy now reads as a genuine product.
- Live seeded demo data (pod Mongo): campaign CAMPV7LM (active, 2 events), manager AM97578
  (manager@quantixcashflow.in), publishers 5821 (active) + 7349 (pending).
- PART 5 TRACKING ENGINE SHIPPED: short public links {domain}/{campaign-code}/{link-code}
  (C+5 / 4-char unambiguous codes, lazy assign-once campaign public_code + publisher PUB code),
  POST/GET /api/v1/links (SA all / manager own-scope / publisher own; domain must be configured),
  public click pipeline GET /api/v1/t/{cc}/{lc} AND root /{cc}/{lc} (main.py) in mandated order
  (rate limit → blocked-IP (both XFF+client) → link resolve → lifecycle (purged/ended die) →
  publisher active → caps w/ auto-pause+audit → immutable QXCLK click w/ full P1-P10/UTM snapshot →
  302 advertiser redirect w/ whitelisted macro substitution; unknown macros untouched, values
  URL-encoded, params allowlisted/capped). macro_engine.py reusable by Part 6 outbound postbacks.
  TrackingLinksPage now real (list + generate modal + copy). tests/part5_tracking_test.py 38/38.
  Full regression: 292/292 (22+63+88+63+18+38). Live-verified on preview (link CKMEKX/EBEC,
  publisher PUBF6PHR, click counted, 302 to advertiser).
- Copy sweep done per user directive: all user-facing "Part X"/"fabricated"/placeholder jargon
  removed from every page; copy now reads as a genuine product.
- Live seeded demo data (pod Mongo): campaign CAMPV7LM (active, 2 events), manager AM97578
  (manager@quantixcashflow.in), publishers 5821 (active) + 7349 (pending).
- PART 6 SHIPPED: conversion engine + postback adapters (Offer18/Trackier per spec fields; Trackix
  transport-only until official docs), canonical InboundPostback, secure tokened inbound endpoints
  (/api/v1/postback/inbound/{platform}/{token}), idempotency (unique key platform|txn|event|click),
  status updates to existing conversions, unresolved→exception log (never guess), publisher outbound
  postbacks (versioned configs, whitelisted macro engine, click-parameter passthrough, SSRF guard,
  4-attempt retries, audited manual refire), inbound/outbound logs, Postback Setup UI on
  Integrations page. tests/part6_postback_test.py 36/36.
- PART 7 SHIPPED: publisher panel — /api/v1/publisher/{dashboard,campaigns,clicks,conversions}
  with publisher-safe projection (no advertiser revenue/margin ever), dashboard/campaigns/postback
  pages, publisher nav. tests/part7_publisher_test.py 11/11.
- PART 8 SHIPPED: reports_service (real aggregation from clicks+conversions, bounded scans),
  /admin/reports/summary + export.csv (SA), /admin/reports/manager/summary (server-pinned scope),
  /admin/reports/publisher/summary (revenue/margin stripped), shared ReportsView component,
  admin Reports page + manager Reports page live with filters/group-by/CSV. tests/part8 17/17.
- PART 9 (Financials) PARKED: requires Supabase Postgres — direct host DNS unresolvable from pod
  (project paused?) and pooler needs tenant-aware connection string. Will NOT fake the ledger in
  Mongo (spec: Postgres is the sole financial authority). Needs user action.
- PART 10 SHIPPED: API keys (QXK_ raw shown once, sha256-only storage, scopes, instant revocation),
  machine API GET /api/v1/api/reports/summary (X-API-Key), webhooks (CRUD, enable/disable,
  whsec_ signing secret shown once, HMAC X-Quantix-Signature, 4-attempt retry, delivery logs,
  audited manual replay), conversion.created fan-out wired into conversion engine.
  tests/part10_integrations_test.py 22/22.
- HARDENING: ENVIRONMENT=production in preview (API docs off, dev-token endpoint off, HTTPS-only
  tracking domain), security headers middleware (nosniff/DENY/no-referrer), generic page title.
- Full regression: 378/378 (22+63+88+63+18+38+36+11+17+22).
- NEXT: Part 9 when Supabase reachable → Part 11 Security/Ops/Support → Part 12 automation →
  Part 13 hardening → Part 14 launch QA. Super Admin UI for API keys/webhooks sections pending
  (backend complete + tested; admin manages via API until the UI panel is added).
- Test data note: testing agent left TEST_-prefixed campaigns (2 active, 1 draft) in the pod DB.

## Blockers / Needed From User (deployment dependencies, per directive §21)
1. MongoDB Atlas password for quantixcashflow_db_user (host quantix-cashflow.irs0xxv.mongodb.net)
   → set as MONGO_URI at deploy; dev runs on local MongoDB meanwhile.
2. Supabase Postgres password (db.ooiuywpwzmrseaknefby.supabase.co) → POSTGRES_DSN; /health/ready
   reports postgres:error until provided (by design, locked Part 1 behavior).
3. Email provider for real OTP/invite delivery (currently console-logged in dev; Emergent-managed
   Resend needs no user keys — just say the word and I wire it).
4. Trackix official postback documentation/account access — spec forbids inventing Trackix
   macros; Offer18 (aff_click_id/event_token/...) and Trackier (click_id/txn_id/goal_value/...)
   mappings are specified in the user's spec; Trackix must be verified before its adapter ships.
