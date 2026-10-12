"""
Part 19 - Google Sheets PRODUCTION-MODE verification (config guards, startup wiring,
health readiness, dependency coverage).

Runs against the REAL source of app/config.py, app/db/mongodb.py, app/db/postgres.py,
app/db/migrations.py, app/storage/runtime.py and the REAL `lifespan` / `readiness`
functions extracted from app/main.py and app/api/v1/endpoints/health.py (via ast).
Only third-party packages that are not installable offline are replaced:
  * pydantic_settings.BaseSettings -> tiny env-reading shim over real pydantic
  * motor / asyncpg                -> TRAPS that record any connection attempt
No secrets are used: every secret-like value is generated at run time, in memory.
"""
import ast
import asyncio
import importlib.util
import os
import secrets
import sys
import types
from contextlib import asynccontextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' - ' + detail) if detail and not ok else ''}")


def mod(name, **attrs):
    m = types.ModuleType(name)
    m.__dict__.update(attrs)
    sys.modules[name] = m
    return m


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


# ---- pydantic_settings shim (env -> kwargs, so model_fields_set behaves like the real one)
from pydantic import BaseModel, ConfigDict  # noqa: E402


class BaseSettings(BaseModel):
    def __init__(self, **kw):
        for fname, f in type(self).model_fields.items():
            if fname in kw:
                continue
            names = [fname.upper()]
            alias = f.validation_alias
            if alias is not None and hasattr(alias, "choices"):
                names = [str(c).upper() for c in alias.choices]
            for n in names:
                if n in os.environ:
                    kw[n if alias is not None else fname] = os.environ[n]
                    break
        super().__init__(**kw)


mod("pydantic_settings", BaseSettings=BaseSettings, SettingsConfigDict=lambda **k: ConfigDict(extra="ignore"))

# ---- connection TRAPS
calls = {"mongo": 0, "pg": 0}


class TrapMongoClient:
    def __init__(self, *a, **k):
        calls["mongo"] += 1  # real Motor connects lazily; the failure shows up on first command
        outer = self

        class _Admin:
            async def command(self, *a, **k):
                raise RuntimeError("MongoDB unreachable (trap)")
        self.admin = _Admin()

    def __getitem__(self, name):
        return object()

    def close(self):
        pass


async def trap_create_pool(*a, **k):
    calls["pg"] += 1
    raise RuntimeError("PostgreSQL connection attempted")


mod("motor"); mod("motor.motor_asyncio", AsyncIOMotorClient=TrapMongoClient, AsyncIOMotorDatabase=object)
mod("asyncpg", create_pool=trap_create_pool, Pool=object)
mod("app"); mod("app.db"); mod("app.storage")
config = load("app.config", "app/config.py")
sys.modules["app"].config = config
SCOPE = ("STORAGE_BACKEND", "GOOGLE_SHEETS_CORE_API_URL", "GOOGLE_SHEETS_TRACKING_API_URL", "GOOGLE_SHEETS_FINANCE_API_URL",
         "GOOGLE_SHEETS_API_SECRET", "JWT_SECRET_KEY", "ALLOWED_ORIGINS", "ENVIRONMENT", "MONGO_URI", "MONGO_DB_NAME", "POSTGRES_DSN")


def env(**kw):
    for k in SCOPE:
        os.environ.pop(k, None)
    for k, v in kw.items():
        if v is not None:
            os.environ[k] = v
    config.get_settings.cache_clear()


def rand(n=48):
    return secrets.token_urlsafe(n)[:n]


URL = "https://script.google.com/macros/s/" + rand(30) + "/exec"
GOOD = dict(ENVIRONMENT="production", STORAGE_BACKEND="google_sheets", GOOGLE_SHEETS_CORE_API_URL=URL,
            GOOGLE_SHEETS_TRACKING_API_URL=URL, GOOGLE_SHEETS_FINANCE_API_URL=URL, GOOGLE_SHEETS_API_SECRET=rand(),
            JWT_SECRET_KEY=rand(), ALLOWED_ORIGINS="https://app.example-site.net")


def fails(**over):
    cfg = {**GOOD, **over}
    env(**cfg)
    try:
        config.Settings()
    except Exception as exc:  # noqa: BLE001
        return type(exc).__name__ + ": " + str(exc)[:160]
    return None


def loads(**over):
    env(**{**GOOD, **over})
    try:
        return config.Settings()
    except Exception as exc:  # noqa: BLE001
        print("   unexpected:", str(exc)[:200])
        return None


# ===== 1. configuration matrix =====
s = loads()
check("C1 production + google_sheets starts with ONLY the 3 URLs, API secret, JWT secret, ALLOWED_ORIGINS (no Mongo/Postgres vars)",
      s is not None and s.storage_backend == "google_sheets" and s.is_production and s.allowed_origins_list == ["https://app.example-site.net"])
