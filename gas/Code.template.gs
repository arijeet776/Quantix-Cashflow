/**
 * ============================================================================
 *  QUANTIX CASHFLOW - TEMPORARY GOOGLE SHEETS DATABASE API  (Google Apps Script)
 * ============================================================================
 *  One Apps Script project manages all three spreadsheets:
 *     CORE      (Quantix Core Database)
 *     TRACKING  (Quantix Tracking & Operations)
 *     FINANCE   (Quantix Finance)
 *
 *  GENERATED FILE - do not edit by hand. Source: gas/Code.template.gs +
 *  backend/app/storage/schema.py  (tools/generate_apps_script.py).
 *
 *  Script Properties required (Project Settings -> Script properties):
 *     CORE_SPREADSHEET_ID, TRACKING_SPREADSHEET_ID, FINANCE_SPREADSHEET_ID,
 *     API_SECRET   (>= 32 random characters)
 *
 *  Deploy as Web app:  Execute as = Me,  Who has access = Anyone.
 *  Every request is a POST with a JSON body containing "secret".
 *  Requests without the correct secret get UNAUTHORIZED and touch no data.
 *
 *  Run initializeQuantixDatabase() once from the editor (safe to re-run).
 * ============================================================================
 */

var SCHEMA = /*__SCHEMA__*/;

var MAX_LIMIT = 1000;
var DEFAULT_LIMIT = 100;
var MAX_BATCH_ROWS = 500;
var MAX_OPERATIONS = 50;
var MAX_CELL_CHARS = 49000;
var MAX_REGEX_LEN = 200;
var MAX_FILTER_DEPTH = 8;
var LOCK_WAIT_MS = 30000;
var SECRET_MIN_LEN = 32;
var CANONICAL_STATUS_POSTED = 'posted';
var NUMERIC_RE = /^-?\d+(\.\d+)?$/;

// ---------------------------------------------------------------------------
// Errors / responses
// ---------------------------------------------------------------------------

function AppError(code, message) {
  this.name = 'AppError';
  this.code = code;
  this.message = message;
}

function fail_(code, message) {
  throw new AppError(code, message);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ok_(data, extra) {
  var out = { success: true, data: data };
  if (extra) { for (var k in extra) { out[k] = extra[k]; } }
  return out;
}

function errorResponse_(code, message) {
  return { success: false, error: { code: code, message: message } };
}

// ---------------------------------------------------------------------------
// Configuration + auth (secrets live ONLY in Script Properties)
// ---------------------------------------------------------------------------

function props_() {
  return PropertiesService.getScriptProperties();
}

function safeEqual_(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  }
  return diff === 0 && a.length > 0;
}

function authenticate_(body) {
  var secret = props_().getProperty('API_SECRET');
  if (!secret || secret.length < SECRET_MIN_LEN) {
    fail_('NOT_CONFIGURED', 'API is not configured');
  }
  if (!body || typeof body.secret !== 'string' || !safeEqual_(body.secret, secret)) {
    fail_('UNAUTHORIZED', 'Unauthorized');
  }
}

function spreadsheetIdFor_(db) {
  var key = { core: 'CORE_SPREADSHEET_ID', tracking: 'TRACKING_SPREADSHEET_ID', finance: 'FINANCE_SPREADSHEET_ID' }[db];
  var id = key ? props_().getProperty(key) : null;
  if (!id) { fail_('NOT_CONFIGURED', 'Spreadsheet for "' + db + '" is not configured'); }
  return id;
}

var _ssCache = {};
function spreadsheet_(db) {
  if (!_ssCache[db]) { _ssCache[db] = SpreadsheetApp.openById(spreadsheetIdFor_(db)); }
  return _ssCache[db];
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

var _tableIndex = null;
function tableIndex_() {
  if (_tableIndex) { return _tableIndex; }
  _tableIndex = { byTab: {}, byCollection: {} };
  for (var i = 0; i < SCHEMA.tables.length; i++) {
    var t = SCHEMA.tables[i];
    t.colType = {};
    for (var c = 0; c < t.columns.length; c++) { t.colType[t.columns[c][0]] = t.columns[c][1]; }
    _tableIndex.byTab[t.tab] = t;
    _tableIndex.byCollection[t.collection] = t;
  }
  return _tableIndex;
}

function table_(name) {
  var idx = tableIndex_();
  if (typeof name !== 'string' || !name) { fail_('INVALID_TABLE', 'Unknown table'); }
  var t = idx.byTab[name] || idx.byCollection[name];
  if (!t) { fail_('INVALID_TABLE', 'Unknown table'); }
  return t;
}

function identityCol_(t) {
  return t.id_field === '_id' ? '_id' : t.id_field;
}

function isTextType_(type) { return type === 's' || type === 'd' || type === 'm' || type === 'j'; }

// ---------------------------------------------------------------------------
// Initialization (IDEMPOTENT: creates only what is missing, never deletes or
// overwrites data, never duplicates headers)
// ---------------------------------------------------------------------------

function ensureTable_(t) {
  var ss = spreadsheet_(t.db);
  var sheet = ss.getSheetByName(t.tab);
  var created = false;
  if (!sheet) { sheet = ss.insertSheet(t.tab); created = true; }

  var lastCol = sheet.getLastColumn();
  var existing = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var present = {};
  var hasAnyHeader = false;
  for (var i = 0; i < existing.length; i++) {
    var h = String(existing[i] == null ? '' : existing[i]);
    if (h !== '') { present[h] = i; hasAnyHeader = true; }
  }

  if (!hasAnyHeader && sheet.getLastRow() >= 1) {
    fail_('SCHEMA_CONFLICT', 'Tab "' + t.tab + '" has data but no header row; refusing to overwrite it');
  }
  var addedCols = [];
  var nextCol = existing.length; // 0-based position for the next appended header
  if (!hasAnyHeader) { nextCol = 0; }
  var newHeaders = [];
  for (var c = 0; c < t.columns.length; c++) {
    var name = t.columns[c][0];
    if (present[name] === undefined) {
      newHeaders.push(name);
      addedCols.push({ name: name, type: t.columns[c][1], pos: nextCol + newHeaders.length - 1 });
    }
  }

  if (newHeaders.length) {
    var need = nextCol + newHeaders.length;
    if (sheet.getMaxColumns() < need) { sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns()); }
    sheet.getRange(1, nextCol + 1, 1, newHeaders.length).setValues([newHeaders]);
    sheet.getRange(1, nextCol + 1, 1, newHeaders.length).setFontWeight('bold');
    // Plain-text format on text-like columns so Sheets never auto-converts
    // IDs, ISO timestamps, money strings or JSON into dates/numbers/formulas.
    var rows = Math.max(sheet.getMaxRows() - 1, 1);
    for (var a = 0; a < addedCols.length; a++) {
      if (isTextType_(addedCols[a].type)) {
        sheet.getRange(2, addedCols[a].pos + 1, rows, 1).setNumberFormat('@');
      }
    }
  }
  if (sheet.getFrozenRows() < 1) { sheet.setFrozenRows(1); }
  return { sheet: sheet, created: created, headersAdded: newHeaders.length };
}

