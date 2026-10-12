# Part 16 — Global Quantix Cashflow UI/UX Redesign

Status: PARTIAL (static + headless-render verification only; no npm build/typecheck/lint/tests could run — registry blocked).

## Approach
One design system applied at the base layer (`frontend/src/styles.css` tokens + shared components), so Auth, Super Admin, Manager and Publisher pages inherit it without per-page logic edits. Dark is default (matches reference); light theme supported. Accent: deep-sky blue (`#0ea5e9`, gradient `#2cc8ee → #2b6fe3`).

## Design system
- Tokens: radius sm/md/lg/xl (12/16/22/26), `--control-h` 42px, semantic text colors `--text-success/danger/warning/info`, `--overlay`, `--shadow-pop`.
- Components: cards, KPI cards (icon tile + watermark, thousands grouping by default), gradient-header tables (gradient on `thead`), pill tabs, status badges (semantic), forms (`FormField`, required/error), banners, empty/error/loading states, modal + `ConfirmDialog`, pagination, breadcrumbs, tooltips, skeletons.
- New shared exports in `components/Common.tsx`: `Banner`, `PageHeader`, `LoadingState`, `ErrorState`, `ConfirmDialog`, `FormField`.

## Accessibility
Skip link + `<main id="main-content">`; modal `role=dialog`/`aria-modal`/Escape/focus restore; `aria-expanded`/`aria-current` in sidebar; Escape closes mobile drawer; labelled nav/pagination/topbar; `role=alert` on errors; reduced-motion and forced-colors rules.

## Responsive
Breakpoints 1100/880/640px: KPI/stat grids reflow, modals become bottom sheets, tables scroll within wrappers, login card shrinks. Headless Chromium checks (390px / 820px / 1366px, dark+light): no horizontal overflow, 0 console errors on login, admin dashboard/campaigns/managers, manager dashboard, publisher home.

## Copy cleanup
Removed build-phase wording ("Parts 5–7", "later parts", "fully functional") from Campaigns, Settings, Fraud, Campaign edit and Notifications notes; real information kept.

## Files changed
styles.css; components/{Common,AppShell,Sidebar,Topbar,ReportsView}.tsx; pages/{CampaignsPage,SettingsPage,FraudPage,CampaignEditPage,NotificationsPage}.tsx. Added: this doc. Deleted: none.

## Not changed
backend/ and tests/ are byte-identical to the Part 15 package. No API path, RBAC, auth, tracking, ledger, schema or nav-role logic touched. All `data-testid`s preserved.

## Blocked / pending
`npm ci`, `tsc --noEmit`, `vite build`, lint, frontend tests, real-browser runtime with live backend: BLOCKED (registry 403). Verified instead: per-file TS syntax parse (57 files, 0 errors), relative-import resolution (0 unresolved), route/nav audit, secret scan, fake-data grep, backend diff.

## Deferred
Per-page adoption of `LoadingState`/`ErrorState`/`FormField`/`ConfirmDialog` and removal of heavy inline `style={{}}` in older pages (shared components are ready); a11y audit with a real screen reader; visual regression of every page in the full app; light-theme polish pass on all pages.

## Issues noted (not fixed)
Admin pages show both an error banner and the empty state when an API call fails (cosmetic; logic untouched).

---
# Part 16.1 — Cleanup & consistency pass
- KpiCard: default thousands grouping (`en-US`, e.g. 1,000 / 10,000 / 1,000,000); verified by rendering the real component: zero, negative, decimals, strings (e.g. `12.5%`), unavailable, and caller-supplied formats unchanged. Money KPIs (Network Revenue/Payout/Margin, Manager Earnings) now carry a ₹ format (display only; values untouched).
- LineChart: empty data now shows an empty state instead of emitting an invalid SVG path (console error for brand-new publishers).
- Publisher Home, Admin Dashboard, Manager Dashboard: skeleton loading state while data is null.
- Topbar title no longer wraps/overflows at 390px (ellipsis).
- Copy: "PostgreSQL is the sole authoritative ledger" (Financials) and "tracking and conversion engine" (Campaign edit) replaced with user-facing wording.
- Publisher Home stat cards group thousands.
- Verification: 114 headless Chromium renders (19 scenarios × dark/light × desktop 1366 / tablet 820 / mobile 390): 0 horizontal overflow, 0 console errors. Not executed: npm install/ci (E403), tsc, vite build, lint, frontend tests — BLOCKED.

---
# Part 16.2 — Global accent theme + glassmorphic sidebar