check("C2 same URL for all three is accepted (single deployment)", s is not None)
for var in ("GOOGLE_SHEETS_CORE_API_URL", "GOOGLE_SHEETS_TRACKING_API_URL", "GOOGLE_SHEETS_FINANCE_API_URL"):
    check(f"C3 missing {var} refuses to start", fails(**{var: None}) is not None)
check("C4 http:// (non-TLS) Apps Script URL refused", fails(GOOGLE_SHEETS_CORE_API_URL="http://script.google.com/x") is not None)
check("C5 missing API secret refused", fails(GOOGLE_SHEETS_API_SECRET=None) is not None)
check("C6 short API secret (<32) refused", fails(GOOGLE_SHEETS_API_SECRET="a" * 31) is not None)
check("C7 placeholder-looking API secret refused", fails(GOOGLE_SHEETS_API_SECRET="your-secret-" + "x" * 30) is not None)
check("C8 missing JWT secret refused", fails(JWT_SECRET_KEY=None) is not None)
check("C9 short JWT secret refused in production", fails(JWT_SECRET_KEY="a" * 20) is not None)
check("C10 placeholder JWT secret refused in production", fails(JWT_SECRET_KEY="change-me-" + "x" * 40) is not None)
check("C11 wildcard ALLOWED_ORIGINS refused in production", fails(ALLOWED_ORIGINS="*") is not None)
check("C12 comma-separated origins parsed", (loads(ALLOWED_ORIGINS="https://a.example.org, https://b.example.org") or types.SimpleNamespace(allowed_origins_list=[])).allowed_origins_list == ["https://a.example.org", "https://b.example.org"])
check("C13 invalid STORAGE_BACKEND refused", fails(STORAGE_BACKEND="mongo") is not None)
# existing guards preserved for the real stack
real = {k: v for k, v in GOOD.items() if not k.startswith("GOOGLE_SHEETS")}
real["STORAGE_BACKEND"] = "mongodb_supabase"
env(**real)
try:
    config.Settings(); r1 = None
except Exception as exc:  # noqa: BLE001
    r1 = str(exc)
check("C14 mongodb_supabase production still requires MONGO_URI/MONGO_DB_NAME/POSTGRES_DSN explicitly", r1 is not None and "must be set explicitly" in r1)
env(**real, MONGO_URI="mongodb://m.example.org/x", MONGO_DB_NAME="q", POSTGRES_DSN="postgresql://u:p@db.example.org/q")
try:
    config.Settings(); r2 = True
except Exception as exc:  # noqa: BLE001
    r2 = False
check("C15 mongodb_supabase production accepted when fully configured", r2)
env(JWT_SECRET_KEY="dev-only-" + rand(10))
d = config.Settings()
check("C16 development defaults unchanged (mongodb_supabase, no sheets vars needed)", d.storage_backend == "mongodb_supabase" and not d.is_production)

# ===== 2. real startup wiring (lifespan extracted from app/main.py) =====
env(**GOOD)
runtime = load("app.storage.runtime", "app/storage/runtime.py")
sys.modules["app.storage"].runtime = runtime


class FakeAdapter:
    def __init__(self, up=True):
        self.up, self.pings, self.closed = up, 0, False
        self._transport = self

    async def ping(self):
        self.pings += 1
        return self.up

    async def aclose(self):
        self.closed = True


mongodb = load("app.db.mongodb", "app/db/mongodb.py")
postgres = load("app.db.postgres", "app/db/postgres.py")
sys.modules["app.db"].mongodb = mongodb
sys.modules["app.db"].postgres = postgres
migrations = load("app.db.migrations", "app/db/migrations.py")
sys.modules["app.db"].migrations = migrations


def extract(rel, fname, ns):
    tree = ast.parse((ROOT / rel).read_text())
    fn = next(n for n in ast.walk(tree) if isinstance(n, (ast.AsyncFunctionDef, ast.FunctionDef)) and n.name == fname)
    fn.decorator_list = [d for d in fn.decorator_list if not (isinstance(d, ast.Call) and getattr(d.func, 'value', None) and getattr(d.func.value, 'id', '') == 'router')]
    mod_ast = ast.Module(body=[fn], type_ignores=[])
    exec(compile(ast.fix_missing_locations(mod_ast), rel, "exec"), ns)
    return ns[fname]


import logging  # noqa: E402

lifespan_ns = {"asynccontextmanager": asynccontextmanager, "logger": logging.getLogger("t"), "FastAPI": object,
               "connect_to_mongo": mongodb.connect_to_mongo, "connect_to_postgres": postgres.connect_to_postgres,
               "ping_postgres": postgres.ping_postgres, "close_mongo_connection": mongodb.close_mongo_connection,
               "close_postgres_connection": postgres.close_postgres_connection,
               "settings": config.get_settings()}
lifespan = extract("app/main.py", "lifespan", lifespan_ns)


async def run_lifespan(app_up=True):
    fake = FakeAdapter(app_up)
    runtime._adapter = fake
    calls.update(mongo=0, pg=0)
    started = False
    async with lifespan(object()):
        started = True
    return started, fake


