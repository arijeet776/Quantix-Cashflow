# v9 changes
- Notifications: Super Admin sends / removes broadcast messages (audience: all, managers, publishers); Manager and Publisher see them on Notifications; bell shows a red dot for an unseen message. Stored in system_settings key `announcements` (no SQL needed). API: GET/POST /api/v1/announcements, DELETE /api/v1/announcements/{id}.
- Sidebar brand now uses the login-page logo (light/dark synced); collapsed sidebar shows the small mark.
- Publisher sidebar made compact; duplicate "Support & Help" menu item removed (support card remains).
- Publisher dashboard Top Campaigns table scrolls sideways on phones.

# v10
- Publisher sidebar restyled to the reference (width, spacing, divider under logo, bigger logo, support card, footer user card). CSS only; menu labels Campaign/Report renamed to Campaigns/Reports.

# v11
- Approved Campaigns (publisher) now hides campaigns that are not Active (paused/ended/purged) and shows them again when Active.
- New optional campaign setting "extra_click_id_params": the same Quantix click id is also added to these parameters on the advertiser link (e.g. p1 AND source), replacing any {placeholder} already there; an inbound postback may return the id through any of them. No SQL needed.
