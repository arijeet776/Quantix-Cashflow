# Temporary Google Sheets Backend

Architecture: React → FastAPI → storage layer → `GoogleSheetsStorageAdapter` → Google Apps Script web app → Google Sheets.
Set `STORAGE_BACKEND=google_sheets` to use it; `STORAGE_BACKEND=mongodb_supabase` (default) keeps the MongoDB + Supabase code path untouched. The frontend and business logic are unchanged.

## Setup (no manual tab/header creation)
1. Open script.google.com, create a project, paste the whole of `gas/Code.gs`.
2. Project Settings → Script Properties, add: `CORE_SPREADSHEET_ID`, `TRACKING_SPREADSHEET_ID`, `FINANCE_SPREADSHEET_ID` (the three existing empty sheets) and `API_SECRET` (random, 32+ chars). Never commit these.
3. Run `initializeQuantixDatabase()` once (authorize). It creates every missing tab and header row; it never deletes, overwrites or duplicates. Re-running is a no-op. `checkConfiguration()` reports missing properties without revealing values.
4. Deploy → New deployment → Web app: Execute as **Me**, Who has access **Anyone** (the secret in the request body is the access control). Copy the `/exec` URL.
5. Backend env: `STORAGE_BACKEND=google_sheets`, `GOOGLE_SHEETS_CORE_API_URL`, `GOOGLE_SHEETS_TRACKING_API_URL`, `GOOGLE_SHEETS_FINANCE_API_URL` (all may be the same deployment URL), `GOOGLE_SHEETS_API_SECRET` (= `API_SECRET`). Config validation requires https URLs and a secret of at least 32 characters.
6. Re-deploy a **new version** whenever `Code.gs` changes. After changing `schema.py` run `python3 backend/tools/generate_apps_script.py`.

## API contract
`POST <exec-url>` with a JSON body (send as `text/plain`; Apps Script cannot read headers, so the secret is in the body):
`{"secret": "...", "action": "...", "table": "Users", ...}`.
Actions: `ping`, `health`, `initialize`, `get`, `find_one`, `list`/`query`, `count`, `sum`, `ledger_summary`, `create` (`data` or `rows`), `update`, `delete`, `find_one_and_update`, `batch`.
Responses: `{"ok": true, "data": ...}` or `{"ok": false, "error": {"code": "...", "message": "..."}}`.
Error codes: UNAUTHORIZED, NOT_CONFIGURED, INVALID_TABLE, INVALID_ACTION, VALIDATION_ERROR, DUPLICATE_KEY, SERVER_BUSY, FORBIDDEN_TABLE_OPERATION, INSUFFICIENT_BALANCE, VALUE_TOO_LONG, SCHEMA_CONFLICT, INTERNAL_ERROR.
`GET` is a liveness probe only and returns no data. Filters use the Mongo-style operators (`$eq $ne $gt $gte $lt $lte $in $nin $exists $regex $not $and $or $nor`); updates support `$set $inc $push $unset $setOnInsert`.
Limits: list page ≤ 1000 rows, batch ≤ 500 rows / 50 operations, cell ≤ 49 000 chars (larger values spill into the internal `_blobs` tab).

## Safety properties
- Secret required on every request; never logged or returned.
- Writes serialised with LockService; busy lock → `SERVER_BUSY` (backend retries reads, never blind-retries a write that may have applied).
- Reads use batch `getValues`, column-first filtering, pagination; no cached balances.
- Ledger is append-only (update/delete refused). Wallet balance is always computed from ledger rows (`ledger_summary`). A withdrawal request checks the balance and writes withdrawal + hold in one locked batch; reject/cancel are conditional transitions plus a release row of the exact held amount.
- IDs: existing strategies preserved (Mongo-style 24-hex `_id`, `ledger_id`, `WD…`, campaign/publisher IDs); unique keys enforced inside the lock.

## Schema mapping (generated from `backend/app/storage/schema.py`)
Wallet, Payments and Payout Adjustments have no separate tabs: they are projections of `FinancialLedger` / `Withdrawals`, exactly as in the Postgres design. Postback logs = `OutboundPostbacks`.

### CORE spreadsheet (Quantix Core Database)