/**
 * Creates every missing tab and header. Safe to run any number of times.
 * Returns a report (also usable from the editor: View -> Logs).
 */
function initializeQuantixDatabase() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) { fail_('SERVER_BUSY', 'Could not obtain lock'); }
  try {
    var report = { databases: {}, tabs_created: 0, headers_added: 0 };
    var idx = tableIndex_();
    var touched = {};
    for (var i = 0; i < SCHEMA.tables.length; i++) {
      var t = SCHEMA.tables[i];
      var r = ensureTable_(t);
      touched[t.db] = true;
      if (!report.databases[t.db]) { report.databases[t.db] = []; }
      report.databases[t.db].push({ tab: t.tab, created: r.created, headers_added: r.headersAdded });
      if (r.created) { report.tabs_created++; }
      report.headers_added += r.headersAdded;
    }
    // Remove the untouched default empty "Sheet1" only if it is completely empty.
    for (var db in touched) {
      var ss = spreadsheet_(db);
      var def = ss.getSheetByName('Sheet1');
      if (def && ss.getSheets().length > 1 && def.getLastRow() === 0 && def.getLastColumn() === 0) { ss.deleteSheet(def); }
    }
    return report;
  } finally {
    lock.releaseLock();
  }
}

/** Reports which properties are set (never their values). */
function checkConfiguration() {
  var p = props_();
  var secret = p.getProperty('API_SECRET');
  return {
    CORE_SPREADSHEET_ID: !!p.getProperty('CORE_SPREADSHEET_ID'),
    TRACKING_SPREADSHEET_ID: !!p.getProperty('TRACKING_SPREADSHEET_ID'),
    FINANCE_SPREADSHEET_ID: !!p.getProperty('FINANCE_SPREADSHEET_ID'),
    API_SECRET_set: !!secret,
    API_SECRET_long_enough: !!secret && secret.length >= SECRET_MIN_LEN
  };
}

// ---------------------------------------------------------------------------
// Cell <-> value codec
// ---------------------------------------------------------------------------

function isEmpty_(v) { return v === '' || v === null || v === undefined; }

function encodeCell_(type, value, colName) {
  if (value === undefined || value === null) { return ''; }
  var out;
  switch (type) {
    case 'i':
    case 'f':
      out = Number(value);
      if (!isFinite(out)) { fail_('VALIDATION_ERROR', 'Field "' + colName + '" must be a number'); }
      return out;
    case 'b':
      if (typeof value === 'boolean') { return value; }
      if (value === 'true' || value === 'TRUE') { return true; }
      if (value === 'false' || value === 'FALSE') { return false; }
      fail_('VALIDATION_ERROR', 'Field "' + colName + '" must be a boolean');
      break;
    case 'm':
      out = String(value);
      if (!/^-?\d+(\.\d{1,2})?$/.test(out)) { fail_('VALIDATION_ERROR', 'Field "' + colName + '" must be a decimal amount'); }
      return out.indexOf('.') === -1 ? out + '.00' : (out.split('.')[1].length === 1 ? out + '0' : out);
    case 'j':
      out = JSON.stringify(value);
      break;
    default: // 's' and 'd'
      out = (typeof value === 'object') ? JSON.stringify(value) : String(value);
  }
  if (out.length > MAX_CELL_CHARS) { fail_('VALUE_TOO_LONG', 'Field "' + colName + '" exceeds the cell size limit'); }
  return out;
}

function decodeCell_(type, cell) {
  if (cell === '' || cell === null || cell === undefined) { return null; }
  if (cell instanceof Date) { return cell.toISOString(); }
  switch (type) {
    case 'i':
    case 'f':
      return typeof cell === 'number' ? cell : Number(cell);
    case 'b':
      return cell === true || cell === 'TRUE' || cell === 'true';
    case 'j':
      try { return JSON.parse(cell); } catch (e) { return null; }
    default:
      return String(cell);
  }
}

// ---------------------------------------------------------------------------
// Table context (sheet + actual header positions; users may reorder columns)
// ---------------------------------------------------------------------------

function ctx_(t, createIfMissing) {
  var ss = spreadsheet_(t.db);
  var sheet = ss.getSheetByName(t.tab);
  if (!sheet) {
    if (!createIfMissing) { return null; }
    sheet = ensureTable_(t).sheet;
  }
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var pos = {};
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] == null ? '' : headers[i]);
    if (h !== '') { pos[h] = i; }
  }
  for (var c = 0; c < t.columns.length; c++) {
    if (pos[t.columns[c][0]] === undefined) {
      if (!createIfMissing) { return null; }
      sheet = ensureTable_(t).sheet;
      return ctx_(t, false);
    }
  }
  return { t: t, sheet: sheet, pos: pos, width: headers.length };
}

function dataRows_(cx) {
  var last = cx.sheet.getLastRow();
  return last > 1 ? last - 1 : 0;
}

function readColumn_(cx, colName, n) {
  if (n <= 0) { return []; }
  var vals = cx.sheet.getRange(2, cx.pos[colName] + 1, n, 1).getValues();
  var out = new Array(n);
  for (var i = 0; i < n; i++) { out[i] = vals[i][0]; }
  return out;
}

function rowToDoc_(cx, row) {
  var t = cx.t, doc = {}, c, name, extra = null;
  for (c = 0; c < t.columns.length; c++) {
    name = t.columns[c][0];
    var v = decodeCell_(t.columns[c][1], row[cx.pos[name]]);
    if (name === '_extra') { extra = v; } else { doc[name] = v; }
  }
  if (extra && typeof extra === 'object') {
    for (var k in extra) { if (!(k in doc) || doc[k] === null) { doc[k] = extra[k]; } }
  }
  return doc;
}

