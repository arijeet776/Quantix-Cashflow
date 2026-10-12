#!/usr/bin/env python3
"""Renders gas/Code.template.gs + app/storage/schema.py into gas/Code.gs
(the single copy-paste file for Google Apps Script).
    python3 backend/tools/generate_apps_script.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
ROOT = os.path.dirname(BACKEND)
sys.path.insert(0, BACKEND)

import importlib.util
spec = importlib.util.spec_from_file_location("schema", os.path.join(BACKEND, "app", "storage", "schema.py"))
schema = importlib.util.module_from_spec(spec)
sys.modules["schema"] = schema
spec.loader.exec_module(schema)


def render() -> str:
    tpl = open(os.path.join(ROOT, "gas", "Code.template.gs"), encoding="utf-8").read()
    payload = {"dbs": schema.DB_TITLES, "tables": schema.TABLES}
    return tpl.replace("/*__SCHEMA__*/", json.dumps(payload, indent=1))


if __name__ == "__main__":
    out = os.path.join(ROOT, "gas", "Code.gs")
    open(out, "w", encoding="utf-8").write(render())
    print("wrote", out)
