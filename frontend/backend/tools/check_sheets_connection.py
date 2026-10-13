#!/usr/bin/env python3
"""
Live connectivity check for the deployed Apps Script web app (stdlib only).

Reads the SAME private environment variables the backend uses:
    GOOGLE_SHEETS_CORE_API_URL  GOOGLE_SHEETS_TRACKING_API_URL  GOOGLE_SHEETS_FINANCE_API_URL
    GOOGLE_SHEETS_API_SECRET
The secret is never printed or logged.

Checks: (1) ping + auth, (2) wrong secret is refused, (3) safe read of every
spreadsheet, (4) controlled write -> read-back -> delete of ONE clearly marked
record in the Settings tab (key "__quantix_connection_test__<time>").
It never touches conversions, ledger, wallet or withdrawals (only count/read).

Usage:  python3 backend/tools/check_sheets_connection.py
Exit code 0 = all PASS, 1 = a FAIL, 2 = BLOCKED (configuration missing).
"""
import json
import os
import sys
import time
import urllib.request

URLS = {
    "core": os.environ.get("GOOGLE_SHEETS_CORE_API_URL", ""),
    "tracking": os.environ.get("GOOGLE_SHEETS_TRACKING_API_URL", ""),
    "finance": os.environ.get("GOOGLE_SHEETS_FINANCE_API_URL", ""),
}
SECRET = os.environ.get("GOOGLE_SHEETS_API_SECRET", "")
FAILED = []


def call(url, body, secret=None):
    payload = json.dumps({"secret": SECRET if secret is None else secret, **body}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "text/plain;charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:  # follows the script.googleusercontent.com redirect
        return json.loads(r.read().decode())


def report(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' - ' + detail) if detail else ''}")
    if not ok:
        FAILED.append(name)


def main():
    missing = [k for k, v in URLS.items() if not v] + ([] if SECRET else ["secret"])
    if missing:
        print(f"[BLOCKED] configuration not set in this environment: {', '.join(missing)}")
        return 2
    if len(SECRET) < 32:
        print("[BLOCKED] API secret is shorter than 32 characters (the backend would refuse it)")
        return 2
    core = URLS["core"]
    try:
        r = call(core, {"action": "ping"})
        report("S1 ping with the configured secret", bool(r.get("success")), "" if r.get("success") else str((r.get("error") or {}).get("code")))
        r = call(core, {"action": "ping"}, secret="x" * 40)
        report("S2 wrong secret is refused", (not r.get("success")) and (r.get("error") or {}).get("code") == "UNAUTHORIZED")
        for db, tab in (("core", "Users"), ("tracking", "Clicks"), ("finance", "FinancialLedger")):
            r = call(URLS[db], {"action": "count", "table": tab, "filters": {}})
            report(f"S3 safe read ({db}/{tab} count)", bool(r.get("success")), "" if r.get("success") else str((r.get("error") or {}).get("code")))
        key = f"__quantix_connection_test__{int(time.time())}"
        r = call(core, {"action": "create", "table": "Settings", "data": {"key": key, "value": "connection-test", "updated_by": "check_sheets_connection"}})
        report("S4 controlled write (test record in Settings)", bool(r.get("success")))
        if r.get("success"):
            r = call(core, {"action": "find_one", "table": "Settings", "filters": {"key": key}})
            report("S5 read-back of the test record", bool(r.get("success")) and (r.get("data") or {}).get("value") == "connection-test")
            r = call(core, {"action": "delete", "table": "Settings", "filters": {"key": key}})
            report("S6 test record removed", bool(r.get("success")))
            r = call(core, {"action": "count", "table": "Settings", "filters": {"key": key}})
            report("S7 no test record left behind", bool(r.get("success")) and (r.get("data") or {}).get("count") == 0)
    except Exception as exc:  # noqa: BLE001 - never include request bodies (they carry the secret)
        report("connection", False, type(exc).__name__)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