function docToRow_(cx, doc) {
  var t = cx.t, row = new Array(cx.width), i, name, extra = {}, hasExtra = false;
  for (i = 0; i < cx.width; i++) { row[i] = ''; }
  for (var k in doc) {
    if (!Object.prototype.hasOwnProperty.call(doc, k)) { continue; }
    if (t.colType[k] === undefined) {
      if (doc[k] !== undefined && doc[k] !== null) { extra[k] = doc[k]; hasExtra = true; }
    }
  }
  for (var c = 0; c < t.columns.length; c++) {
    name = t.columns[c][0];
    if (name === '_extra') { row[cx.pos[name]] = hasExtra ? encodeCell_('j', extra, name) : ''; continue; }
    row[cx.pos[name]] = encodeCell_(t.columns[c][1], doc[name], name);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Query language (Mongo-style subset):
//   field equality, $eq $ne $gt $gte $lt $lte $in $nin $exists $regex($options)
//   $not, and top-level $and / $or / $nor. Dotted paths reach into JSON columns.
// ---------------------------------------------------------------------------

function getPath_(doc, path) {
  var parts = path.split('.');
  var cur = doc;
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) { return undefined; }
    if (Array.isArray(cur)) {
      var collected = [];
      for (var j = 0; j < cur.length; j++) { if (cur[j] && cur[j][parts[i]] !== undefined) { collected.push(cur[j][parts[i]]); } }
      cur = collected.length ? collected : undefined;
    } else {
      cur = cur[parts[i]];
    }
  }
  return cur;
}

function setPath_(doc, path, value) {
  var parts = path.split('.');
  var cur = doc;
  for (var i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') { cur[parts[i]] = {}; }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath_(doc, path) {
  var parts = path.split('.');
  var cur = doc;
  for (var i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') { return; }
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === 'object') { delete cur[parts[parts.length - 1]]; }
}

function cmp_(a, b) {
  if (a === b) { return 0; }
  if (typeof a === 'number' && typeof b === 'number') { return a < b ? -1 : 1; }
  var sa = String(a), sb = String(b);
  // Numeric-looking text (money columns such as "100.00") orders numerically.
  if (NUMERIC_RE.test(sa) && NUMERIC_RE.test(sb)) {
    var na = parseFloat(sa), nb = parseFloat(sb);
    return na === nb ? 0 : (na < nb ? -1 : 1);
  }
  return sa < sb ? -1 : (sa > sb ? 1 : 0);
}

function valuesEqual_(a, b) {
  if (a === null || a === undefined) { return b === null || b === undefined; }
  if (b === null || b === undefined) { return false; }
  if (typeof a === 'object' || typeof b === 'object') { return JSON.stringify(a) === JSON.stringify(b); }
  if (typeof a === 'number' || typeof b === 'number') { return Number(a) === Number(b); }
  return String(a) === String(b);
}

function matchOperand_(docVal, cond) {
  if (Array.isArray(docVal) && !(cond && typeof cond === 'object' && !Array.isArray(cond) && hasOperator_(cond))) {
    for (var i = 0; i < docVal.length; i++) { if (valuesEqual_(docVal[i], cond)) { return true; } }
    if (Array.isArray(cond)) { return valuesEqual_(docVal, cond); }
    return false;
  }
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && hasOperator_(cond)) {
    for (var op in cond) {
      if (!matchOp_(docVal, op, cond[op], cond)) { return false; }
    }
    return true;
  }
  return valuesEqual_(docVal, cond);
}

function hasOperator_(obj) {
  for (var k in obj) { if (k.charAt(0) === '$') { return true; } }
  return false;
}

function matchOp_(v, op, arg, whole) {
  var present = !(v === null || v === undefined);
  var i;
  switch (op) {
    case '$eq': return valuesEqual_(v, arg);
    case '$ne': return !valuesEqual_(v, arg);
    case '$gt': return present && arg !== null && cmp_(v, arg) > 0;
    case '$gte': return present && arg !== null && cmp_(v, arg) >= 0;
    case '$lt': return present && arg !== null && cmp_(v, arg) < 0;
    case '$lte': return present && arg !== null && cmp_(v, arg) <= 0;
    case '$in':
      if (!Array.isArray(arg)) { fail_('VALIDATION_ERROR', '$in needs an array'); }
      for (i = 0; i < arg.length; i++) {
        if (Array.isArray(v)) { for (var j = 0; j < v.length; j++) { if (valuesEqual_(v[j], arg[i])) { return true; } } }
        else if (valuesEqual_(v, arg[i])) { return true; }
      }
      return false;
    case '$nin':
      if (!Array.isArray(arg)) { fail_('VALIDATION_ERROR', '$nin needs an array'); }
      return !matchOp_(v, '$in', arg, whole);
    case '$exists': return arg ? present : !present;
    case '$regex':
      if (!present || typeof v === 'object') { return false; }
      return compileRegex_(arg, whole.$options).test(String(v));
    case '$options': return true;
    case '$not':
      if (arg !== null && typeof arg === 'object' && hasOperator_(arg)) { return !matchOperand_(v, arg); }
      fail_('VALIDATION_ERROR', '$not needs an operator expression');
      break;
    default:
      fail_('VALIDATION_ERROR', 'Unsupported operator ' + op);
  }
  return false;
}

var _regexCache = {};
function compileRegex_(pattern, options) {
  if (typeof pattern !== 'string' || pattern.length > MAX_REGEX_LEN) { fail_('VALIDATION_ERROR', 'Invalid regex'); }
  var flags = (options && String(options).indexOf('i') !== -1) ? 'i' : '';
  var key = flags + ':' + pattern;
  if (!_regexCache[key]) {
    try { _regexCache[key] = new RegExp(pattern, flags); } catch (e) { fail_('VALIDATION_ERROR', 'Invalid regex'); }
  }
  return _regexCache[key];
}

