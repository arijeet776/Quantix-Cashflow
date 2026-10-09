"""
GoogleSheetsStorageAdapter - talks to the Quantix Google Apps Script web app.

Security
* The API secret is sent ONLY in the POST body (Apps Script cannot read request
  headers) over HTTPS, is never logged, never returned and never put in a URL.
* Only tables declared in storage/schema.py can be addressed; the Apps Script
  enforces the same whitelist independently.

Reliability
* Reads are retried on transient failures (network, Apps Script HTML error page,
  quota, SERVER_BUSY) with backoff.
* Writes are retried ONLY when the server provably did not apply them
  (SERVER_BUSY, or a connection that failed before the request was sent), so a
  retry can never double-apply a write.
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from typing import Any, Awaitable, Callable

from pymongo.errors import DuplicateKeyError, PyMongoError

from app.core.exceptions import ServiceUnavailableError, ValidationAppError
from app.storage import codec
from app.storage.interface import StorageAdapter
from app.storage.schema import DB_TITLES

logger = logging.getLogger(__name__)

PAGE = 1000                    # Apps Script MAX_LIMIT
MAX_CELL_CHARS = 45000         # leave head-room under the 50,000-char cell limit
BLOB_PREFIX = "@blob:"
_BLOB_CHUNK = 40000
_RETRY_DELAYS = (0.4, 1.2, 3.0)

Transport = Callable[[str, dict], Awaitable[dict]]


class TransientStorageError(Exception):
    """Network / Apps Script infrastructure problem; `applied` says whether the
    request may have been executed server-side."""

    def __init__(self, message: str, applied: bool):
        super().__init__(message)
        self.applied = applied


class SheetsApiError(Exception):
    def __init__(self, code: str, message: str, payload: dict | None = None):
        super().__init__(message)
        self.code = code
        self.payload = payload or {}


class HttpTransport:
    """httpx-based transport. Follows Apps Script's 302 hop to script.googleusercontent.com."""

    def __init__(self, timeout: float = 30.0):
        self._timeout = timeout
        self._client = None

    def _get_client(self):
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient(timeout=self._timeout, follow_redirects=True)
        return self._client

    async def __call__(self, url: str, payload: dict) -> dict:
        import httpx

        client = self._get_client()
        try:
            resp = await client.post(url, content=json.dumps(payload), headers={"Content-Type": "text/plain;charset=utf-8"})
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise TransientStorageError("connection failed", applied=False) from exc
        except httpx.HTTPError as exc:
            raise TransientStorageError("request failed", applied=True) from exc
        if resp.status_code >= 500 or resp.status_code == 429:
            raise TransientStorageError(f"upstream status {resp.status_code}", applied=True)
        try:
            return resp.json()
        except ValueError as exc:  # Apps Script answers quota/permission problems with an HTML page
            raise TransientStorageError("non-JSON response from the Apps Script API", applied=True) from exc

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