**Architecture.** `<html data-theme="dark|light">` (existing, user-owned, unchanged) and a new `<html data-accent="deep-yellow|deep-sky|deep-orange|hasmind-purple">` (global, Super-Admin-owned) are independent. `styles.css` defines semantic tokens (`--accent-primary`, `-hover`, `-soft`, `-border`, `-text`, `-glow`, `--accent-gradient-start/end`, `--accent-focus`, `--accent-on`) with one block per accent and a mode-specific `--accent-primary-text` (lighter on dark, darker on light). The legacy `--qx-accent`/`--qx-gradient` names now resolve to those tokens, so existing components follow the accent without per-page edits. Semantic colours (success/danger/warning, and "info", now fixed sky blue) are not accent-driven. Text on accent fills uses `--accent-on` (dark on Deep Yellow, white on the others).

**Default = Deep Yellow** (CSS `:root`, `index.html` first-paint script, backend fallback).

**Persistence.** Existing `system_settings` collection, key `accent_theme` (values `deep-yellow|deep-sky|deep-orange|hasmind-purple`). Backend (minimal, isolated): `GET /api/v1/appearance` (public, rate-limited, non-sensitive, never errors — falls back to default), `PUT /api/v1/admin/settings/appearance` (Super Admin only via `require_role`, validated allow-list, audited as `ACCENT_THEME_UPDATED`). Frontend: `theme/AccentContext.tsx` fetches on load and on tab focus; `localStorage["qx-accent"]` is only a first-paint cache.

**UI.** Super Admin → System Settings → Appearance: four radio-card swatches (keyboard operable, `role=radiogroup/radio`, `aria-checked`, check mark + "Selected" text — not colour-only), plus a token-driven preview. No control exists for Manager/Publisher.

**Sidebar glass.** ~80% opaque surface (`color-mix`), 14px blur + slight saturation, hairline border, faint accent tint; a very low-alpha accent wash sits behind it. Mobile drawer: 90% opaque, 10px blur, no fixed background attachment. Falls back to the solid surface without `backdrop-filter` support and under `prefers-reduced-transparency`.

**Verification (headless Chromium, real app code).** 312 renders (theme × mode × 390/820/1366 across login, Settings, Admin/Manager/Publisher dashboards, campaigns, financials, security, reports/wallet/browse/settlements, loading/empty/error states): 0 horizontal overflow, 0 console errors. Interaction tests (all pass): four options; default deep-yellow; selecting an accent changes tokens but not `data-theme`; light/dark toggle works and accent persists; keyboard activation; Manager/Publisher receive the global accent and keep their own mode; no accent control for them; invalid server value → deep-yellow. Mobile drawer opens with glass at 390px (no overflow). Backend: `tests/part16_2_theme_test.py` (9/9, stubbed collaborators). Contrast (on-accent text / accent text on surface) computed per theme × mode: all accent-text ≥ 5.7:1; on-accent ≥ 3.5:1 at the lightest gradient stop (Deep Sky start 2.0:1 — inherited Quantix logo gradient, kept for brand recognisability; end stop 4.7:1).

**Not executed (BLOCKED):** `npm install` (E403), `tsc`, `vite build`, lint, frontend tests; FastAPI app import/route tests (fastapi not installable here) — the endpoint wiring is syntax-checked only.

---
# Part 16.2.1 — Final auth UI + dual publisher invite system + profile data continuity

**Auth UI.** Login: Quantix branding, email, password with visibility toggle, Sign In, OR, outlined Register. Register: Full Name, Email, Mobile *, Company *, Password (strength bar), Confirm Password, Create Account, OR, Login. No token / Manager ID input anywhere; the invite is resolved from `/register/:token` (legacy `?invite=`, `?token=` and `/onboarding/*` routes still work). `/register` without an invite shows an "invitation only" notice; invalid invites show a safe error. Both pages use the global accent tokens (no auth palette); light/dark stays independent.

**Deep Sky contrast.** Gradient stops deepened to `#0a7cb8 → #2b6fe3` (white text 4.58:1 / 4.68:1), hover `#086a9c`. Other themes untouched.