function matchDoc_(doc, filter, depth) {
  depth = depth || 0;
  if (depth > MAX_FILTER_DEPTH) { fail_('VALIDATION_ERROR', 'Filter is nested too deeply'); }
  for (var key in filter) {
    if (!Object.prototype.hasOwnProperty.call(filter, key)) { continue; }
    var cond = filter[key], i;
    if (key === '$and') {
      for (i = 0; i < cond.length; i++) { if (!matchDoc_(doc, cond[i], depth + 1)) { return false; } }
    } else if (key === '$or') {
      var any = false;
      for (i = 0; i < cond.length; i++) { if (matchDoc_(doc, cond[i], depth + 1)) { any = true; break; } }
      if (!any) { return false; }
    } else if (key === '$nor') {
      for (i = 0; i < cond.length; i++) { if (matchDoc_(doc, cond[i], depth + 1)) { return false; } }
    } else if (key.charAt(0) === '$') {
      fail_('VALIDATION_ERROR', 'Unsupported top-level operator ' + key);
    } else {
      if (!matchOperand_(getPath_(doc, key), cond)) { return false; }
    }
  }
  return true;
}

/** Top-level columns a filter touches (so only those columns are read first). */
function filterColumns_(filter, out, depth) {
  out = out || {};
  depth = depth || 0;
  if (depth > MAX_FILTER_DEPTH) { fail_('VALIDATION_ERROR', 'Filter is nested too deeply'); }
  for (var key in filter) {
    if (!Object.prototype.hasOwnProperty.call(filter, key)) { continue; }
    if (key === '$and' || key === '$or' || key === '$nor') {
      if (!Array.isArray(filter[key])) { fail_('VALIDATION_ERROR', key + ' needs an array'); }
      for (var i = 0; i < filter[key].length; i++) { filterColumns_(filter[key][i], out, depth + 1); }
    } else if (key.charAt(0) === '$') {
      fail_('VALIDATION_ERROR', 'Unsupported top-level operator ' + key);
    } else {
      out[key.split('.')[0]] = true;
    }
  }
  return out;
}

function validateFilter_(t, filter) {
  if (filter === undefined || filter === null) { return {}; }
  if (typeof filter !== 'object' || Array.isArray(filter)) { fail_('VALIDATION_ERROR', 'filters must be an object'); }
  return filter;
}

/**
 * Column-first evaluation: reads only the identity column + the columns the
 * filter/sort need, evaluates the filter on those, and returns the matching
 * 0-based data-row indexes. Full rows are fetched later, for the page only.
 */
function matchRows_(cx, filter, sortField) {
  var t = cx.t;
  var n = dataRows_(cx);
  if (n === 0) { return { n: 0, matched: [] }; }
  var idCol = identityCol_(t);
  var ids = readColumn_(cx, idCol, n);
  var need = filterColumns_(filter);
  var colData = {};
  var name;
  for (name in need) {
    if (t.colType[name] === undefined && name !== '_extra') {
      // A field that is not a declared column lives in _extra.
      need._extra = true;
    }
  }
  for (name in need) {
    if (t.colType[name] !== undefined) { colData[name] = readColumn_(cx, name, n); }
  }
  var hasFilter = false;
  for (var fk in filter) { hasFilter = true; break; }
  var matched = [];
  for (var i = 0; i < n; i++) {
    if (isEmpty_(ids[i])) { continue; }
    if (hasFilter) {
      var doc = {};
      for (name in colData) {
        if (name === '_extra') { continue; }
        doc[name] = decodeCell_(t.colType[name], colData[name][i]);
      }
      if (colData._extra) {
        var ex = decodeCell_('j', colData._extra[i]);
        if (ex && typeof ex === 'object') { for (var ek in ex) { if (!(ek in doc)) { doc[ek] = ex[ek]; } } }
      }
      if (!matchDoc_(doc, filter, 0)) { continue; }
    }
    matched.push(i);
  }
  return { n: n, matched: matched, ids: ids };
}

function sortMatched_(cx, matched, sort) {
  if (!sort || typeof sort !== 'object') { return matched; }
  var fields = [];
  for (var f in sort) { if (Object.prototype.hasOwnProperty.call(sort, f)) { fields.push([f, sort[f] === -1 || sort[f] === 'desc' ? -1 : 1]); } }
  if (!fields.length) { return matched; }
  var n = dataRows_(cx);
  var t = cx.t;
  var cols = [];
  for (var i = 0; i < fields.length; i++) {
    var fname = fields[i][0];
    if (fname === '_natural') { cols.push(null); continue; }
    var base = fname.split('.')[0];
    if (t.colType[base] === undefined) { fail_('VALIDATION_ERROR', 'Cannot sort by unknown field "' + fname + '"'); }
    var raw = readColumn_(cx, base, n);
    var dec = new Array(n);
    for (var r = 0; r < n; r++) {
      var v = decodeCell_(t.colType[base], raw[r]);
      dec[r] = fname.indexOf('.') === -1 ? v : getPath_({ x: v }, 'x.' + fname.split('.').slice(1).join('.'));
    }
    cols.push(dec);
  }
  var copy = matched.slice();
  var order = {};
  for (var o = 0; o < copy.length; o++) { order[copy[o]] = o; }
  copy.sort(function (a, b) {
    for (var k = 0; k < fields.length; k++) {
      var dir = fields[k][1], res;
      if (cols[k] === null) { res = a - b; }
      else {
        var va = cols[k][a], vb = cols[k][b];
        var na = (va === null || va === undefined), nb = (vb === null || vb === undefined);
        if (na && nb) { res = 0; } else if (na) { res = -1; } else if (nb) { res = 1; } else { res = cmp_(va, vb); }
      }
      if (res !== 0) { return res * dir; }
    }
    return a - b;
  });
  return copy;
}

function fetchRows_(cx, indexes) {
  // Returns [{index,row}] preserving the order of `indexes`, reading
  // contiguous runs in as few range reads as possible.
  var out = {};
  if (!indexes.length) { return []; }
  var sorted = indexes.slice().sort(function (a, b) { return a - b; });
  var runs = [], start = sorted[0], prev = sorted[0];
  for (var i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) { prev = sorted[i]; continue; }
    runs.push([start, prev]); start = sorted[i]; prev = sorted[i];
  }
  runs.push([start, prev]);
  var span = sorted[sorted.length - 1] - sorted[0] + 1;
  if (runs.length > 8 && span <= 5000) { runs = [[sorted[0], sorted[sorted.length - 1]]]; }
  for (var r = 0; r < runs.length; r++) {
    var cnt = runs[r][1] - runs[r][0] + 1;
    var vals = cx.sheet.getRange(runs[r][0] + 2, 1, cnt, cx.width).getValues();
    for (var k = 0; k < cnt; k++) { out[runs[r][0] + k] = vals[k]; }
  }
  var res = [];
  for (var j = 0; j < indexes.length; j++) { res.push({ index: indexes[j], row: out[indexes[j]] }); }
  return res;
}

