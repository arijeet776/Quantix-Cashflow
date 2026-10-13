# Update: Quantix click id, per-campaign macros, click report, offline report

## Backend
- Click id format: `QNCTX` + 10 chars (old `QXCLK_` ids still resolve).
- Campaign config (stored in the config JSON / `_extra`): `click_id_param`, `advertiser_click_id_param`, `event_param`, `campaign_title_param`.
- Click redirect: Quantix click id is injected into `click_id_param`; the same param is dropped if a publisher sends it.
- Postback setup: platforms = trackier / offer18 / custom (Trackix removed from new endpoints). Generate returns `advertiser_postback_url` (macros appended after `?`).
- Inbound postback: reads click id / advertiser click id / event / campaign title from the campaign's mapping; stores `campaign_title` on the conversion and the advertiser click id on the click.
- New endpoints:
  - `GET /api/v1/click-reports` (all roles, role-scoped; IP + advertiser click id only for Super Admin)
  - `GET /api/v1/admin/conversion-review/offline/campaigns`
  - `GET /api/v1/admin/conversion-review/offline/clicks`
  - `POST /api/v1/admin/conversion-review/offline/approve`
  - `POST /api/v1/admin/conversion-review/offline/mark`
- Publisher campaign detail now returns `reserved_slot`.

## Frontend
- Campaign form: macro selection; removed postback endpoint / API key / free-text platform.
- New pages: Click Report (`/click-report`, `/manager/click-report`), Offline Report (`/offline-report`, `/manager/offline-report`).
- Sidebar arrow fixed (closes the drawer on phones); HIQ-style publisher sidebar, stacked glass stat cards, round-tick column chooser.

## Database
No SQL migration needed: every table already has an `_extra jsonb` column that stores the new fields.
