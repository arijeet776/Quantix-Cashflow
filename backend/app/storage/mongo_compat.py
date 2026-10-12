"""
Motor-compatible facade over the Google Sheets storage adapter.

The existing repositories/services call `get_database()["collection"].find_one(...)`
etc. In STORAGE_BACKEND=google_sheets mode `get_database()` returns a
`SheetsDatabase`, so ALL of that code keeps working unchanged - nothing in the
services, API routes or React frontend knows which backend is active.

Supported surface = exactly what the application uses (audited): find_one, find
(sort/skip/limit/to_list/async-iteration/projection), insert_one/many,
update_one/many ($set $inc $push $setOnInsert $unset, upsert), delete_one/many,
count_documents, find_one_and_update, aggregate ($match $group $sort with the
expression set the app uses), create_index (no-op: uniqueness is enforced by
the Apps Script from the schema).

Clicks are the only high-volume write: `insert_one` on `clicks` is write-behind
batched (see ClickWriteBuffer) so the tracking redirect never waits for Sheets.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

from pymongo.errors import DuplicateKeyError

from app.storage import codec
from app.storage.sheets_adapter import PAGE, GoogleSheetsStorageAdapter

try:
    from bson import ObjectId
except Exception:  # pragma: no cover
    ObjectId = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

MAX_AGGREGATE_ROWS = 50_000


class ClickWriteBuffer:
    """Write-behind buffer for the append-only `clicks` collection.

    * Flushes every `interval` seconds or when `max_size` rows are waiting, as
      ONE batched Apps Script write (not row by row).
    * Any read/update of `clicks` flushes first, so the application always reads
      its own writes.
    * On failure rows stay queued and are retried; on shutdown `flush()` runs.
    * Trade-off (documented): a hard process crash can lose the rows that were
      queued in the last <= `interval` seconds.
    """

    def __init__(self, adapter: GoogleSheetsStorageAdapter, table: str, interval: float = 2.0, max_size: int = 200):
        self._adapter, self._table, self._interval, self._max = adapter, table, interval, max_size
        self._rows: list[dict] = []
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None

    def add(self, doc: dict) -> None:
        if len(self._rows) >= 5000:
            from app.core.exceptions import ServiceUnavailableError

            raise ServiceUnavailableError("Click buffer is full; storage is not keeping up")
        self._rows.append(doc)
        if self._task is None or self._task.done():
            self._task = asyncio.ensure_future(self._run())

    async def _run(self) -> None:
        try:
            await asyncio.sleep(self._interval)
            while self._rows:
                if not await self.flush():
                    await asyncio.sleep(self._interval * 2)
        except asyncio.CancelledError:  # pragma: no cover
            raise

    async def flush(self) -> bool:
        async with self._lock:
            if not self._rows:
                return True
            batch, self._rows = self._rows[:500], self._rows[500:]
            try:
                await self._adapter.batch_create(self._table, batch)
                return True
            except DuplicateKeyError:
                # A click id collision (practically impossible) - drop that row set safely, one by one.
                for doc in batch:
                    try:
                        await self._adapter.create(self._table, doc)
                    except DuplicateKeyError:
                        logger.error("Dropped a duplicate click row")
                return True
            except Exception as exc:  # noqa: BLE001 - keep rows, retry later
                logger.error("Click buffer flush failed (%s); %d rows kept for retry", type(exc).__name__, len(batch))
                self._rows = batch + self._rows
                return False

    @property
    def pending(self) -> int:
        return len(self._rows)


# --------------------------------------------------------------------- cursor --

class SheetsCursor:
    def __init__(self, col: "SheetsCollection", flt, projection):
        self._col, self._flt, self._proj = col, flt or {}, projection
        self._sort = None
        self._skip = 0
        self._limit = 0

    def sort(self, key_or_list, direction=None):
        if isinstance(key_or_list, str):
            self._sort = [(key_or_list, direction if direction is not None else 1)]
        else:
            self._sort = list(key_or_list)
        return self

    def skip(self, n):
        self._skip = int(n)
        return self

    def limit(self, n):
        self._limit = int(n)
        return self

    async def to_list(self, length=None):
        limit = self._limit
        if length is not None:
            limit = min(limit, length) if limit else length
        return await self._col._query(self._flt, self._sort, self._skip, limit, self._proj)

    def __aiter__(self):
        async def gen():
            for d in await self.to_list(None):
                yield d
        return gen()


class AggregateCursor:
    def __init__(self, col: "SheetsCollection", pipeline: list[dict]):
        self._col, self._pipeline = col, pipeline

    async def to_list(self, length=None):
        rows = await run_pipeline(self._col, self._pipeline)
        return rows if length is None else rows[:length]

    def __aiter__(self):
        async def gen():
            for r in await self.to_list(None):
                yield r
        return gen()


# ----------------------------------------------------------------- collection --

class SheetsCollection:
    def __init__(self, db: "SheetsDatabase", name: str):
        self._db, self.name = db, name
        self._t = codec.table_def(name)
        self._ad: GoogleSheetsStorageAdapter = db.adapter
        self._buffer: ClickWriteBuffer | None = db.buffers.get(name)

    async def _sync(self) -> None:
        if self._buffer is not None and self._buffer.pending:
            await self._buffer.flush()

    async def _query(self, flt, sort, skip, limit, projection) -> list[dict]:
        await self._sync()
        docs, _ = await self._ad.query(self.name, flt, sort, skip, limit if limit else 10**9, projection)
        return docs

    # ----- reads
    async def find_one(self, filter=None, projection=None, sort=None, **_):
        await self._sync()
        return await self._ad.find_one(self.name, filter or {}, sort, projection)

    def find(self, filter=None, projection=None, **_):
        return SheetsCursor(self, filter, projection)

    async def count_documents(self, filter=None, **_):
        await self._sync()
        return await self._ad.count(self.name, filter or {})

    def aggregate(self, pipeline, **_):
        return AggregateCursor(self, pipeline)

    # ----- writes
    async def insert_one(self, document, **_):
        doc = document
        if self._t["id_field"] == "_id" and doc.get("_id") is None and ObjectId is not None:
            doc["_id"] = ObjectId()  # pymongo also assigns _id in place
        if self._buffer is not None:
            self._buffer.add(dict(doc))
            return SimpleNamespace(inserted_id=doc.get("_id"), acknowledged=True)
        created = await self._ad.create(self.name, dict(doc))
        return SimpleNamespace(inserted_id=created.get("_id", doc.get("_id")), acknowledged=True)

    async def insert_many(self, documents, **_):
        docs = list(documents)
        for d in docs:
            if self._t["id_field"] == "_id" and d.get("_id") is None and ObjectId is not None:
                d["_id"] = ObjectId()
        created = await self._ad.batch_create(self.name, [dict(d) for d in docs])
        return SimpleNamespace(inserted_ids=[c.get("_id") for c in created], acknowledged=True)

    async def update_one(self, filter, update, upsert=False, **_):
        await self._sync()
        return await self._update(filter, update, upsert, many=False)

    async def update_many(self, filter, update, upsert=False, **_):
        await self._sync()
        return await self._update(filter, update, upsert, many=True)

    async def _update(self, flt, update, upsert, many):
        res = await self._ad.update(self.name, None, update, filters=flt or {}, many=many)
        if res["matched"] == 0 and upsert:
            doc = await self._ad.find_one_and_update(self.name, flt or {}, update, upsert=True, return_after=True)
            return SimpleNamespace(matched_count=0, modified_count=0, upserted_id=(doc or {}).get("_id"), acknowledged=True)
        return SimpleNamespace(matched_count=res["matched"], modified_count=res["modified"], upserted_id=None, acknowledged=True)

    async def find_one_and_update(self, filter, update, projection=None, upsert=False, return_document=False, sort=None, **_):
        await self._sync()
        doc = await self._ad.find_one_and_update(self.name, filter or {}, update, upsert=upsert,
                                                 return_after=bool(return_document), sort=sort)
        if doc is not None and projection:
            doc = _apply_projection(doc, projection)
        return doc

    async def delete_one(self, filter, **_):
        await self._sync()
        n = await self._ad.delete(self.name, filters=filter or {}, many=False)
        return SimpleNamespace(deleted_count=n, acknowledged=True)

    async def delete_many(self, filter, **_):
        await self._sync()
        n = await self._ad.delete(self.name, filters=filter or {}, many=True)
        return SimpleNamespace(deleted_count=n, acknowledged=True)

    async def create_index(self, *args, **kwargs):
        return "noop"  # uniqueness comes from storage/schema.py, enforced by the Apps Script


def _apply_projection(doc: dict, projection: dict) -> dict:
    include = any(v for k, v in projection.items() if k != "_id")
    if include:
        out = {k: v for k, v in doc.items() if projection.get(k)}
        if projection.get("_id", 1) and "_id" in doc:
            out["_id"] = doc["_id"]
        return out
    return {k: v for k, v in doc.items() if projection.get(k, 1) != 0}


class SheetsDatabase:
    def __init__(self, adapter: GoogleSheetsStorageAdapter, buffer_clicks: bool = True, flush_interval: float = 2.0):
        self.adapter = adapter
        self.buffers: dict[str, ClickWriteBuffer] = {}
        if buffer_clicks:
            self.buffers["clicks"] = ClickWriteBuffer(adapter, "clicks", interval=flush_interval)
        self._cols: dict[str, SheetsCollection] = {}

    def __getitem__(self, name: str) -> SheetsCollection:
        if name not in self._cols:
            self._cols[name] = SheetsCollection(self, name)
        return self._cols[name]

    def __getattr__(self, name: str) -> SheetsCollection:
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]

    async def flush(self) -> None:
        for b in self.buffers.values():
            await b.flush()


# ---------------------------------------------------------------- aggregation --

def _field(doc: dict, path: str):
    cur: Any = doc
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


def _eval(expr: Any, doc: dict):
    """Evaluates the aggregation-expression subset the application uses."""
    if isinstance(expr, str) and expr.startswith("$"):
        return _field(doc, expr[1:])
    if isinstance(expr, list):
        return [_eval(e, doc) for e in expr]
    if not isinstance(expr, dict):
        return expr
    if len(expr) == 1:
        (op, arg), = expr.items()
        if op == "$cond":
            cond, then, other = (arg["if"], arg["then"], arg["else"]) if isinstance(arg, dict) else arg
            return _eval(then, doc) if _eval(cond, doc) else _eval(other, doc)
        if op == "$and":
            return all(_eval(a, doc) for a in arg)
        if op == "$or":
            return any(_eval(a, doc) for a in arg)
        if op == "$not":
            return not _eval(arg[0] if isinstance(arg, list) else arg, doc)
        if op == "$ne":
            return _eval(arg[0], doc) != _eval(arg[1], doc)
        if op == "$eq":
            return _eval(arg[0], doc) == _eval(arg[1], doc)
        if op == "$gt":
            a, b = _eval(arg[0], doc), _eval(arg[1], doc)
            return a is not None and b is not None and a > b
        if op == "$gte":
            a, b = _eval(arg[0], doc), _eval(arg[1], doc)
            return a is not None and b is not None and a >= b
        if op == "$lt":
            a, b = _eval(arg[0], doc), _eval(arg[1], doc)
            return a is not None and b is not None and a < b
        if op == "$in":
            return _eval(arg[0], doc) in _eval(arg[1], doc)
        if op == "$ifNull":
            v = _eval(arg[0], doc)
            return v if v is not None else _eval(arg[1], doc)
        if op == "$year":
            v = _eval(arg, doc)
            return v.year if isinstance(v, datetime) else None
        if op == "$month":
            v = _eval(arg, doc)
            return v.month if isinstance(v, datetime) else None
        if op == "$sum":
            return _eval(arg, doc)
        if op.startswith("$"):
            raise NotImplementedError(f"Aggregation operator {op} is not supported by the Sheets backend")
    return {k: _eval(v, doc) for k, v in expr.items()}


def _num(v) -> float | int:
    if v is None or isinstance(v, bool):
        return 0
    if isinstance(v, Decimal):
        return float(v)
    return v if isinstance(v, (int, float)) else 0


async def run_pipeline(col: SheetsCollection, pipeline: list[dict]) -> list[dict]:
    stages = list(pipeline)
    rows: list[dict] | None = None
    if stages and "$match" in stages[0]:
        await col._sync()
        docs, total = await col._ad.query(col.name, stages[0]["$match"], None, 0, MAX_AGGREGATE_ROWS)
        if total > MAX_AGGREGATE_ROWS:
            logger.warning("Aggregation over %s truncated at %d of %d rows", col.name, MAX_AGGREGATE_ROWS, total)
        rows = docs
        stages = stages[1:]
    if rows is None:
        await col._sync()
        rows, _ = await col._ad.query(col.name, {}, None, 0, MAX_AGGREGATE_ROWS)
    for stage in stages:
        (name, spec), = stage.items()
        if name == "$match":
            raise NotImplementedError("A non-leading $match stage is not supported by the Sheets backend")
        elif name == "$group":
            groups: dict = {}
            order: list = []
            for r in rows:
                gid = _eval(spec["_id"], r)
                key = repr(gid)
                if key not in groups:
                    groups[key] = {"_id": gid}
                    order.append(key)
                    for field, acc in spec.items():
                        if field != "_id":
                            groups[key][field] = 0
                for field, acc in spec.items():
                    if field == "_id":
                        continue
                    (aop, aarg), = acc.items()
                    if aop != "$sum":
                        raise NotImplementedError(f"Accumulator {aop} is not supported by the Sheets backend")
                    groups[key][field] += _num(_eval(aarg, r))
            rows = [groups[k] for k in order]
        elif name == "$sort":
            for field, direction in reversed(list(spec.items())):
                rows = sorted(rows, key=lambda r, f=field: (_field(r, f) is None, _field(r, f)), reverse=(direction == -1))
        else:
            raise NotImplementedError(f"Aggregation stage {name} is not supported by the Sheets backend")
    return rows