function project_(doc, projection) {
  if (!projection || typeof projection !== 'object') { return doc; }
  var include = false, k;
  for (k in projection) { if (projection[k] && k !== '_id') { include = true; } }
  var out = {};
  if (include) {
    for (k in projection) { if (projection[k] && doc[k] !== undefined) { out[k] = doc[k]; } }
    if (projection._id !== 0 && doc._id !== undefined) { out._id = doc._id; }
    return out;
  }
  for (k in doc) { if (projection[k] !== 0) { out[k] = doc[k]; } }
  return out;
}

// ---------------------------------------------------------------------------
// Read actions
// ---------------------------------------------------------------------------

function clampLimit_(v) {
  var n = Number(v);
  if (!isFinite(n) || n <= 0) { return DEFAULT_LIMIT; }
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function pageParams_(req) {
  var limit = clampLimit_(req.limit);
  var skip;
  if (req.skip !== undefined && req.skip !== null) { skip = Math.max(0, Math.floor(Number(req.skip)) || 0); }
  else { var page = Math.max(1, Math.floor(Number(req.page)) || 1); skip = (page - 1) * limit; }
  return { limit: limit, skip: skip, page: Math.floor(skip / limit) + 1 };
}

function actionQuery_(req) {
  var t = table_(req.table);
  var filter = validateFilter_(t, req.filters);
  var pg = pageParams_(req);
  var cx = ctx_(t, false);
  if (!cx) { return ok_([], { pagination: { page: pg.page, limit: pg.limit, total: 0, pages: 0 } }); }
  var m = matchRows_(cx, filter);
  var matched = sortMatched_(cx, m.matched, req.sort);
  var total = matched.length;
  var pageIdx = matched.slice(pg.skip, pg.skip + pg.limit);
  var rows = fetchRows_(cx, pageIdx), docs = [];
  for (var i = 0; i < rows.length; i++) { docs.push(project_(rowToDoc_(cx, rows[i].row), req.projection)); }
  return ok_(docs, { pagination: { page: pg.page, limit: pg.limit, total: total, pages: Math.ceil(total / pg.limit) } });
}

function actionGet_(req) {
  var t = table_(req.table);
  if (isEmpty_(req.id)) { fail_('VALIDATION_ERROR', 'id is required'); }
  var cx = ctx_(t, false);
  if (!cx) { return ok_(null); }
  var f = {}; f[identityCol_(t)] = String(req.id);
  var m = matchRows_(cx, f);
  if (!m.matched.length) { return ok_(null); }
  var rows = fetchRows_(cx, [m.matched[0]]);
  return ok_(project_(rowToDoc_(cx, rows[0].row), req.projection));
}

function actionCount_(req) {
  var t = table_(req.table);
  var cx = ctx_(t, false);
  if (!cx) { return ok_({ count: 0 }); }
  return ok_({ count: matchRows_(cx, validateFilter_(t, req.filters)).matched.length });
}

function actionFindOne_(req) {
  var t = table_(req.table);
  var cx = ctx_(t, false);
  if (!cx) { return ok_(null); }
  var m = matchRows_(cx, validateFilter_(t, req.filters));
  var matched = sortMatched_(cx, m.matched, req.sort);
  if (!matched.length) { return ok_(null); }
  var rows = fetchRows_(cx, [matched[0]]);
  return ok_(project_(rowToDoc_(cx, rows[0].row), req.projection));
}

/**
 * Server-side sum/count (money-safe: integer paise) with optional group_by.
 * Used for ledger/wallet projections so balances are always computed from the
 * ledger rows, never from a stored or cached number.
 */
function actionSum_(req) {
  var t = table_(req.table);
  var field = req.field;
  if (field && t.colType[field] === undefined) { fail_('VALIDATION_ERROR', 'Unknown field'); }
  var filter = validateFilter_(t, req.filters);
  var cx = ctx_(t, false);
  if (!cx) { return ok_({ count: 0, sum: field ? '0.00' : null, groups: [] }); }
  var m = matchRows_(cx, filter);
  var n = m.n;
  var groupBy = req.group_by || [];
  var valueCol = field ? readColumn_(cx, field, n) : null;
  var gcols = [];
  for (var g = 0; g < groupBy.length; g++) {
    if (t.colType[groupBy[g]] === undefined) { fail_('VALIDATION_ERROR', 'Unknown group field'); }
    gcols.push(readColumn_(cx, groupBy[g], n));
  }
  var total = 0, groups = {}, order = [];
  var isMoney = field && t.colType[field] === 'm';
  for (var i = 0; i < m.matched.length; i++) {
    var r = m.matched[i];
    var amt = 0;
    if (valueCol && !isEmpty_(valueCol[r])) { amt = isMoney ? Math.round(parseFloat(valueCol[r]) * 100) : Number(valueCol[r]); }
    total += amt;
    if (gcols.length) {
      var keyVals = [];
      for (var k = 0; k < gcols.length; k++) { keyVals.push(isEmpty_(gcols[k][r]) ? null : String(gcols[k][r])); }
      var key = JSON.stringify(keyVals);
      if (!groups[key]) { groups[key] = { key: keyVals, count: 0, sum: 0 }; order.push(key); }
      groups[key].count++; groups[key].sum += amt;
    }
  }
  var fmt = function (v) { return isMoney ? (v / 100).toFixed(2) : v; };
  var outGroups = [];
  for (var o = 0; o < order.length; o++) {
    outGroups.push({ key: groups[order[o]].key, count: groups[order[o]].count, sum: fmt(groups[order[o]].sum) });
  }
  return ok_({ count: m.matched.length, sum: field ? fmt(total) : null, groups: outGroups });
}

/** Ledger-derived wallet projection (mirrors ledger_repository.get_balance). */
function ledgerSummary_(filters) {
  var t = table_('FinancialLedger');
  var cx = ctx_(t, false);
  var zero = { total_credits: 0, total_debits: 0, total_earned: 0, total_reversed: 0, total_held_ever: 0, total_released: 0 };
  if (!cx) { return zero; }
  var f = {};
  for (var k in (filters || {})) { f[k] = filters[k]; }
  f.status = CANONICAL_STATUS_POSTED;
  var m = matchRows_(cx, f);
  var n = m.n;
  var amount = readColumn_(cx, 'amount', n), direction = readColumn_(cx, 'direction', n), type = readColumn_(cx, 'transaction_type', n);
  var s = zero;
  for (var i = 0; i < m.matched.length; i++) {
    var r = m.matched[i];
    var paise = Math.round(parseFloat(amount[r]) * 100);
    if (direction[r] === 'credit') { s.total_credits += paise; } else if (direction[r] === 'debit') { s.total_debits += paise; }
    if (type[r] === 'earning') { s.total_earned += paise; }
    else if (type[r] === 'earning_reversal') { s.total_reversed += paise; }
    else if (type[r] === 'withdrawal_hold') { s.total_held_ever += paise; }
    else if (type[r] === 'withdrawal_release') { s.total_released += paise; }
  }
  return s;
}

function actionLedgerSummary_(req) {
  var s = ledgerSummary_(req.filters);
  var out = {};
  for (var k in s) { out[k] = (s[k] / 100).toFixed(2); }
  return ok_(out);
}

// ---------------------------------------------------------------------------
// Write primitives (callers hold the script lock)
// ---------------------------------------------------------------------------

function newObjectId_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 24);
}