| Tab | App collection | Headers (type) | Unique | Notes |
|---|---|---|---|---|
| Users | `users` | `_id`, `email`, `role`, `account_status`, `email_verified`, `password_hash`, `created_at`, `updated_at`, `_extra` | email |  |
| Managers | `managers` | `_id`, `manager_id`, `user_id`, `display_name`, `mobile`, `created_at`, `updated_at`, `_extra` | manager_id; user_id |  |
| Publishers | `publishers` | `_id`, `publisher_id`, `user_id`, `manager_id`, `display_name`, `mobile`, `company`, `invitation_type`, `invited_by`, `invite_id`, `created_at`, `updated_at`, `_extra` | publisher_id; user_id |  |
| Campaigns | `campaigns` | `_id`, `campaign_id`, `status`, `status_reason`, `status_reason_type`, `current_config_version`, `summary`, `created_by`, `created_at`, `updated_at`, `_extra` | campaign_id |  |
| CampaignConfigVersions | `campaign_config_versions` | `_id`, `campaign_id`, `version`, `effective_from`, `apply_scope`, `created_by`, `created_at`, `name`, `advertiser_name`, `platform`, `events`, `_extra` | campaign_id+version |  |
| CampaignAccess | `campaign_access` | `_id`, `access_id`, `campaign_id`, `publisher_id`, `manager_id`, `status`, `requested_at`, `decided_at`, `decided_by`, `note`, `_extra` | access_id; campaign_id+publisher_id |  |
| Invites | `invites` | `_id`, `token_hash`, `role`, `target_email`, `manager_id`, `invitation_type`, `created_by`, `status`, `created_at`, `expires_at`, `used_at`, `revoked_at`, `_extra` | token_hash |  |
| Otps | `otps` | `_id`, `user_id`, `purpose`, `code_hash`, `status`, `attempts`, `max_attempts`, `created_at`, `expires_at`, `_extra` | — |  |
| RefreshSessions | `refresh_sessions` | `_id`, `jti`, `user_id`, `created_at`, `expires_at`, `revoked_at`, `_extra` | jti |  |
| Settings | `system_settings` | `_id`, `key`, `value`, `updated_by`, `created_at`, `updated_at`, `_extra` | key |  |
| AuditLogs | `audit_logs` | `_id`, `action`, `actor_user_id`, `target_user_id`, `before`, `after`, `reason`, `metadata`, `request_id`, `timestamp`, `_extra` | — |  |
| ApiKeys | `api_keys` | `_id`, `key_id`, `name`, `key_hash`, `prefix`, `scope`, `created_by`, `created_at`, `last_used_at`, `revoked_at`, `_extra` | key_hash; key_id |  |
| Webhooks | `webhooks` | `_id`, `webhook_id`, `name`, `url`, `secret`, `events`, `enabled`, `created_by`, `created_at`, `_extra` | webhook_id |  |
| BlockedIps | `blocked_ips` | `_id`, `ip_address`, `block_reason`, `campaign_id`, `publisher_id`, `manager_id`, `first_detected_at`, `last_detected_at`, `detection_count`, `status`, `under_investigation`, `detection_source`, `created_by`, `updated_by`, `created_at`, `updated_at`, `_extra` | ip_address |  |
| PurgeOperations | `purge_operations` | `_id`, `purge_id`, `campaign_id`, `campaign_name`, `status`, `actor_user_id`, `request_id`, `planned_counts`, `deleted_counts`, `verification`, `error`, `created_at`, `updated_at`, `completed_at`, `_extra` | purge_id |  |

### TRACKING spreadsheet (Quantix Tracking & Operations)