**Invites.** Server resolves `invitation_type`: `MANAGER_INVITE` (bound server-side to the manager's own ID, manager must be ACTIVE) or `SUPER_ADMIN_INVITE` (no manager → publisher PENDING with `manager_id = NULL`, visible only to Super Admin). The signup schema forbids a `manager_id` field (`extra="forbid"`); a manager ID in a URL is ignored. Signup re-validates the manager is still active. Tokens: hash-only storage, single-use, 72h expiry, revocable (unchanged).

**Approval.** Super Admin: "Approve & Assign Manager" (dropdown from `GET /admin/managers/assignable`, ACTIVE managers only). Manager-invited publishers: Approve/Reject by the assigned Manager or Super Admin. Order: conditional assign (`manager_id: None` filter) → atomic PENDING→ACTIVE → compensating unassign if the transition lost a race. Only the winner generates the ID, audits and emails, so duplicate approvals create no duplicate user/ID/email. Reject keeps the record. Existing random 4-digit Publisher ID preserved. Invariant: ACTIVE publisher always has a manager. Reassignment of an already-assigned publisher is out of scope. Mongo has no cross-collection transactions here, hence the compensating-action pattern.

**Profile continuity.** name, email, mobile, company persisted on the `publishers` record and shown on Account → Profile with Publisher ID, status, member since and Assigned Manager ("Not assigned yet" before assignment). Password never returned. Mobile/company are required in the UI, optional in the backend schema (backward compatible).

**Notifications / audit.** Existing email service; recipients de-duplicated. New audit actions `PUBLISHER_APPLICATION_SUBMITTED`, `PUBLISHER_MANAGER_ASSIGNED`; no secrets logged.

**Contract change.** `part2_test.py`: "SA invite without manager_id → 422" became "allowed, manager_id None".

**Verification.** `part16_2_1_invite_flow_test.py` 48/48 (real services + in-memory fake Mongo, stubbed deps; covers A–I, tamper, idempotency, rollback). Headless Chromium: Login/Register and queue/profile/settings renders across 4 accents × 2 modes × 390/820/1366, 0 overflow, 0 console errors; interaction tests pass.

**BLOCKED:** npm install (E403) → no tsc/build/lint/frontend tests; no real FastAPI/Mongo → no HTTP/RBAC-dependency integration tests.

---

# Part 17 — Final report / onboarding / postback / support correction pass

Status: **PARTIAL** — code complete and tested at unit/stub/browser-mock level; real runtime (FastAPI + Mongo + Postgres + Vite build) is **BLOCKED in the authoring sandbox** and must be verified by Emergent.

## Behaviour changes (contracts)
- **Open publisher registration**: `POST /onboarding/publisher` no longer needs an invite. Mobile + company required without one. Status PENDING, `manager_id = null`, `invitation_type = OPEN_REGISTRATION`. A publisher can never send `manager_id` (`extra="forbid"`). Invites remain as an optional legacy path (`/register/:token`).
- **Password policy** (publisher): ≥5 letters, ≥1 uppercase, ≥1 number, ≥1 special; enforced in `schemas/auth.validate_publisher_password` and mirrored live in the UI.
- **Approval**: Manager is optional. Super Admin approve without manager → ACTIVE, `manager_id = null` ("Not assigned yet"). `PUT /publishers/{user_id}/manager` assigns/reassigns later (Super Admin, ACTIVE managers only, REJECTED publishers refused, same manager = no-op). Reject keeps the record and blocks login.
- **Manager mobile**: stored on the manager record; `PUT /manager/me/mobile`. `GET /support/contact` returns the assigned manager name/mobile (or null) and the WhatsApp link.
- **WhatsApp group link**: `GET/PUT /admin/settings/support` (Super Admin), https + WhatsApp hosts only, audited (URL not logged).
- **Reports**: `/publisher/clicks` and `/publisher/conversions` return real rows (per-record event, publisher payout, location, IP, P1–P10, no revenue/margin/device/OS/browser). `/publisher/conversions/event-summary` aggregates per event. Sidebar `?tab=` drives the report view.
- **Export Center**: `POST/GET /publisher/exports`, `GET /publisher/exports/{id}/download` (async job in `export_jobs`, CSV/JSON, 90-day max, 3 active jobs, 20k-row cap, CSV formula guard, owner-scoped).
- **Global Postback**: `GET/PUT/DELETE /admin/postback/global-config` (publisher role), `GET /admin/postback/macros`. Precedence: campaign-specific (latest version enabled) → Global (latest version enabled, not deleted) → none. No duplicate delivery per conversion.
- **Publisher macro vocabulary** (13 basic + P1–P10): UTM / Trackier / Trackix / Offer18 / revenue macros are rejected on save and resolve blank in old templates.
- **Postback logs** expose direction, masked URL, HTTP status, attempt, retry info, result.
- **Logos**: transparent PNGs + dedicated dark-mode wordmark.

## Test contract changes
`part6_postback_test.py` (`{utm_source}` → `{event}`) and `part16_2_1_invite_flow_test.py` (manager optional at approval) were updated deliberately. `harness interact2.js` UI assertions about "Registration is by invitation" are superseded.

## Known limitations
- Geo (country/state/city) is not captured at click time (no GeoIP) → Location and geo macros are blank.
- No separate "publisher override payout" concept exists; the event's configured publisher payout stamped at conversion time is used.
- Export content is stored in the job document (bounded by the 20k-row cap).

## Tests executed (authoring sandbox)
`tests/part17_test.py` 123/123; `part16_2_1_invite_flow_test.py` 47/47; `part16_2_theme_test.py` 9/9; frontend Playwright mock suites (interact3, accent) all passed; 64 frontend files syntax-audited. **BLOCKED**: npm install/typecheck/build/lint (registry E403), pip (backend app import, older suites), real Mongo/Postgres, real email/OTP.