function keyOf_(vals) {
  return JSON.stringify(vals);
}

/** Existing unique-key sets for the given tuples (read once per write call). */
function uniqueIndexes_(cx) {
  var t = cx.t, n = dataRows_(cx), res = [];
  for (var u = 0; u < t.unique.length; u++) {
    var cols = t.unique[u], data = [];
    for (var c = 0; c < cols.length; c++) { data.push(readColumn_(cx, cols[c], n)); }
    var set = {};
    for (var i = 0; i < n; i++) {
      var vals = [], skip = false;
      for (var c2 = 0; c2 < cols.length; c2++) {
        var v = data[c2][i];
        if (isEmpty_(v)) { skip = true; break; }
        vals.push(String(v));
      }
      if (!skip) { set[keyOf_(vals)] = i; }
    }
    res.push({ cols: cols, set: set });
  }
  return res;
}

function checkUnique_(t, uidx, doc, ownIndex) {
  for (var u = 0; u < uidx.length; u++) {
    var cols = uidx[u].cols, vals = [], skip = false;
    for (var c = 0; c < cols.length; c++) {
      var v = doc[cols[c]];
      if (isEmpty_(v)) { skip = true; break; }
      vals.push(String(v));
    }
    if (skip) { continue; }
    var k = keyOf_(vals);
    if (uidx[u].set[k] !== undefined && uidx[u].set[k] !== ownIndex) {
      fail_('DUPLICATE_KEY', 'Duplicate value for ' + cols.join('+'));
    }
  }
}

function registerUnique_(uidx, doc, index) {
  for (var u = 0; u < uidx.length; u++) {
    var cols = uidx[u].cols, vals = [], skip = false;
    for (var c = 0; c < cols.length; c++) {
      var v = doc[cols[c]];
      if (isEmpty_(v)) { skip = true; break; }
      vals.push(String(v));
    }
    if (!skip) { uidx[u].set[keyOf_(vals)] = index; }
  }
}

function ensureRows_(cx, lastNeededRow) {
  var max = cx.sheet.getMaxRows();
  if (lastNeededRow > max) { cx.sheet.insertRowsAfter(max, lastNeededRow - max + 200); }
}

function insertDocs_(t, docs) {
  if (!docs.length) { return []; }
  if (docs.length > MAX_BATCH_ROWS) { fail_('VALIDATION_ERROR', 'Too many rows in one request (max ' + MAX_BATCH_ROWS + ')'); }
  var cx = ctx_(t, true);
  var uidx = uniqueIndexes_(cx);
  var n = dataRows_(cx);
  var nextAuto = null;
  if (t.autoinc) {
    var col = readColumn_(cx, t.autoinc, n), mx = 0;
    for (var i = 0; i < col.length; i++) { var v = Number(col[i]); if (isFinite(v) && v > mx) { mx = v; } }
    nextAuto = mx + 1;
  }
  var rows = [], out = [];
  for (var d = 0; d < docs.length; d++) {
    var doc = {};
    for (var k in docs[d]) { if (Object.prototype.hasOwnProperty.call(docs[d], k)) { doc[k] = docs[d][k]; } }
    if (t.id_field === '_id' && isEmpty_(doc._id)) { doc._id = newObjectId_(); }
    if (t.id_field !== '_id' && isEmpty_(doc[t.id_field])) { fail_('VALIDATION_ERROR', t.id_field + ' is required'); }
    if (t.autoinc) { doc[t.autoinc] = nextAuto++; }
    checkUnique_(t, uidx, doc, undefined);
    registerUnique_(uidx, doc, n + d);
    rows.push(docToRow_(cx, doc));
    out.push(doc);
  }
  var firstRow = cx.sheet.getLastRow() + 1;
  if (firstRow < 2) { firstRow = 2; }
  ensureRows_(cx, firstRow + rows.length - 1);
  cx.sheet.getRange(firstRow, 1, rows.length, cx.width).setValues(rows);
  return out;
}

function applyUpdate_(doc, update, isInsert) {
  var op, k;
  var known = { $set: 1, $inc: 1, $push: 1, $unset: 1, $setOnInsert: 1 };
  for (op in update) { if (!known[op]) { fail_('VALIDATION_ERROR', 'Unsupported update operator ' + op); } }
  if (update.$set) { for (k in update.$set) { setPath_(doc, k, update.$set[k]); } }
  if (isInsert && update.$setOnInsert) { for (k in update.$setOnInsert) { setPath_(doc, k, update.$setOnInsert[k]); } }
  if (update.$inc) {
    for (k in update.$inc) {
      var cur = getPath_(doc, k);
      setPath_(doc, k, (typeof cur === 'number' ? cur : (cur ? Number(cur) : 0)) + Number(update.$inc[k]));
    }
  }
  if (update.$push) {
    for (k in update.$push) {
      var arr = getPath_(doc, k);
      if (!Array.isArray(arr)) { arr = []; }
      arr.push(update.$push[k]);
      setPath_(doc, k, arr);
    }
  }
  if (update.$unset) { for (k in update.$unset) { unsetPath_(doc, k); } }
}