| Tab | App collection | Headers (type) | Unique | Notes |
|---|---|---|---|---|
| TrackingLinks | `tracking_links` | `_id`, `link_id`, `public_code`, `campaign_id`, `campaign_code`, `publisher_id`, `publisher_code`, `manager_id`, `status`, `created_by`, `created_at`, `updated_at`, `_extra` | link_id; public_code |  |
| Clicks | `clicks` | `_id`, `quantix_click_id`, `campaign_id`, `campaign_code`, `publisher_id`, `publisher_code`, `manager_id`, `link_id`, `link_code`, `original_params`, `ip`, `user_agent`, `country`, `state`, `city`, `source_click_id`, `external_click_id`, `agency_click_id`, `config_version`, `click_created_at`, `sub_id_1`, `sub_id_2`, `sub_id_3`, `sub_id_4`, `sub_id_5`, `sub_id_6`, `sub_id_7`, `sub_id_8`, `sub_id_9`, `sub_id_10`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `_extra` | quantix_click_id |  |
| Conversions | `conversions` | `_id`, `conversion_id`, `idempotency_key`, `platform`, `campaign_id`, `campaign_code`, `publisher_id`, `publisher_code`, `manager_id`, `link_id`, `quantix_click_id`, `external_click_id`, `agency_click_id`, `sub_affiliate_id`, `external_conversion_id`, `event`, `goal`, `raw_event_value`, `raw_goal_value`, `status`, `raw_status`, `advertiser_revenue`, `upstream_payout`, `sale_amount`, `currency`, `payout`, `payout_note`, `approval_status`, `suspicious_velocity`, `sub_ids`, `utm`, `click_created_at`, `event_occurred_at`, `postback_received_at`, `conversion_created_at`, `config_version`, `request_id`, `approval_decided_by`, `approval_decided_at`, `approval_note`, `updated_at`, `_extra` | conversion_id; idempotency_key |  |
| InboundPostbacks | `inbound_postbacks` | `_id`, `postback_id`, `platform`, `campaign_id`, `endpoint_id`, `conversion_id`, `result`, `status`, `http_status`, `error`, `payload`, `received_at`, `_extra` | postback_id |  |
| PostbackEndpoints | `postback_endpoints` | `_id`, `endpoint_id`, `token`, `campaign_id`, `platform`, `status`, `received_count`, `failure_count`, `last_received_at`, `created_by`, `created_at`, `updated_at`, `_extra` | token; endpoint_id |  |
| PublisherPostbackConfigs | `publisher_postback_configs` | `_id`, `publisher_id`, `campaign_id`, `version`, `url_template`, `macros_selected`, `enabled`, `deleted`, `created_by`, `created_at`, `_extra` | — |  |
| OutboundPostbacks | `outbound_postbacks` | `_id`, `outbound_id`, `conversion_id`, `publisher_id`, `campaign_id`, `event`, `status`, `url`, `macros_used`, `config_version`, `config_scope`, `attempts`, `attempt_count`, `final_status`, `refired_by`, `refired_at`, `created_at`, `_extra` | outbound_id |  |
| WebhookDeliveries | `webhook_deliveries` | `_id`, `delivery_id`, `webhook_id`, `event`, `status`, `http_status`, `attempts`, `error`, `payload`, `created_at`, `_extra` | delivery_id |  |
| ExportJobs | `export_jobs` | `_id`, `job_id`, `publisher_id`, `kind`, `format`, `filters`, `status`, `records`, `truncated`, `error`, `content`, `created_at`, `completed_at`, `_extra` | job_id |  |
| SupportTickets | `support_tickets` | `_id`, `ticket_id`, `subject`, `category`, `priority`, `created_by_user_id`, `created_by_role`, `publisher_id`, `manager_id`, `status`, `messages`, `created_at`, `updated_at`, `resolved_at`, `closed_at`, `_extra` | ticket_id |  |
| Blobs | `_blobs` | `_id`, `blob_id`, `seq`, `data`, `created_at`, `_extra` | blob_id+seq |  |

### FINANCE spreadsheet (Quantix Finance)

| Tab | App collection | Headers (type) | Unique | Notes |
|---|---|---|---|---|
| FinancialLedger | `financial_ledger` | `id`, `ledger_id`, `idempotency_key`, `transaction_type`, `direction`, `publisher_id`, `manager_id`, `campaign_id`, `conversion_id`, `withdrawal_id`, `amount`, `currency`, `status`, `source`, `reference`, `actor_user_id`, `request_id`, `metadata`, `created_at`, `effective_at`, `_extra` | ledger_id; idempotency_key | append-only, autoinc `id` |
| Withdrawals | `withdrawals` | `id`, `withdrawal_id`, `idempotency_key`, `publisher_id`, `manager_id`, `amount`, `currency`, `status`, `reference`, `rejection_reason`, `requested_at`, `updated_at`, `reviewed_by`, `paid_by`, `_extra` | withdrawal_id; idempotency_key | autoinc `id` |

## Migration / rollback
- To return to the real stack: set `STORAGE_BACKEND=mongodb_supabase`, restart. Nothing else changes.
- Data created while on Sheets is NOT auto-copied to Mongo/Supabase. Export the tabs (File → Download) and import per collection before cut-over if it must be kept.
- Never reuse the Sheets backend for production scale: Apps Script quotas (execution time, ~20 000 URL calls/day on consumer accounts, 10M-cell sheet limit) and ~1 s latency apply.

## Known limits
Unique-key checks, aggregation (`$group` over ≤ 50 000 rows) and click buffering (2 s write-behind) are implemented in the adapter. Real Apps Script deployment, quotas and latency were not exercised in this environment (tests ran the real `Code.gs` in a local emulator).
