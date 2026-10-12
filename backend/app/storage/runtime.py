"""
Storage backend selection.

    STORAGE_BACKEND=mongodb_supabase   (default) MongoDB + PostgreSQL/Supabase
    STORAGE_BACKEND=google_sheets      temporary Google Sheets via Apps Script
    STORAGE_BACKEND=supabase_rest      Supabase (PostgreSQL) over HTTPS/PostgREST only - no TCP driver

Everything backend-specific is reached through this module so the rest of the
code base (and the React frontend) never needs to know which one is active.
"""
from __future__ import annotations

from app.config import get_settings

BACKEND_MONGO_SUPABASE = "mongodb_supabase"
BACKEND_GOOGLE_SHEETS = "google_sheets"
BACKEND_SUPABASE_REST = "supabase_rest"
VALID_BACKENDS = (BACKEND_MONGO_SUPABASE, BACKEND_GOOGLE_SHEETS, BACKEND_SUPABASE_REST)

_adapter = None
_database = None
_pool = None


def is_sheets() -> bool:
    """True for every ADAPTER-backed mode (google_sheets AND supabase_rest): the name is historical.
    Both route repositories through the StorageAdapter instead of Motor/asyncpg."""
    return get_settings().storage_backend in (BACKEND_GOOGLE_SHEETS, BACKEND_SUPABASE_REST)


def is_supabase_rest() -> bool:
    return get_settings().storage_backend == BACKEND_SUPABASE_REST


def get_adapter():
    global _adapter
    if _adapter is None:
        s = get_settings()
        if s.storage_backend == BACKEND_SUPABASE_REST:
            from app.storage.supabase_adapter import SupabaseRestAdapter

            _adapter = SupabaseRestAdapter(s.supabase_url, s.supabase_service_key, timeout=s.supabase_timeout_seconds)
            return _adapter
        from app.storage.sheets_adapter import GoogleSheetsStorageAdapter

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
        # Supabase writes are fast and durable: no write-behind click buffer there (nothing is lost on a crash).
        buffer = s.google_sheets_buffer_clicks and s.storage_backend == BACKEND_GOOGLE_SHEETS
        _database = SheetsDatabase(get_adapter(), buffer_clicks=buffer,
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
