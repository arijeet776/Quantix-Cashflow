#!/usr/bin/env python3
"""One-shot, idempotent patcher that routes the existing DB modules through
app.storage.runtime. (Kept in tools/ for auditability; running it twice is a no-op.)"""
import os
import re

APP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app")


def patch(rel, subs):
    path = os.path.join(APP, rel)
    s = open(path).read()
    if "storage import runtime" in s or "from app.storage import runtime" in s:
        print("already wired:", rel)
        return
    for a, b in subs:
        if a not in s:
            raise SystemExit(f"{rel}: anchor not found: {a[:60]!r}")
        s = s.replace(a, b, 1)
    open(path, "w").write(s)
    print("wired:", rel)


patch("db/mongodb.py", [
    ("from app.config import get_settings\n", "from app.config import get_settings\nfrom app.storage import runtime\n"),
    ('''    global _client, _db
    settings = get_settings()
    _client = AsyncIOMotorClient''', '''    global _client, _db
    settings = get_settings()
    if runtime.is_sheets():
        # Temporary Google Sheets backend: no Mongo connection at all.
        if await runtime.get_adapter().ping():
            logger.info("Connected to the Google Sheets storage API (STORAGE_BACKEND=google_sheets)")
        else:
            logger.warning("Google Sheets storage API not reachable at startup - will keep retrying via /health/ready")
        return
    _client = AsyncIOMotorClient'''),
    ("async def close_mongo_connection() -> None:\n", "async def close_mongo_connection() -> None:\n    if runtime.is_sheets():\n        await runtime.close()\n        return\n"),
    ("def get_database() -> AsyncIOMotorDatabase:\n", "def get_database() -> AsyncIOMotorDatabase:\n    if runtime.is_sheets():\n        return runtime.get_sheets_database()  # Motor-compatible facade over Google Sheets\n"),
    ("async def ping_mongo() -> bool:\n    try:", "async def ping_mongo() -> bool:\n    if runtime.is_sheets():\n        return await runtime.get_adapter().ping()\n    try:"),
    ("    if _indexes_ready:\n        return True\n    if _db is None:", "    if runtime.is_sheets():\n        return True  # uniqueness is enforced by the Apps Script from storage/schema.py\n    if _indexes_ready:\n        return True\n    if _db is None:"),
])

patch("db/postgres.py", [
    ("from app.config import get_settings\n", "from app.config import get_settings\nfrom app.storage import runtime\n"),
    ("async def connect_to_postgres() -> None:\n    global _pool\n", "async def connect_to_postgres() -> None:\n    global _pool\n    if runtime.is_sheets():\n        return  # finance lives in the FinancialLedger / Withdrawals sheets\n"),
    ("async def close_postgres_connection() -> None:\n", "async def close_postgres_connection() -> None:\n    if runtime.is_sheets():\n        return\n"),
    ("def get_pool() -> asyncpg.Pool:\n", "def get_pool() -> asyncpg.Pool:\n    if runtime.is_sheets():\n        return runtime.get_sheets_pool()  # opaque pool; finance repositories route to Google Sheets\n"),
    ("async def ping_postgres() -> bool:\n    global _pool\n", "async def ping_postgres() -> bool:\n    global _pool\n    if runtime.is_sheets():\n        return await runtime.get_adapter().ping()\n"),
])

patch("db/migrations.py", [
    ('''    """Returns the list of migration filenames applied THIS call (empty if none new)."""
''', '''    """Returns the list of migration filenames applied THIS call (empty if none new)."""
    from app.storage import runtime

    if runtime.is_sheets():
        # Google Sheets mode: the schema is created idempotently by the Apps Script
        # (initializeQuantixDatabase); there are no SQL migrations to apply.
        return []
'''),
])


def add_dispatch(s, fname, call_args):
    pat = re.compile(r"(async def %s\([^)]*\)[^:]*:\n)(    \"\"\"(?:.|\n)*?\"\"\"\n)?" % re.escape(fname))
    m = pat.search(s)
    if not m:
        raise SystemExit(f"function not found: {fname}")
    ins = f"    if runtime.is_sheets():\n        from app.storage import sheets_finance\n\n        return await sheets_finance.{fname.lstrip('_') if fname == '_atomic_transition' else fname}({call_args})\n"
    if fname == "_atomic_transition":
        ins = ins.replace("sheets_finance._atomic_transition", "sheets_finance._atomic_transition").replace("sheets_finance.atomic_transition", "sheets_finance._atomic_transition")
    return s[:m.end()] + ins + s[m.end():]