async def main_async():
    # lifespan with Apps Script reachable
    started, fake = await run_lifespan(True)
    check("L1 lifespan completes in google_sheets production mode", started)
    check("L2 NO MongoDB connection attempted at startup", calls["mongo"] == 0)
    check("L3 NO PostgreSQL connection attempted at startup", calls["pg"] == 0)
    check("L4 startup pinged the Apps Script API and shutdown closed the adapter", fake.pings >= 1 and fake.closed)
    # Apps Script temporarily down: app must still boot (readiness reports it)
    started, fake = await run_lifespan(False)
    check("L5 app still boots when Apps Script is temporarily unreachable (no crash)", started and calls["mongo"] == 0 and calls["pg"] == 0)
    check("L6 migrations are a no-op in sheets mode", await migrations.run_migrations() == [])

    # readiness endpoint (real function body)
    health_ns = {"get_settings": config.get_settings, "ping_mongo": mongodb.ping_mongo, "ping_postgres": postgres.ping_postgres,
                 "retry_indexes_if_needed": mongodb.retry_indexes_if_needed, "migrations": migrations,
                 "Response": object, "status": types.SimpleNamespace(HTTP_200_OK=200, HTTP_503_SERVICE_UNAVAILABLE=503)}
    ready = extract("app/api/v1/endpoints/health.py", "readiness", health_ns)
    runtime._adapter = FakeAdapter(True)
    migrations.status = "pending"; migrations._last_attempt = 0.0  # cold start: Apps Script was down at boot
    resp = types.SimpleNamespace(status_code=None)
    body = await ready(resp)
    check("H1 /health/ready recovers to 200 'ready' after a cold start once Apps Script is up", resp.status_code == 200 and body["status"] == "ready", str(body))
    runtime._adapter = FakeAdapter(False)
    resp = types.SimpleNamespace(status_code=None)
    body = await ready(resp)
    check("H2 /health/ready is 503 'not_ready' when Apps Script is unreachable", resp.status_code == 503 and body["status"] == "not_ready", str(body))
    check("H3 still no Mongo/Postgres connection attempted by health probes", calls["mongo"] == 0 and calls["pg"] == 0)

    # switching back restores the real stack's connection attempts
    env(**real, MONGO_URI="mongodb://m.example.org/x", MONGO_DB_NAME="q", POSTGRES_DSN="postgresql://u:p@db.example.org/q")
    runtime._adapter = None
    calls.update(mongo=0, pg=0)
    lifespan_ns["settings"] = config.get_settings()
    try:
        await run_lifespan_real()
    except Exception:  # noqa: BLE001
        pass
    check("L7 mongodb_supabase mode still attempts MongoDB and PostgreSQL (not disabled)", calls["mongo"] >= 1 and calls["pg"] >= 1, str(calls))


async def run_lifespan_real():
    async with lifespan(object()):
        pass


asyncio.run(main_async())

# ===== 3. requirements.txt covers every third-party import in app/ =====
req = {}
for line in (ROOT / "requirements.txt").read_text().splitlines():
    line = line.split("#")[0].strip()
    if line:
        req[line.split("==")[0].split("[")[0].lower().replace("_", "-")] = line
MODULE_TO_DIST = {"fastapi": "fastapi", "pydantic": "pydantic", "pydantic_settings": "pydantic-settings", "motor": "motor", "pymongo": "pymongo",
                  "bson": "pymongo", "asyncpg": "asyncpg", "jose": "python-jose", "passlib": "passlib", "bcrypt": "bcrypt", "httpx": "httpx",
                  "email_validator": "email-validator", "multipart": "python-multipart", "dotenv": "python-dotenv", "uvicorn": "uvicorn",
                  "starlette": "fastapi"}
used = set()
for p in (ROOT / "app").rglob("*.py"):
    for n in ast.walk(ast.parse(p.read_text())):
        if isinstance(n, ast.Import):
            used.update(a.name.split(".")[0] for a in n.names)
        elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module:
            used.add(n.module.split(".")[0])
third = sorted(m for m in used if m not in sys.stdlib_module_names and m != "app")
unmapped = [m for m in third if m not in MODULE_TO_DIST]
missing = [m for m in third if m in MODULE_TO_DIST and MODULE_TO_DIST[m] not in req]
check("R1 every third-party import in app/ maps to a pinned requirement", not unmapped and not missing, f"unmapped={unmapped} missing={missing}")
check("R2 uvicorn[standard] and fastapi are pinned (server can start)", "uvicorn" in req and "fastapi" in req and "[standard]" in req["uvicorn"])
check("R3 httpx (used by the Sheets transport) is pinned", "httpx" in req)
dock = (ROOT / "Dockerfile").read_text()
check("R4 Dockerfile starts uvicorn app.main:app and installs requirements.txt", "app.main:app" in dock and "requirements.txt" in dock)

passed = sum(results)
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