function validateUpdate_(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) { fail_('VALIDATION_ERROR', 'update must be an object'); }
  var hasOp = false;
  for (var k in update) { if (k.charAt(0) === '$') { hasOp = true; } }
  if (!hasOp) { return { $set: update }; } // plain object = $set
  return update;
}

/** Updates up to `max` matching rows. Returns {matched, modified, docs(after), before}. */
function updateDocs_(t, filter, update, opts) {
  opts = opts || {};
  var cx = ctx_(t, true);
  if (t.append_only) { fail_('FORBIDDEN_TABLE_OPERATION', t.tab + ' is append-only'); }
  var m = matchRows_(cx, filter);
  var matched = sortMatched_(cx, m.matched, opts.sort);
  var max = opts.max === undefined ? matched.length : opts.max;
  matched = matched.slice(0, max);
  var res = { matched: matched.length, modified: 0, docs: [], before: [] };
  if (!matched.length) { return res; }
  var uidx = null; // built lazily, only if an update really changes a unique column
  var rows = fetchRows_(cx, matched);
  var writes = [];
  for (var i = 0; i < rows.length; i++) {
    var doc = rowToDoc_(cx, rows[i].row);
    var before = JSON.parse(JSON.stringify(doc));
    applyUpdate_(doc, update, false);
    if (t.id_field === '_id' && before._id !== doc._id) { fail_('VALIDATION_ERROR', '_id is immutable'); }
    if (t.id_field !== '_id' && before[t.id_field] !== doc[t.id_field]) { fail_('VALIDATION_ERROR', t.id_field + ' is immutable'); }
    if (uniqueChanged_(t, before, doc)) {
      if (!uidx) { uidx = uniqueIndexes_(cx); }
      checkUnique_(t, uidx, doc, rows[i].index);
      registerUnique_(uidx, doc, rows[i].index);
    }
    var newRow = docToRow_(cx, doc);
    var changed = false;
    for (var c = 0; c < newRow.length; c++) { if (String(newRow[c]) !== String(rows[i].row[c] == null ? '' : rows[i].row[c])) { changed = true; break; } }
    if (changed) { writes.push({ index: rows[i].index, row: newRow }); res.modified++; }
    res.docs.push(doc); res.before.push(before);
  }
  writeRows_(cx, writes);
  return res;
}

function uniqueChanged_(t, before, after) {
  for (var u = 0; u < t.unique.length; u++) {
    for (var c = 0; c < t.unique[u].length; c++) {
      var col = t.unique[u][c];
      if (String(before[col] == null ? '' : before[col]) !== String(after[col] == null ? '' : after[col])) { return true; }
    }
  }
  return false;
}

function writeRows_(cx, writes) {
  if (!writes.length) { return; }
  writes.sort(function (a, b) { return a.index - b.index; });
  var lo = writes[0].index, hi = writes[writes.length - 1].index;
  if (writes.length > 20 && (hi - lo + 1) <= writes.length * 3) {
    var block = cx.sheet.getRange(lo + 2, 1, hi - lo + 1, cx.width).getValues();
    for (var w = 0; w < writes.length; w++) { block[writes[w].index - lo] = writes[w].row; }
    cx.sheet.getRange(lo + 2, 1, hi - lo + 1, cx.width).setValues(block);
    return;
  }
  for (var i = 0; i < writes.length; i++) {
    cx.sheet.getRange(writes[i].index + 2, 1, 1, cx.width).setValues([writes[i].row]);
  }
}

function deleteDocs_(t, filter, max) {
  if (t.append_only) { fail_('FORBIDDEN_TABLE_OPERATION', t.tab + ' is append-only'); }
  var cx = ctx_(t, false);
  if (!cx) { return { deleted: 0 }; }
  var m = matchRows_(cx, filter);
  var idx = max === undefined ? m.matched : m.matched.slice(0, max);
  if (!idx.length) { return { deleted: 0 }; }
  idx = idx.slice().sort(function (a, b) { return b - a; });
  var i = 0;
  while (i < idx.length) {
    var j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] - 1) { j++; }
    var count = j - i + 1;
    cx.sheet.deleteRows(idx[j] + 2, count);
    i = j + 1;
  }
  return { deleted: idx.length };
}

function findOneAndUpdate_(t, req) {
  var filter = validateFilter_(t, req.filters);
  var update = validateUpdate_(req.update);
  var res = updateDocs_(t, filter, update, { max: 1, sort: req.sort });
  if (res.matched === 0) {
    if (!req.upsert) { return null; }
    var doc = {};
    for (var k in filter) {
      if (k.charAt(0) === '$') { continue; }
      var cond = filter[k];
      if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) { setPath_(doc, k, cond); }
      else if (cond.$eq !== undefined) { setPath_(doc, k, cond.$eq); }
    }
    applyUpdate_(doc, update, true);
    var created = insertDocs_(t, [doc])[0];
    return req.return_document === 'before' ? null : created;
  }
  return req.return_document === 'before' ? res.before[0] : res.docs[0];
}

// ---------------------------------------------------------------------------
// Lock + dispatch
// ---------------------------------------------------------------------------

function withWriteLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) { fail_('SERVER_BUSY', 'The database is busy, retry shortly'); }
  try { return fn(); } finally { lock.releaseLock(); }
}

function resolveRefs_(value, vars) {
  if (typeof value === 'string' && value.charAt(0) === '$' && value.length > 1) {
    var path = value.substring(1);
    var root = path.split('.')[0];
    if (Object.prototype.hasOwnProperty.call(vars, root)) {
      var got = getPath_(vars, path);
      return got === undefined ? null : got;
    }
    return value;
  }
  if (Array.isArray(value)) { return value.map(function (v) { return resolveRefs_(v, vars); }); }
  if (value && typeof value === 'object') {
    var out = {};
    for (var k in value) { out[k] = resolveRefs_(value[k], vars); }
    return out;
  }
  return value;
}