class GoogleSheetsStorageAdapter(StorageAdapter):
    def __init__(self, urls: dict[str, str], secret: str, transport: Transport | None = None,
                 timeout: float = 30.0, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep):
        missing = [db for db in DB_TITLES if not urls.get(db)]
        if missing:
            raise ValueError(f"Missing Google Sheets API URL for: {', '.join(missing)}")
        if not secret:
            raise ValueError("Google Sheets API secret is not configured")
        self._urls = urls
        self._secret = secret
        self._transport: Transport = transport or HttpTransport(timeout)
        self._sleep = sleep

    def __repr__(self) -> str:  # never expose the secret
        return "<GoogleSheetsStorageAdapter>"

    # -------------------------------------------------------------- plumbing --

    def _url(self, table: dict) -> str:
        return self._urls[table["db"]]

    async def _call(self, url: str, body: dict, *, write: bool) -> dict:
        payload = {"secret": self._secret, **body}
        last: Exception | None = None
        for attempt in range(len(_RETRY_DELAYS) + 1):
            try:
                result = await self._transport(url, payload)
            except TransientStorageError as exc:
                last = exc
                if write and exc.applied:
                    # may have been applied: never blind-retry a write
                    raise ServiceUnavailableError("Storage temporarily unavailable") from exc
            else:
                if isinstance(result, dict) and result.get("success") is False:
                    err = result.get("error") or {}
                    if err.get("code") == "SERVER_BUSY":
                        last = SheetsApiError("SERVER_BUSY", "busy")
                    else:
                        return result
                else:
                    return result
            if attempt < len(_RETRY_DELAYS):
                await self._sleep(_RETRY_DELAYS[attempt])
        logger.warning("Google Sheets API unavailable after retries (%s)", type(last).__name__)
        raise ServiceUnavailableError("Storage temporarily unavailable")

    def _raise(self, result: dict) -> None:
        err = (result or {}).get("error") or {}
        code, message = err.get("code", "ERROR"), err.get("message", "Storage error")
        if code == "DUPLICATE_KEY":
            raise DuplicateKeyError(message)
        if code in ("VALIDATION_ERROR", "VALUE_TOO_LONG", "INSUFFICIENT_BALANCE", "FORBIDDEN_TABLE_OPERATION"):
            raise SheetsApiError(code, message, err)
        if code in ("UNAUTHORIZED", "NOT_CONFIGURED", "INVALID_TABLE", "INVALID_ACTION", "SCHEMA_CONFLICT"):
            logger.error("Google Sheets API refused the request: %s", code)
            raise ServiceUnavailableError("Storage is not configured correctly")
        if code == "SERVER_BUSY":
            raise ServiceUnavailableError("Storage is busy, please retry")
        raise SheetsApiError(code, message, err)

    async def _ok(self, table: dict, body: dict, *, write: bool) -> dict:
        result = await self._call(self._url(table), {"table": table["tab"], **body}, write=write)
        if not result.get("success"):
            self._raise(result)
        return result

    # ----------------------------------------------------------- large values --

    async def _spill(self, table: dict, doc: dict) -> dict:
        """Strings that exceed one Sheets cell are stored as chunks in the
        internal _blobs table; the cell keeps a reference."""
        out = doc
        for k, v in doc.items():
            if isinstance(v, str) and len(v) > MAX_CELL_CHARS and codec.col_types(table).get(k) == "s":
                blob_id = "BLB" + secrets.token_hex(8)
                now = codec.to_iso(__import__("datetime").datetime.now(__import__("datetime").timezone.utc))
                chunks = [v[i:i + _BLOB_CHUNK] for i in range(0, len(v), _BLOB_CHUNK)]
                blob_table = codec.table_def("_blobs")
                for off in range(0, len(chunks), 100):
                    rows = [{"blob_id": blob_id, "seq": off + n, "data": c, "created_at": now} for n, c in enumerate(chunks[off:off + 100])]
                    await self._ok(blob_table, {"action": "create", "rows": rows}, write=True)
                out = dict(out)
                out[k] = f"{BLOB_PREFIX}{blob_id}:{len(chunks)}"
        return out

    async def _resolve_blobs(self, docs: list[dict]) -> list[dict]:
        blob_table = codec.table_def("_blobs")
        for d in docs:
            for k, v in list(d.items()):
                if isinstance(v, str) and v.startswith(BLOB_PREFIX):
                    try:
                        _, blob_id, count = v.split(":")
                        res = await self._ok(blob_table, {"action": "query", "filters": {"blob_id": blob_id},
                                                          "sort": {"seq": 1}, "limit": PAGE}, write=False)
                        parts = sorted(res["data"], key=lambda r: r["seq"])
                        if len(parts) == int(count):
                            d[k] = "".join(p["data"] for p in parts)
                    except (ValueError, KeyError):
                        pass
        return docs

    def _decode(self, table: dict, docs: list[dict]) -> list[dict]:
        return [codec.decode_doc(table, d) for d in docs]

    # ----------------------------------------------------------------- reads --

    async def ping(self) -> bool:
        try:
            result = await self._call(self._urls["core"], {"action": "ping"}, write=False)
            return bool(result.get("success"))
        except Exception:  # noqa: BLE001 - health probes must never raise
            return False

    async def initialize(self) -> dict:
        res = await self._call(self._urls["core"], {"action": "initialize"}, write=True)
        if not res.get("success"):
            self._raise(res)
        return res["data"]

    async def get(self, table, id, projection=None):
        t = codec.table_def(table)
        res = await self._ok(t, {"action": "get", "id": str(id), **({"projection": projection} if projection else {})}, write=False)
        if res["data"] is None:
            return None
        doc = (await self._resolve_blobs([codec.decode_doc(t, res["data"])]))[0]
        return doc

    async def find_one(self, table, filters=None, sort=None, projection=None):
        t = codec.table_def(table)
        body = {"action": "find_one", "filters": codec.encode_filter(t, filters)}
        if sort:
            body["sort"] = codec.encode_sort(sort)
        if projection:
            body["projection"] = projection
        res = await self._ok(t, body, write=False)
        if res["data"] is None:
            return None
        return (await self._resolve_blobs([codec.decode_doc(t, res["data"])]))[0]

    async def query(self, table, filters=None, sort=None, skip=0, limit=100, projection=None):
        t = codec.table_def(table)
        flt = codec.encode_filter(t, filters)
        srt = codec.encode_sort(sort)
        out: list[dict] = []
        total = 0
        want = limit if limit and limit > 0 else None
        cur = skip
        while True:
            page = PAGE if want is None else min(PAGE, want - len(out))
            if page <= 0:
                break
            body = {"action": "query", "filters": flt, "skip": cur, "limit": page}
            if srt:
                body["sort"] = srt
            if projection:
                body["projection"] = projection
            res = await self._ok(t, body, write=False)
            total = res["pagination"]["total"]
            out.extend(res["data"])
            cur += len(res["data"])
            if len(res["data"]) < page or cur >= total:
                break
        docs = await self._resolve_blobs(self._decode(t, out))
        return docs, total

    async def list(self, table, filters=None, page=1, limit=100):
        docs, total = await self.query(table, filters, None, (page - 1) * limit, limit)
        return docs, {"page": page, "limit": limit, "total": total, "pages": -(-total // limit) if limit else 0}

    async def count(self, table, filters=None):
        t = codec.table_def(table)
        res = await self._ok(t, {"action": "count", "filters": codec.encode_filter(t, filters)}, write=False)
        return int(res["data"]["count"])

    async def sum(self, table, field, filters=None, group_by=None):
        t = codec.table_def(table)
        body = {"action": "sum", "filters": codec.encode_filter(t, filters)}
        if field:
            body["field"] = field
        if group_by:
            body["group_by"] = group_by
        return (await self._ok(t, body, write=False))["data"]

    async def ledger_summary(self, filters=None):
        t = codec.table_def("financial_ledger")
        res = await self._ok(t, {"action": "ledger_summary", "filters": codec.encode_filter(t, filters)}, write=False)
        from decimal import Decimal

        return {k: Decimal(v) for k, v in res["data"].items()}

    # ---------------------------------------------------------------- writes --

    async def create(self, table, data):
        t = codec.table_def(table)
        enc = await self._spill(t, codec.encode_doc(t, data))
        res = await self._ok(t, {"action": "create", "data": enc}, write=True)
        return codec.decode_doc(t, res["data"])

    async def batch_create(self, table, rows):
        t = codec.table_def(table)
        out: list[dict] = []
        for off in range(0, len(rows), 500):
            chunk = [await self._spill(t, codec.encode_doc(t, r)) for r in rows[off:off + 500]]
            res = await self._ok(t, {"action": "create", "rows": chunk}, write=True)
            out.extend(codec.decode_doc(t, d) for d in res["data"])
        return out

    async def update(self, table, id, update, filters=None, many=False):
        t = codec.table_def(table)
        upd = codec.encode_update(t, update)
        if "$set" in upd:
            upd["$set"] = (await self._spill(t, upd["$set"]))
        body: dict[str, Any] = {"action": "update", "update": upd, "many": bool(many)}
        if id is not None:
            body["id"] = str(id)
        if filters:
            body["filters"] = codec.encode_filter(t, filters)
        res = await self._ok(t, body, write=True)
        return {"matched": res["data"]["matched"], "modified": res["data"]["modified"],
                "data": codec.decode_doc(t, res["data"].get("data"))}

    async def batch_update(self, table, updates):
        modified = 0
        for filters, update in updates:
            modified += (await self.update(table, None, update, filters=filters))["modified"]
        return modified

    async def find_one_and_update(self, table, filters, update, upsert=False, return_after=True, sort=None):
        t = codec.table_def(table)
        upd = codec.encode_update(t, update)
        if "$set" in upd:
            upd["$set"] = await self._spill(t, upd["$set"])
        body = {"action": "find_one_and_update", "filters": codec.encode_filter(t, filters), "update": upd,
                "upsert": bool(upsert), "return_document": "after" if return_after else "before"}
        if sort:
            body["sort"] = codec.encode_sort(sort)
        res = await self._ok(t, body, write=True)
        return codec.decode_doc(t, res["data"])

    async def delete(self, table, id=None, filters=None, many=False):
        t = codec.table_def(table)
        body: dict[str, Any] = {"action": "delete", "many": bool(many)}
        if id is not None:
            body["id"] = str(id)
        if filters:
            body["filters"] = codec.encode_filter(t, filters)
        res = await self._ok(t, body, write=True)
        return int(res["data"]["deleted"])

    async def batch(self, operations):
        """`operations` use storage table names; documents are native types.
        Supported ops: create, update, delete, find_one_and_update, guard."""
        wire = []
        tables = []
        for op in operations:
            op = dict(op)
            if op["op"] == "guard":
                tables.append(codec.table_def("financial_ledger"))
                if "amount" in op:
                    op["amount"] = codec.money_text(op["amount"])
                wire.append(op)
                continue
            t = codec.table_def(op["table"])
            tables.append(t)
            op["table"] = t["tab"]
            if "data" in op and op["op"] == "create":
                op["data"] = _encode_with_refs(t, op["data"])
            if "filters" in op:
                op["filters"] = codec.encode_filter(t, op["filters"])
            if "update" in op:
                op["update"] = codec.encode_update(t, op["update"])
            wire.append(op)
        url = self._url(tables[0])
        if any(self._url(t) != url for t in tables):
            raise ValueError("A batch must stay within one spreadsheet")
        result = await self._call(url, {"action": "batch", "operations": wire}, write=True)
        if not result.get("success"):
            self._raise(result)
        out = []
        for op, t, r in zip(operations, tables, result["data"]):
            out.append(_decode_op_result(op, t, r))
        return out


def _encode_with_refs(t: dict, doc: dict) -> dict:
    """Like codec.encode_doc but leaves "$var.path" references for the server to resolve."""
    out = {}
    for k, v in doc.items():
        if isinstance(v, str) and v.startswith("$") and len(v) > 1:
            out[k] = v
        else:
            out[k] = codec.encode_field(t, k, v)
    return out


def _decode_op_result(op: dict, t: dict, r: Any) -> Any:
    if r is None or not isinstance(r, (dict, list)):
        return r
    if isinstance(r, dict) and r.get("skipped"):
        return None
    kind = op["op"]
    if kind in ("create", "find_one_and_update") and isinstance(r, dict):
        return codec.decode_doc(t, r)
    if kind == "create" and isinstance(r, list):
        return [codec.decode_doc(t, x) for x in r]
    return r
