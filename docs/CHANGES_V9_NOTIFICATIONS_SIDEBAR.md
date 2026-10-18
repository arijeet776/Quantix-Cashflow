# v9 changes
- Notifications: Super Admin sends / removes broadcast messages (audience: all, managers, publishers); Manager and Publisher see them on Notifications; bell shows a red dot for an unseen message. Stored in system_settings key `announcements` (no SQL needed). API: GET/POST /api/v1/announcements, DELETE /api/v1/announcements/{id}.
- Sidebar brand now uses the login-page logo (light/dark synced); collapsed sidebar shows the small mark.
- Publisher sidebar made compact; duplicate "Support & Help" menu item removed (support card remains).
- Publisher dashboard Top Campaigns table scrolls sideways on phones.