function guardBalance_(op) {
  if (op.type !== 'balance_gte') { fail_('VALIDATION_ERROR', 'Unknown guard'); }
  if (isEmpty_(op.publisher_id)) { fail_('VALIDATION_ERROR', 'publisher_id is required'); }
  var amount = encodeCell_('m', op.amount, 'amount');
  var s = ledgerSummary_({ publisher_id: String(op.publisher_id) });
  var available = s.total_credits - s.total_debits;
  if (available < Math.round(parseFloat(amount) * 100)) {
    fail_('INSUFFICIENT_BALANCE', 'Requested amount exceeds available balance (' + (available / 100).toFixed(2) + ')');
  }
  return { available_balance: (available / 100).toFixed(2) };
}

function runWriteOp_(op, vars) {
  var t = table_(op.table);
  switch (op.op) {
    case 'create':
      if (Array.isArray(op.rows)) { return insertDocs_(t, op.rows); }
      if (!op.data || typeof op.data !== 'object') { fail_('VALIDATION_ERROR', 'data is required'); }
      return insertDocs_(t, [op.data])[0];
    case 'update':
      if (isEmpty_(op.id) && !op.filters) { fail_('VALIDATION_ERROR', 'id or filters is required'); }
      var f = op.filters ? validateFilter_(t, op.filters) : {};
      if (!isEmpty_(op.id)) { f[identityCol_(t)] = String(op.id); }
      var upd = validateUpdate_(op.update || { $set: op.data });
      var r = updateDocs_(t, f, upd, { max: op.many ? undefined : 1 });
      return { matched: r.matched, modified: r.modified, data: r.docs[0] || null };
    case 'delete':
      if (isEmpty_(op.id) && !op.filters) { fail_('VALIDATION_ERROR', 'id or filters is required'); }
      var df = op.filters ? validateFilter_(t, op.filters) : {};
      if (!isEmpty_(op.id)) { df[identityCol_(t)] = String(op.id); }
      return deleteDocs_(t, df, op.many ? undefined : 1);
    case 'find_one_and_update':
      return findOneAndUpdate_(t, op);
    default:
      fail_('INVALID_ACTION', 'Unknown operation');
  }
  return null;
}

function actionBatch_(req) {
  var ops = req.operations;
  if (!Array.isArray(ops) || !ops.length) { fail_('VALIDATION_ERROR', 'operations must be a non-empty array'); }
  if (ops.length > MAX_OPERATIONS) { fail_('VALIDATION_ERROR', 'Too many operations (max ' + MAX_OPERATIONS + ')'); }
  return withWriteLock_(function () {
    var vars = {}, results = [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!op || typeof op !== 'object') { fail_('VALIDATION_ERROR', 'Invalid operation'); }
      if (op['if'] !== undefined) {
        var cond = resolveRefs_('$' + op['if'], vars);
        if (cond === null || cond === undefined || cond === false || cond === '$' + op['if']) { results.push({ skipped: true }); continue; }
      }
      op = resolveRefs_(op, vars);
      var out;
      try {
        out = op.op === 'guard' ? guardBalance_(op) : runWriteOp_(op, vars);
      } catch (e) {
        if (e instanceof AppError) { e.failed_index = i; e.applied = results; }
        throw e;
      }
      results.push(out);
      if (op.as) { vars[op.as] = out; }
    }
    return ok_(results);
  });
}

function dispatch_(req) {
  var action = req.action;
  switch (action) {
    case 'ping': return ok_({ service: 'quantix-sheets-api', status: 'ok' });
    case 'health': return actionHealth_();
    case 'initialize': return ok_(initializeQuantixDatabase());
    case 'get': return actionGet_(req);
    case 'find_one': return actionFindOne_(req);
    case 'list':
    case 'query': return actionQuery_(req);
    case 'count': return actionCount_(req);
    case 'sum': return actionSum_(req);
    case 'ledger_summary': return actionLedgerSummary_(req);
    case 'create':
      return withWriteLock_(function () { return ok_(runWriteOp_({ op: 'create', table: req.table, data: req.data, rows: req.rows }, {})); });
    case 'update':
      return withWriteLock_(function () {
        return ok_(runWriteOp_({ op: 'update', table: req.table, id: req.id, filters: req.filters, update: req.update, data: req.data, many: req.many }, {}));
      });
    case 'delete':
      return withWriteLock_(function () {
        return ok_(runWriteOp_({ op: 'delete', table: req.table, id: req.id, filters: req.filters, many: req.many }, {}));
      });
    case 'find_one_and_update':
      return withWriteLock_(function () {
        var op = { op: 'find_one_and_update' };
        for (var k in req) { op[k] = req[k]; }
        return ok_(runWriteOp_(op, {}));
      });
    case 'batch': return actionBatch_(req);
    default:
      fail_('INVALID_ACTION', 'Unknown action');
  }
  return null;
}

function actionHealth_() {
  var out = {};
  for (var i = 0; i < SCHEMA.tables.length; i++) {
    var t = SCHEMA.tables[i];
    var cx = ctx_(t, false);
    if (!out[t.db]) { out[t.db] = { tabs_ready: 0, tabs_total: 0 }; }
    out[t.db].tabs_total++;
    if (cx) { out[t.db].tabs_ready++; }
  }
  return ok_(out);
}

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

function handle_(body) {
  try {
    authenticate_(body);
    var result = dispatch_(body);
    return result;
  } catch (e) {
    if (e instanceof AppError) {
      var r = errorResponse_(e.code, e.message);
      if (e.failed_index !== undefined) { r.error.failed_index = e.failed_index; r.error.applied = e.applied; }
      return r;
    }
    // Never leak internals/stack traces; keep only a short non-secret note in the log.
    console.error('INTERNAL_ERROR ' + (e && e.name ? e.name : 'Error'));
    return errorResponse_('INTERNAL_ERROR', 'Internal error');
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '');
  } catch (err) {
    return json_(errorResponse_('VALIDATION_ERROR', 'Body must be valid JSON'));
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json_(errorResponse_('VALIDATION_ERROR', 'Body must be a JSON object'));
  }
  return json_(handle_(body));
}

/** GET is a data-less liveness probe only; data access requires POST + secret. */
function doGet(e) {
  return json_(ok_({ service: 'quantix-sheets-api', status: 'ok' }));
}
