# Change: click IP visible to every role; offline approve in batches

## What changed
1. **Click IP is now shown to Publisher, Manager and Super Admin** on the Click Report.
   - Backend: `services/click_report_service.py` returns `ip` for every role. Each role still sees only its own clicks (publisher = own clicks, manager = own publishers, super admin = all).
   - Advertiser click id (`external_click_id`) stays Super Admin only.
   - Frontend: `ClickReportPage.tsx` shows the IP column for everyone.
2. **Publisher Click Report page** added: `/publisher/click-report`, linked in the publisher sidebar under Report.
3. **Offline approve in batches of 25** (`OfflineReportPage.tsx`). The UI sends several smaller requests one after another and shows live progress. Approval is idempotent (already approved clicks return `already_approved`), so retrying after an error is safe.

## Privacy note
Visitor IPs are personal data. Showing them to third-party publishers is now the configured behaviour. Review it against the applicable data-protection rules before relying on it in production.

## Verification status
- Python: changed file parses (AST check).
- Frontend: all 69 TS/TSX files parse (parse-only check).
- NOT verified: TypeScript type-check and production build (npm registry blocked in the build sandbox), and runtime behaviour against live Render and Supabase.

## Tracking domain guard
- `settings_service.update_tracking_domain` now refuses a tracking domain whose host is a frontend origin (`ALLOWED_ORIGINS`, e.g. the Netlify site). Tracking links are served by the BACKEND at the app root (`/{campaign_code}/{link_code}`), so a frontend domain made every link return 404.
- Correct value: the Render service URL, e.g. `https://quantix-cashflow-api-2026.onrender.com` (no path, no trailing slash needed).
- Existing links are NOT stored with a fixed domain: `serialize_link` builds the URL from the active tracking domain, so they update automatically once the domain is corrected.

## Publisher dashboard: current month only
- `conversion_repository.publisher_dashboard_stats` now covers the CURRENT calendar month in IST: month clicks/conversions/earnings and a day-by-day series (`daily`, zero-filled up to today). The old 12-month `monthly` series is removed.
- `PublisherHomePage`: "Conversions Trend" and "Earnings Overview" show the current month, labelled with the month name.
- Lifetime totals are unchanged.

## Campaign purge (Supabase): full cleanup, ledger kept (option B)
- NEW SQL, run ONCE in Supabase SQL Editor AFTER 001: `backend/migrations/supabase/002_campaign_purge.sql` (function `qx_purge_campaign`).
- Purge works only for an ENDED campaign, after typing its exact name, and is refused while any conversion is `pending_report`.
- Hard-deleted (one transaction): clicks, conversions, inbound/outbound postback logs, tracking links, campaign access, blocked IPs, postback endpoints, publisher postback configs, campaign config versions, and the campaign row (name included).
- Kept: `financial_ledger` money rows (amount, publisher, direction, dates) with the campaign link removed (campaign_id and conversion_id set to NULL, name/code keys dropped from metadata). The append-only trigger is disabled and re-enabled inside the same transaction; normal updates stay blocked.
- Audit: one `CAMPAIGN_PURGED` row with campaign id and row counts, no campaign name.
- Backend: `purge_service` uses the function in Supabase mode; Mongo/Sheets modes keep the old behaviour. `SupabaseRestAdapter.purge_campaign` calls the RPC. `PostgrestTransport` now accepts an RPC path per call.
- Tested locally on PostgreSQL 16 (scratch DB): pending guard refuses, only the target campaign's operational rows are removed, ledger money kept and unlinked, name absent from audit, append-only still enforced afterwards.
- Not yet verified: the live Supabase project and the Render deploy.
