"""
Storage backend selection.

    STORAGE_BACKEND=mongodb_supabase   (default) MongoDB + PostgreSQL/Supabase
    STORAGE_BACKEND=google_sheets      temporary Google Sheets via Apps Script

Everything backend-specific is reached through this module so the rest of the
code base (and the React frontend) never needs to know which one is active.
"""
from __future__ import annotations

from app.config import get_settings

BACKEND_MONGO_SUPABASE = "mongodb_supabase"
BACKEND_GOOGLE_SHEETS = "google_sheets"
VALID_BACKENDS = (BACKEND_MONGO_SUPABASE, BACKEND_GOOGLE_SHEETS)

_adapter = None
_database = None
_pool = None


def is_sheets() -> bool:
    return get_settings().storage_backend == BACKEND_GOOGLE_SHEETS


def get_adapter():
    global _adapter
    if _adapter is None:
        from app.storage.sheets_adapter import GoogleSheetsStorageAdapter

        s = get_settings()
        _adapter = GoogleSheetsStorageAdapter(
            {"core": s.google_sheets_core_api_url, "tracking": s.google_sheets_tracking_api_url,
             "finance": s.google_sheets_finance_api_url},
            s.google_sheets_api_secret, timeout=s.google_sheets_timeout_seconds,
        )
    return _adapter


def get_sheets_database():
    global _database
    if _database is None:
        from app.storage.mongo_compat import SheetsDatabase

        s = get_settings()
        _database = SheetsDatabase(get_adapter(), buffer_clicks=s.google_sheets_buffer_clicks,
                                   flush_interval=s.google_sheets_click_flush_seconds)
    return _database


def get_sheets_pool():
    global _pool
    if _pool is None:
        from app.storage.sheets_finance import SheetsPool

        _pool = SheetsPool()
    return _pool


async def close() -> None:
    """Flush write-behind buffers and close the HTTP client (shutdown hook)."""
    global _adapter, _database, _pool
    if _database is not None:
        await _database.flush()
    if _adapter is not None and hasattr(_adapter._transport, "aclose"):
        await _adapter._transport.aclose()
    _adapter = _database = _pool = None


def reset_for_tests() -> None:
    global _adapter, _database, _pool
    _adapter = _database = _pool = None
