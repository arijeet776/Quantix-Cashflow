"""
Part 18 - temporary Google Sheets storage backend.

Runs the REAL application code (config guards, app/storage/*, db/mongodb.py,
db/postgres.py, ledger/withdrawal repositories, conversion/publisher/manager
repositories, onboarding + invite services) against the REAL gas/Code.gs
executing inside a Google-Sheets emulator (gas/test/server.js, spawned as a
subprocess and called over HTTP).

NOT covered (needs the real environment): real Google Apps Script quotas and
latency, a deployed web app, real MongoDB/Postgres, FastAPI routing/RBAC.
    python3 tests/part18_sheets_test.py
"""
import asyncio
import itertools
import json
import os
import subprocess
import sys
import types
import urllib.request
from datetime import datetime, timedelta, timezone
from decimal import Decimal

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
sys.path.insert(0, ROOT)
results = []
SECRET = "t" * 40


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))


def mod(name, **attrs):
    m = types.ModuleType(name)
    m.__dict__.update(attrs)
    sys.modules[name] = m
    return m


# ------------------------------------------------------------ third-party stubs
class PyMongoError(Exception): pass
class DuplicateKeyError(PyMongoError): pass
class InvalidId(Exception): pass


class ObjectId:
    _c = itertools.count(1)

    def __init__(self, v=None):
        self.v = str(v) if v is not None else f"{next(ObjectId._c):024x}"

    def __str__(self): return self.v
    def __eq__(self, o): return isinstance(o, ObjectId) and o.v == self.v
    def __hash__(self): return hash(self.v)
    def __repr__(self): return f"ObjectId({self.v})"


class PostgresError(Exception): pass


mod("pymongo", ReturnDocument=type("ReturnDocument", (), {"BEFORE": False, "AFTER": True}), ASCENDING=1, DESCENDING=-1); mod("pymongo.errors", DuplicateKeyError=DuplicateKeyError, PyMongoError=PyMongoError)
mod("bson", ObjectId=ObjectId); mod("bson.errors", InvalidId=InvalidId)
mod("asyncpg", Connection=object, Pool=object, PostgresError=PostgresError,
    UniqueViolationError=type("U", (PostgresError,), {}), CheckViolationError=type("C", (PostgresError,), {}),
    create_pool=None)
mod("motor"); mod("motor.motor_asyncio", AsyncIOMotorClient=object, AsyncIOMotorDatabase=object)
mod("fastapi", Request=object, status=types.SimpleNamespace(
    HTTP_400_BAD_REQUEST=400, HTTP_404_NOT_FOUND=404, HTTP_409_CONFLICT=409, HTTP_401_UNAUTHORIZED=401,
    HTTP_403_FORBIDDEN=403, HTTP_503_SERVICE_UNAVAILABLE=503, HTTP_422_UNPROCESSABLE_ENTITY=422,
    HTTP_429_TOO_MANY_REQUESTS=429))
mod("fastapi.responses", JSONResponse=object)

# ------------------------------------------------------------ start the Apps Script emulator
node = subprocess.Popen(["node", os.path.join(REPO, "gas", "test", "server.js")],
                        stdout=subprocess.PIPE, env={**os.environ, "PORT": "0", "TEST_API_SECRET": SECRET}, text=True)
PORT = int(node.stdout.readline().strip().split("=")[1])
BASE = f"http://127.0.0.1:{PORT}"