# ledger_repository
path = os.path.join(APP, "db/ledger_repository.py")
s = open(path).read()
if "from app.storage import runtime" not in s:
    s = s.replace("from app.db.postgres import get_pool\n", "from app.db.postgres import get_pool\nfrom app.storage import runtime\n", 1)
    s = add_dispatch(s, "insert_entry", "conn, idempotency_key=idempotency_key, transaction_type=transaction_type, direction=direction, publisher_id=publisher_id, amount=amount, source=source, manager_id=manager_id, campaign_id=campaign_id, conversion_id=conversion_id, withdrawal_id=withdrawal_id, reference=reference, actor_user_id=actor_user_id, request_id=request_id, metadata=metadata")
    s = add_dispatch(s, "get_balance", "conn, publisher_id")
    s = add_dispatch(s, "list_entries", "publisher_id, manager_id, transaction_type, skip, limit")
    s = add_dispatch(s, "network_overview", "")
    s += '''

async def get_earning_for_conversion(conn, conversion_id: str):
    """The original 'earning' ledger row of a conversion (None if there is none)."""
    if runtime.is_sheets():
        from app.storage import sheets_finance

        return await sheets_finance.get_earning_for_conversion(conn, conversion_id)
    return await conn.fetchrow(
        "SELECT * FROM financial_ledger WHERE conversion_id = $1 AND transaction_type = 'earning'", conversion_id
    )


async def manager_scope_totals(conn, manager_id: str) -> dict:
    """Credits / debits / earned across the publishers of one manager."""
    if runtime.is_sheets():
        from app.storage import sheets_finance

        return await sheets_finance.manager_scope_totals(conn, manager_id)
    row = await conn.fetchrow(
        """
        SELECT
            COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0) AS total_credits,
            COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0) AS total_debits,
            COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'earning'), 0) AS total_earned
        FROM financial_ledger WHERE manager_id = $1 AND status = 'posted'
        """,
        manager_id,
    )
    return dict(row)
'''
    open(path, "w").write(s)
    print("wired: db/ledger_repository.py")

# withdrawal_repository
path = os.path.join(APP, "db/withdrawal_repository.py")
w = open(path).read()
if "from app.storage import runtime" not in w:
    w = w.replace("from app.db.postgres import get_pool\n", "from app.db.postgres import get_pool\nfrom app.storage import runtime\n", 1)
    w = add_dispatch(w, "request_withdrawal", "publisher_id, manager_id, amount, idempotency_key, request_id")
    w = add_dispatch(w, "get_withdrawal", "withdrawal_id")
    w = add_dispatch(w, "list_withdrawals", "publisher_id, manager_id, status, skip, limit")
    w = add_dispatch(w, "_atomic_transition", "withdrawal_id, from_statuses, to_status, **set_fields")
    w = add_dispatch(w, "reject", "withdrawal_id, reviewed_by, reason")
    w = add_dispatch(w, "cancel", "withdrawal_id, publisher_id")
    open(path, "w").write(w)
    print("wired: db/withdrawal_repository.py")

# financial_service: replace the three raw SQL uses with repository calls
path = os.path.join(APP, "services/financial_service.py")
f = open(path).read()
if "get_earning_for_conversion" not in f:
    old1 = '''        original = await conn.fetchrow(
            "SELECT * FROM financial_ledger WHERE conversion_id = $1 AND transaction_type = 'earning'",
            conversion_id,
        )
'''
    assert old1 in f
    f = f.replace(old1, "        original = await ledger_repository.get_earning_for_conversion(conn, conversion_id)\n")
    old2 = re.search(r"        row = await conn\.fetchrow\(\n            \"\"\"\n            SELECT\n                COALESCE\(SUM\(amount\) FILTER \(WHERE direction = 'credit'\), 0\) AS total_credits,.*?own_mgr\[\"manager_id\"\],\n        \)\n", f, re.S)
    assert old2, "manager_overview SQL"
    f = f.replace(old2.group(0), '        row = await ledger_repository.manager_scope_totals(conn, own_mgr["manager_id"])\n')
    open(path, "w").write(f)
    print("wired: services/financial_service.py")