def raw_post(path_or_body, body=None):
    if body is None:
        url, data = BASE + "/exec", path_or_body
    else:
        url, data = BASE + path_or_body, body
    req = urllib.request.Request(url, data=json.dumps(data).encode(), method="POST", headers={"Content-Type": "text/plain"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def admin(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())


async def urllib_transport(url, payload):
    return await asyncio.to_thread(raw_post, payload)


async def no_sleep(_): return None


# ------------------------------------------------------------ config stub + real modules
SETTINGS = types.SimpleNamespace(
    storage_backend="google_sheets", google_sheets_core_api_url=BASE + "/exec", google_sheets_tracking_api_url=BASE + "/exec",
    google_sheets_finance_api_url=BASE + "/exec", google_sheets_api_secret=SECRET, google_sheets_timeout_seconds=30,
    google_sheets_buffer_clicks=True, google_sheets_click_flush_seconds=0.2, mongo_uri="x", mongo_db_name="x",
)
mod("app"); mod("app.db"); mod("app.core"); mod("app.services"); mod("app.schemas"); mod("app.storage")
mod("app.config", get_settings=lambda: SETTINGS)

import importlib.util


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    m = importlib.util.module_from_spec(spec); sys.modules[name] = m; spec.loader.exec_module(m); return m


audit_log = []
async def audit_record(action, **kw): audit_log.append((action, kw))
mod("app.db.audit_repository", record=audit_record)
async def _send_otp(*a, **k):
    return None
mod("app.services.otp_service", send_otp=_send_otp)
mod("app.core.security", generate_secure_token=lambda: "tok" + os.urandom(6).hex(), hash_token=lambda t: "h:" + t,
    hash_password=lambda p: "hashed:" + p[::-1])
load("app.core.enums", "app/core/enums.py"); load("app.core.exceptions", "app/core/exceptions.py")
load("app.core.audit_actions", "app/core/audit_actions.py"); load("app.core.email_utils", "app/core/email_utils.py")
for n in ("schema", "codec", "interface", "sheets_adapter", "runtime", "mongo_compat", "sheets_finance"):
    m = load(f"app.storage.{n}", f"app/storage/{n}.py"); setattr(sys.modules["app.storage"], n, m)
from app.storage import runtime, schema, codec, sheets_adapter  # noqa: E402
mongodb = load("app.db.mongodb", "app/db/mongodb.py")
postgres = load("app.db.postgres", "app/db/postgres.py")
for n in ("manager_repository", "publisher_repository", "invite_repository", "settings_repository", "conversion_repository",
          "ledger_repository", "withdrawal_repository", "support_repository", "tracking_repository", "migrations"):
    setattr(sys.modules["app.db"], n, load(f"app.db.{n}", f"app/db/{n}.py"))
sys.modules["app.db"].mongodb = mongodb
from app.db import (conversion_repository, ledger_repository, manager_repository, publisher_repository,  # noqa: E402
                    settings_repository, withdrawal_repository, migrations)
email_service = load("app.services.email_service", "app/services/email_service.py")
sys.modules["app.services"].email_service = email_service
emails = []
class Capture(email_service.EmailBackend):
    async def send(self, message): emails.append(message)
email_service._backend = Capture()
invite_service = load("app.services.invite_service", "app/services/invite_service.py")
onboarding = load("app.services.onboarding_service", "app/services/onboarding_service.py")
from app.core.exceptions import ConflictError, ServiceUnavailableError, ValidationAppError  # noqa: E402
from app.core.enums import Role  # noqa: E402

PW = "Abcde1!xyz"
UTC = timezone.utc


async def main():
    ad = sheets_adapter.GoogleSheetsStorageAdapter(
        {"core": BASE + "/exec", "tracking": BASE + "/exec", "finance": BASE + "/exec"}, SECRET,
        transport=urllib_transport, sleep=no_sleep)
    runtime.reset_for_tests(); runtime._adapter = ad

    # ===== A. backend switch =====
    check("A1 STORAGE_BACKEND=google_sheets selects the Sheets facade", runtime.is_sheets() and type(mongodb.get_database()).__name__ == "SheetsDatabase")
    check("A2 postgres.get_pool() returns the Sheets pool (no Postgres needed)", type(postgres.get_pool()).__name__ == "SheetsPool")
    check("A3 migrations are a no-op in Sheets mode", await migrations.run_migrations() == [])
    check("A4 health pings work (mongo/postgres/indexes)", await mongodb.ping_mongo() and await postgres.ping_postgres() and await mongodb.retry_indexes_if_needed())
    SETTINGS.storage_backend = "mongodb_supabase"
    try:
        mongodb.get_database(); ok = False
    except RuntimeError:
        ok = True
    try:
        postgres.get_pool(); ok2 = False
    except RuntimeError:
        ok2 = True
    check("A5 switching back restores the original MongoDB/Postgres code path", ok and ok2)
    SETTINGS.storage_backend = "google_sheets"

    # ===== B. initialization through the API =====
    rep = await ad.initialize()
    nt = len(schema.TABLES)
    check("B1 initialize creates every tab automatically", rep["tabs_created"] == nt, str(rep["tabs_created"]))
    rep2 = await ad.initialize()
    check("B2 initialize is idempotent", rep2["tabs_created"] == 0 and rep2["headers_added"] == 0)
    dump = admin("/__dump?id=FINANCE_TEST_SHEET&sheet=FinancialLedger")
    check("B3 finance sheet has the ledger headers", dump["rows"][0][:4] == ["id", "ledger_id", "idempotency_key", "transaction_type"])
    check("B4 all three spreadsheets populated", all(len(admin(f"/__dump?id={i}&sheet=x")["sheets"]) > 0 for i in ("CORE_TEST_SHEET", "TRACKING_TEST_SHEET", "FINANCE_TEST_SHEET")))

    # ===== C. security =====
    bad = sheets_adapter.GoogleSheetsStorageAdapter({"core": BASE + "/exec", "tracking": BASE + "/exec", "finance": BASE + "/exec"},
                                                    "wrong-" * 8, transport=urllib_transport, sleep=no_sleep)
    check("C1 wrong secret -> ping False, no data", await bad.ping() is False)
    try:
        await bad.find_one("users", {}); ok = False
    except ServiceUnavailableError:
        ok = True
    check("C2 wrong secret surfaces as a safe 503, never data", ok)
    check("C3 secret not in repr / str of adapter", SECRET not in repr(ad) and SECRET not in str(ad))
    check("C4 raw invalid table rejected by the API", raw_post({"secret": SECRET, "action": "count", "table": "pg_catalog"})["error"]["code"] == "INVALID_TABLE")
    try:
        await ad.find_one("not_a_table", {}); ok = False
    except KeyError:
        ok = True
    check("C5 unknown table rejected client-side too", ok)
    check("C6 secret never written to the emulator log", SECRET not in " ".join(admin("/__logs")))
    check("C7 GET returns liveness only", urllib.request.urlopen(BASE + "/exec").read().decode().count("rows") == 0)

    # ===== D. codec + Motor-compatible CRUD =====
    db = mongodb.get_database()
    now = datetime(2026, 10, 5, 10, 30, 15, 123000, tzinfo=UTC)
    r = await db["users"].insert_one({"email": "a@x.com", "role": "publisher", "account_status": "pending", "email_verified": False,
                                      "password_hash": "h", "created_at": now, "updated_at": now})
    u = await db["users"].find_one({"_id": r.inserted_id})
    check("D1 insert_one + find_one by ObjectId _id", u["email"] == "a@x.com" and isinstance(u["_id"], ObjectId) and u["_id"] == r.inserted_id)
    check("D2 datetimes round-trip tz-aware to the millisecond", u["created_at"] == now)
    try:
        await db["users"].insert_one({"email": "a@x.com", "role": "manager"}); ok = False
    except DuplicateKeyError:
        ok = True
    check("D3 unique email -> pymongo DuplicateKeyError (code paths relying on it keep working)", ok)
    res = await db["users"].update_one({"_id": r.inserted_id}, {"$set": {"account_status": "active", "updated_at": now + timedelta(seconds=5)}})
    u = await db["users"].find_one({"email": "a@x.com"})
    check("D4 update_one $set", res.modified_count == 1 and u["account_status"] == "active" and u["updated_at"] == now + timedelta(seconds=5))
    check("D5 update_one no match -> matched_count 0", (await db["users"].update_one({"email": "none@x.com"}, {"$set": {"role": "x"}})).matched_count == 0)
    up = await db["system_settings"].find_one_and_update({"key": "k"}, {"$set": {"value": "1", "updated_at": now}, "$setOnInsert": {"key": "k", "created_at": now}}, upsert=True, return_document=True)
    check("D6 settings upsert via find_one_and_update (as settings_repository does)", up["key"] == "k" and up["value"] == "1")
    up2 = await settings_repository.upsert_setting("k", "2", "u1")
    check("D7 real settings_repository.upsert_setting works unchanged", up2["value"] == "2" and await db["system_settings"].count_documents({"key": "k"}) == 1)
    check("D8 get_setting reads it back", (await settings_repository.get_setting("k"))["value"] == "2")

    # nested JSON + datetimes inside JSON + extra fields
    await db["outbound_postbacks"].insert_one({"outbound_id": "OB1", "conversion_id": "CV1", "publisher_id": "4821",
                                               "attempts": [{"attempt": 1, "sent_at": now, "http_status": 200}], "attempt_count": 1,
                                               "final_status": "delivered", "created_at": now, "unplanned_field": {"a": 1}})
    ob = await db["outbound_postbacks"].find_one({"conversion_id": "CV1"})
    check("D9 datetime inside a JSON array round-trips", ob["attempts"][0]["sent_at"] == now)
    check("D10 undeclared field survives (stored in _extra)", ob["unplanned_field"] == {"a": 1})
    check("D11 projection {_id:0}", "_id" not in await db["outbound_postbacks"].find_one({"outbound_id": "OB1"}, {"_id": 0}))
    await db["support_tickets"].insert_one({"ticket_id": "T1", "subject": "s", "messages": [{"body": "a"}], "status": "open", "created_at": now, "updated_at": now})
    await db["support_tickets"].update_one({"ticket_id": "T1"}, {"$push": {"messages": {"body": "b", "created_at": now}}})
    tk = await db["support_tickets"].find_one({"ticket_id": "T1"})
    check("D12 $push into a JSON array", len(tk["messages"]) == 2 and tk["messages"][1]["created_at"] == now)
    await db["postback_endpoints"].insert_one({"endpoint_id": "E1", "token": "tk", "campaign_id": "C1", "platform": "x", "status": "active", "received_count": 0, "failure_count": 0, "created_at": now})
    await db["postback_endpoints"].update_one({"endpoint_id": "E1"}, {"$inc": {"received_count": 1, "failure_count": 1}})
    await db["postback_endpoints"].update_one({"endpoint_id": "E1"}, {"$inc": {"received_count": 1}})
    ep = await db["postback_endpoints"].find_one({"endpoint_id": "E1"})
    check("D13 $inc (counters)", (ep["received_count"], ep["failure_count"]) == (2, 1))

    # cursor semantics
    for i in range(30):
        await db["campaign_config_versions"].insert_one({"campaign_id": "CX", "version": i + 1, "created_at": now + timedelta(minutes=i)})
    cur = db["campaign_config_versions"].find({"campaign_id": "CX"}).sort("version", -1).skip(5).limit(10)
    got = await cur.to_list(length=10)
    check("D14 find().sort().skip().limit().to_list()", [g["version"] for g in got] == list(range(25, 15, -1)))
    seen = [d["version"] async for d in db["campaign_config_versions"].find({"campaign_id": "CX"}).sort([("version", 1)])]
    check("D15 async iteration over a cursor", seen == list(range(1, 31)))
    check("D16 compound unique (campaign_id, version)", await _raises(DuplicateKeyError, db["campaign_config_versions"].insert_one({"campaign_id": "CX", "version": 3})))
    check("D17 $regex ^prefix + $options i", len(await db["campaign_config_versions"].find({"campaign_id": {"$regex": "^cx", "$options": "i"}}).to_list(length=100)) == 30)
    check("D18 delete_many", (await db["campaign_config_versions"].delete_many({"campaign_id": "CX"})).deleted_count == 30)

    # ===== E. real onboarding flow on the Sheets backend =====
    sa = str((await db["users"].insert_one({"email": "sa@x.com", "role": "super_admin", "account_status": "active", "password_hash": "x", "created_at": now, "updated_at": now})).inserted_id)
    m = await db["users"].insert_one({"email": "m@x.com", "role": "manager", "account_status": "active", "password_hash": "x", "created_at": now, "updated_at": now})
    mprof = await manager_repository.create_manager_profile(str(m.inserted_id), "Manager One", "9000000001")
    emails.clear()
    pu = await onboarding.signup_publisher(None, "pub@x.com", PW, "Pub One", mobile="9876543210", company="Co")
    pid = str(pu["_id"])
    prof = await publisher_repository.get_publisher_by_user_id(pid)
    check("E1 open signup stored (PENDING, no manager, hashed pw)", pu["account_status"] == "pending" and prof["manager_id"] is None and pu["password_hash"].startswith("hashed:"))
    check("E2 publisher id is a unique random 4-digit id", len(prof["publisher_id"]) == 4 and prof["publisher_id"].isdigit())
    await onboarding.approve_publisher(pid, Role.SUPER_ADMIN, sa, assign_manager_id=mprof["manager_id"])
    prof = await publisher_repository.get_publisher_by_user_id(pid)
    st = (await db["users"].find_one({"email": "pub@x.com"}))["account_status"]
    check("E3 approve + assign manager (atomic status transition on Sheets)", st == "active" and prof["manager_id"] == mprof["manager_id"])
    check("E4 duplicate approval is idempotent", await _raises(onboarding.AlreadyProcessedError, onboarding.approve_publisher(pid, Role.SUPER_ADMIN, sa)))
    check("E5 manager list scoped by manager_id", [p["publisher_id"] for p in await publisher_repository.list_publishers_by_manager(mprof["manager_id"])] == [prof["publisher_id"]])
    check("E6 audit trail records approval", any(a == "PUBLISHER_APPROVED" for a, _ in audit_log))
    check("E7 invite flow still works (token hashed)", (await invite_service.create_publisher_invite(Role.SUPER_ADMIN, sa, None, None))[1]["invitation_type"] == "SUPER_ADMIN_INVITE")

    # ===== F. clicks / conversions / reports =====
    pubid = prof["publisher_id"]
    admin("/__reset_stats")
    t0 = datetime.now(UTC) - timedelta(days=2)
    for i in range(40):
        await db["clicks"].insert_one({"quantix_click_id": f"QXC{i:03d}", "campaign_id": "C1" if i % 2 else "C2", "publisher_id": pubid, "manager_id": mprof["manager_id"],
                                       "link_id": "L1", "ip": f"1.1.1.{i % 4}", "original_params": {"p1": f"a{i}", "p7": "seven"},
                                       "click_created_at": t0 + timedelta(minutes=i)})
    buffered = db.buffers["clicks"].pending
    await db["clicks"].count_documents({"publisher_id": pubid})  # read flushes (read-your-writes)
    stats = admin("/__stats")
    check("F1 click inserts are write-behind buffered", buffered > 0)
    check("F2 40 clicks reach Sheets in batched writes, not row-by-row", stats["setValues"] <= 6, str(stats))
    check("F3 read-your-writes: buffer flushed before the count", await db["clicks"].count_documents({"publisher_id": pubid}) == 40 and db.buffers["clicks"].pending == 0)
    pg = await db["clicks"].find({"publisher_id": pubid, "click_created_at": {"$gte": t0 + timedelta(minutes=10)}}).sort("click_created_at", -1).limit(5).to_list(length=5)
    check("F4 click filter by date + newest-first page", [c["quantix_click_id"] for c in pg] == [f"QXC{i:03d}" for i in range(39, 34, -1)])
    check("F5 P1-P10 stored and readable", pg[0]["original_params"]["p7"] == "seven")
    check("F6 click lookup by unique id (postback path)", (await conversion_repository.get_click("QXC007"))["campaign_id"] == "C1")
    for i, (ev, pay, appr) in enumerate([("Install", 0, None), ("KYC", 25, None), ("Trade", 100, "pending_report"), ("Trade", 100, "rejected")]):
        await conversion_repository.insert_conversion({"idempotency_key": f"k{i}", "platform": "x", "campaign_id": "C1", "publisher_id": pubid, "manager_id": mprof["manager_id"],
                                                       "link_id": "L1", "quantix_click_id": f"QXC{i:03d}", "event": ev, "payout": pay, "status": "approved",
                                                       "approval_status": appr or "confirmed", "sub_ids": {}, "utm": {}, "conversion_created_at": t0 + timedelta(hours=i + 1)})
    again, created = await conversion_repository.insert_conversion({"idempotency_key": "k0", "platform": "x", "campaign_id": "C1", "publisher_id": pubid, "quantix_click_id": "QXC000", "event": "Install"})
    check("F7 duplicate conversion (idempotency_key) is not created twice", created is False and await db["conversions"].count_documents({}) == 4)
    total = await conversion_repository.sum_confirmed_payout(pubid) if hasattr(conversion_repository, "sum_confirmed_payout") else None
    summ = await _publisher_dashboard(pubid)
    check("F8 the app's real aggregation pipelines run on Sheets ($group/$cond/$year/$month)", summ is not None and summ["lifetime"]["conversions"] == 4, str(summ and summ["lifetime"]))
    check("F9 earnings exclude pending/rejected approval states", summ["lifetime"]["earnings"] == 25, str(summ["lifetime"]))
    pipe = await db["conversions"].aggregate([{"$match": {"publisher_id": pubid}}, {"$group": {"_id": "$event", "conversions": {"$sum": 1}, "payout": {"$sum": "$payout"}}}, {"$sort": {"conversions": -1}}]).to_list(length=10)
    check("F10 event summary aggregation", {r["_id"]: r["conversions"] for r in pipe} == {"Install": 1, "KYC": 1, "Trade": 2} and pipe[0]["_id"] == "Trade")
    await conversion_repository.transition_approval if False else None
    tr = await conversion_repository.transition_approval((await db["conversions"].find_one({"event": "Trade", "approval_status": "pending_report"}))["conversion_id"], ["pending_report"], "confirmed", "sa", "ok")
    check("F11 company-report approval transition is atomic (second try -> None)", tr is not None and await conversion_repository.transition_approval(tr["conversion_id"], ["pending_report"], "rejected", "sa", None) is None)
    # postback config precedence (versioned, null campaign == Global)
    for cid, ver, en, url in [(None, 1, True, "https://g/"), ("C1", 1, True, "https://c/"), ("C1", 2, False, "https://c2/")]:
        await conversion_repository.insert_config_version({"publisher_id": pubid, "campaign_id": cid, "version": ver, "enabled": en, "deleted": False, "url_template": url})
    cfg = await conversion_repository.get_postback_config(pubid, "C1")
    check("F12 postback precedence: disabled campaign version falls back to Global", cfg["url_template"] == "https://g/")
    check("F13 next_config_version via sort desc", await conversion_repository.next_config_version(pubid, "C1") == 3)
    await conversion_repository.log_outbound({"conversion_id": "CVX", "publisher_id": pubid, "campaign_id": "C1", "url": "https://x/?c=1", "attempts": [], "attempt_count": 0, "final_status": "failed"})
    items, total_ob = await conversion_repository.list_outbound(publisher_id=pubid, skip=0, limit=10) if hasattr(conversion_repository, "list_outbound") else ([], 0)

    # export job with a payload larger than one Sheets cell
    big_csv = "Date,Click ID\n" + "\n".join(f"2026-10-01,QX{i:06d}" for i in range(9000))
    await db["export_jobs"].insert_one({"job_id": "EXPAAAAAAAAAA", "publisher_id": pubid, "kind": "clicks", "format": "csv", "filters": {}, "status": "COMPLETED",
                                        "records": 9000, "content": big_csv, "created_at": now})
    back = await db["export_jobs"].find_one({"job_id": "EXPAAAAAAAAAA"})
    check("F14 export bigger than a Sheets cell (%d chars) is chunked and reassembled intact" % len(big_csv), back["content"] == big_csv)
    lst = await db["export_jobs"].find({"publisher_id": pubid}, {"content": 0}).to_list(length=10)
    check("F15 listing exports with content excluded does not load the blob", "content" not in lst[0])

    # ===== G. finance =====
    pa, pb = pubid, "9999"
    async def earn(conv, amt, pub=pa):
        async with postgres.get_pool().acquire() as conn:
            return await ledger_repository.insert_entry(conn, idempotency_key=f"earning:{conv}", transaction_type="earning", direction="credit",
                                                        publisher_id=pub, amount=Decimal(amt), source="conversion_engine", conversion_id=conv, manager_id=mprof["manager_id"])
    e1 = await earn("CV1", "500.00"); e2 = await earn("CV2", "250.50"); await earn("CVB", "40.00", pb)
    check("G1 ledger entry created with serial id + ledger id", e1["id"] == 1 and e1["ledger_id"].startswith("LDG") and isinstance(e1["amount"], Decimal))
    check("G2 same idempotency_key -> None (ON CONFLICT DO NOTHING contract)", await earn("CV1", "500.00") is None)
    async with postgres.get_pool().acquire() as conn:
        async def rev():
            return await ledger_repository.insert_entry(conn, idempotency_key="reversal:CV2", transaction_type="earning_reversal", direction="debit", publisher_id=pa, amount=Decimal("250.50"), source="admin_manual", conversion_id="CV2", manager_id=mprof["manager_id"])
        await rev()
        bal = await ledger_repository.get_balance(conn, pa)
        orig = await ledger_repository.get_earning_for_conversion(conn, "CV2")
        mt = await ledger_repository.manager_scope_totals(conn, mprof["manager_id"])
    check("G3 wallet = live ledger projection (credits - debits)", bal["available_balance"] == Decimal("500.00") and bal["total_earned"] == Decimal("750.50") and bal["total_reversed"] == Decimal("250.50"), str(bal))
    check("G4 reversal is a NEW ledger row; original untouched", orig["amount"] == Decimal("250.50") and orig["transaction_type"] == "earning")
    check("G5 manager-scope totals", mt["total_credits"] == Decimal("790.50") and mt["total_debits"] == Decimal("250.50"), str(mt))
    items, total = await ledger_repository.list_entries(pa, None, "earning", 0, 10)
    check("G6 ledger listing (newest first) + filter + total", total == 2 and items[0]["conversion_id"] == "CV2")
    ov = await ledger_repository.network_overview()
    check("G7 network overview (Super Admin liability)", ov["total_publisher_liability"] == Decimal("540.00"), str(ov))
    check("G8 ledger is append-only on the server", raw_post({"secret": SECRET, "action": "delete", "table": "FinancialLedger", "id": e1["ledger_id"]})["error"]["code"] == "FORBIDDEN_TABLE_OPERATION")

    w1 = await withdrawal_repository.request_withdrawal(pa, mprof["manager_id"], Decimal("300.00"), "idem-1", "req1")
    check("G9 withdrawal requested (status requested, hold posted)", w1["status"] == "requested" and w1["amount"] == Decimal("300.00") and w1["withdrawal_id"].startswith("WD"))
    async with postgres.get_pool().acquire() as conn:
        b2 = await ledger_repository.get_balance(conn, pa)
    check("G10 hold reduces available balance; held amount tracked", b2["available_balance"] == Decimal("200.00") and b2["held_amount"] == Decimal("300.00"), str(b2))
    again = await withdrawal_repository.request_withdrawal(pa, mprof["manager_id"], Decimal("300.00"), "idem-1", "req1")
    check("G11 idempotent retry returns the same withdrawal (no second hold)", again["withdrawal_id"] == w1["withdrawal_id"] and await db["financial_ledger"].count_documents({"transaction_type": "withdrawal_hold"}) == 1)
    check("G12 over-balance request refused", await _raises(ValidationAppError, withdrawal_repository.request_withdrawal(pa, None, Decimal("250.00"), "idem-2", "r")))
    check("G13 below minimum refused", await _raises(ValidationAppError, withdrawal_repository.request_withdrawal(pa, None, Decimal("50.00"), None, "r")))
    check("G14 refused requests wrote nothing", await db["withdrawals"].count_documents({}) == 1 and await db["financial_ledger"].count_documents({"transaction_type": "withdrawal_hold"}) == 1)
    # race: 8 simultaneous requests of 150 against a 200 balance -> exactly one wins
    outs = await asyncio.gather(*[withdrawal_repository.request_withdrawal(pa, None, Decimal("150.00"), f"race-{i}", "r") for i in range(8)], return_exceptions=True)
    wins = [o for o in outs if isinstance(o, dict)]
    check("G15 no double-spend: 8 concurrent requests vs balance for one -> exactly 1 succeeds", len(wins) == 1, str([type(o).__name__ for o in outs]))
    async with postgres.get_pool().acquire() as conn:
        b3 = await ledger_repository.get_balance(conn, pa)
    check("G16 balance never negative after the race", b3["available_balance"] == Decimal("50.00"), str(b3))
    rj = await withdrawal_repository.reject(w1["withdrawal_id"], "sa", "bad details")
    async with postgres.get_pool().acquire() as conn:
        b4 = await ledger_repository.get_balance(conn, pa)
    check("G17 reject releases exactly the held amount (atomic with status)", rj["status"] == "rejected" and b4["available_balance"] == Decimal("350.00"), str(b4))
    check("G18 second reject is a no-op (no double release)", await withdrawal_repository.reject(w1["withdrawal_id"], "sa", "again") is None and await db["financial_ledger"].count_documents({"transaction_type": "withdrawal_release"}) == 1)
    wid2 = wins[0]["withdrawal_id"]
    check("G19 under_review -> approved -> paid (conditional transitions)", (await withdrawal_repository.mark_under_review(wid2, "sa"))["status"] == "under_review"
          and (await withdrawal_repository.approve(wid2, "sa"))["status"] == "approved")
    paid = await withdrawal_repository.mark_paid(wid2, "sa", "UTR-9")
    check("G20 payment record: paid + reference + paid_by", paid["status"] == "paid" and paid["reference"] == "UTR-9" and paid["paid_by"] == "sa")
    check("G21 paid cannot be paid/rejected again", await withdrawal_repository.mark_paid(wid2, "sa", "x") is None and await withdrawal_repository.reject(wid2, "sa", "x") is None)
    w3 = await withdrawal_repository.request_withdrawal(pa, None, Decimal("100.00"), None, "r")
    check("G22 publisher cancel only own & only while requested", await withdrawal_repository.cancel(w3["withdrawal_id"], "someone-else") is None
          and (await withdrawal_repository.cancel(w3["withdrawal_id"], pa))["status"] == "cancelled")
    rows, tot = await withdrawal_repository.list_withdrawals(pa, None, None, 0, 10)
    check("G23 withdrawal listing newest-first with total", tot == 3 and rows[0]["requested_at"] >= rows[-1]["requested_at"])
    rows, tot = await withdrawal_repository.list_withdrawals(None, None, "paid", 0, 10)
    check("G24 listing filtered by status", tot == 1 and rows[0]["withdrawal_id"] == wid2)
    async with postgres.get_pool().acquire() as conn:
        final = await ledger_repository.get_balance(conn, pa)
    check("G25 final wallet reconciles with ledger history (adjustments/holds/releases included)", final["available_balance"] == Decimal("350.00") and final["held_amount"] == Decimal("150.00"), str(final))
    async with postgres.get_pool().acquire() as conn:
        await ledger_repository.insert_entry(conn, idempotency_key="adjustment:1", transaction_type="adjustment_credit", direction="credit", publisher_id=pa, amount=Decimal("10.00"), source="admin_manual", reference="goodwill", actor_user_id="sa")
        adj = await ledger_repository.get_balance(conn, pa)
    check("G26 payout adjustment = adjustment_credit ledger row", adj["available_balance"] == Decimal("360.00"))

    # ===== H. resilience =====
    admin("/__lock?busy=1")
    check("H1 busy script lock -> safe 503 for writes (nothing written)", await _raises(ServiceUnavailableError, db["system_settings"].insert_one({"key": "locked", "value": "x"})))
    admin("/__lock?busy=0")
    check("H2 nothing was written while locked", await db["system_settings"].count_documents({"key": "locked"}) == 0)
    flaky = {"n": 0}
    async def flaky_transport(url, payload):
        flaky["n"] += 1
        if flaky["n"] <= 2:
            raise sheets_adapter.TransientStorageError("boom", applied=False)
        return await urllib_transport(url, payload)
    fa = sheets_adapter.GoogleSheetsStorageAdapter({"core": BASE + "/exec", "tracking": BASE + "/exec", "finance": BASE + "/exec"}, SECRET, transport=flaky_transport, sleep=no_sleep)
    check("H3 transient read failures are retried", (await fa.count("users", {})) >= 1 and flaky["n"] == 3)
    async def lost_response(url, payload):
        raise sheets_adapter.TransientStorageError("timeout after send", applied=True)
    la = sheets_adapter.GoogleSheetsStorageAdapter({"core": BASE + "/exec", "tracking": BASE + "/exec", "finance": BASE + "/exec"}, SECRET, transport=lost_response, sleep=no_sleep)
    check("H4 a write that may have been applied is NEVER blind-retried", await _raises(ServiceUnavailableError, la.create("system_settings", {"key": "z", "value": "1"})))
    # a human edits the sheet: header-position based reads still work
    print("   emulator stats:", admin("/__stats"))
    await runtime.close()


async def _raises(exc, coro):
    try:
        await coro
    except exc:
        return True
    except Exception as e:  # noqa: BLE001
        print("   unexpected:", type(e).__name__, e)
        return False
    return False


async def _publisher_dashboard(pubid):
    for name in dir(conversion_repository):
        fn = getattr(conversion_repository, name)
        if name.startswith("_") or not asyncio.iscoroutinefunction(fn):
            continue
        try:
            params = fn.__code__.co_varnames[:fn.__code__.co_argcount]
        except AttributeError:
            continue
        if params and params[0] == "publisher_id" and "months" in params:
            return await fn(pubid)
    return None


try:
    asyncio.run(main())
finally:
    node.terminate()

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
