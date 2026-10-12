'use strict';
/**
 * Minimal Google Apps Script runtime emulator used ONLY by the test-suite.
 * It runs the REAL gas/Code.gs inside a vm context against an in-memory model
 * of Google Sheets (cell formats, auto-conversion of non-text cells, row/col
 * limits, last-row tracking) and counts API calls so tests can assert batching.
 * Not shipped to Apps Script.
 */
const vm = require('vm');
const fs = require('fs');
const crypto = require('crypto');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

class Range {
  constructor(sheet, r, c, nr, nc) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error('Range out of bounds (args)');
    this.s = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc;
  }
  _check() {
    if (this.r + this.nr - 1 > this.s.maxRows || this.c + this.nc - 1 > this.s.maxCols) {
      throw new Error(`Range out of bounds: sheet ${this.s.name} ${this.r}+${this.nr} / ${this.c}+${this.nc} (max ${this.s.maxRows}x${this.s.maxCols})`);
    }
  }
  getValues() {
    this._check(); this.s.book.stats.getValues++; this.s.book.stats.cellsRead += this.nr * this.nc;
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.s.rows[this.r - 1 + i] || [];
      const o = new Array(this.nc);
      for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; o[j] = v === undefined ? '' : v; }
      out.push(o);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    this._check(); this.s.book.stats.setValues++; this.s.book.stats.cellsWritten += this.nr * this.nc;
    if (!Array.isArray(vals) || vals.length !== this.nr || vals.some((x) => !Array.isArray(x) || x.length !== this.nc)) {
      throw new Error('setValues: data dimensions do not match range');
    }
    let any = false;
    for (let i = 0; i < this.nr; i++) {
      const rr = this.r - 1 + i;
      if (!this.s.rows[rr]) this.s.rows[rr] = [];
      for (let j = 0; j < this.nc; j++) {
        const cc = this.c - 1 + j;
        const stored = this.s._convert(rr + 1, cc + 1, vals[i][j]);
        this.s.rows[rr][cc] = stored;
        if (stored !== '' && stored !== undefined) any = true;
      }
    }
    if (any) {
      this.s.lastRow = Math.max(this.s.lastRow, this.r + this.nr - 1);
      this.s.lastCol = Math.max(this.s.lastCol, this.c + this.nc - 1);
    }
    return this;
  }
  setNumberFormat(fmt) {
    this._check(); this.s.book.stats.setFormat++;
    this.s.formats.push({ c1: this.c, c2: this.c + this.nc - 1, r1: this.r, r2: this.r + this.nr - 1, fmt });
    return this;
  }
  setFontWeight() { return this; }
}

class Sheet {
  constructor(book, name) {
    this.book = book; this.name = name; this.rows = []; this.maxRows = 1000; this.maxCols = 26;
    this.formats = []; this.lastRow = 0; this.lastCol = 0; this.frozen = 0;
  }
  getName() { return this.name; }
  getLastRow() { this.book.stats.getLastRow++; return this.lastRow; }
  getLastColumn() { return this.lastCol; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getFrozenRows() { return this.frozen; }
  setFrozenRows(n) { this.frozen = n; }
  getRange(r, c, nr, nc) { this.book.stats.getRange++; return new Range(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc); }
  insertRowsAfter(after, n) {
    // inserted rows inherit the formatting of the row above (like Sheets)
    for (const f of this.formats) if (f.r2 >= after) f.r2 += n;
    this.maxRows += n;
  }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  deleteRows(pos, count) {
    this.book.stats.deleteRows++;
    this.rows.splice(pos - 1, count);
    this.maxRows -= count;
    for (const f of this.formats) if (f.r2 >= pos) f.r2 = Math.max(f.r1, f.r2 - count);
    let lr = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) { if ((this.rows[i] || []).some((v) => v !== '' && v !== undefined)) { lr = i + 1; break; } }
    this.lastRow = lr;
  }
  _fmt(r, c) {
    for (let i = this.formats.length - 1; i >= 0; i--) {
      const f = this.formats[i];
      if (c >= f.c1 && c <= f.c2 && r >= f.r1 && r <= f.r2) return f.fmt;
    }
    return null;
  }
  _convert(r, c, v) {
    if (v === null || v === undefined) return '';
    if (this._fmt(r, c) === '@') return typeof v === 'string' ? v : String(v);
    // Automatic type detection like the real Sheets UI/API on non-text cells.
    if (typeof v === 'string') {
      if (v.startsWith('=')) return '#FORMULA:' + v; // would be evaluated by Sheets
      if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
      if (ISO_RE.test(v)) return new Date(v);
      if (v === 'TRUE') return true;
      if (v === 'FALSE') return false;
    }
    return v;
  }
}

class Spreadsheet {
  constructor(book, id) { this.book = book; this.id = id; this.sheets = [new Sheet(book, 'Sheet1')]; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(this.book, n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
}

class Book {
  constructor() {
    this.sheets = {}; this.props = {}; this.lockHeld = false; this.lockBusy = false; this.logs = [];
    this.stats = this.freshStats();
  }
  freshStats() { return { getRange: 0, getValues: 0, setValues: 0, setFormat: 0, getLastRow: 0, deleteRows: 0, cellsRead: 0, cellsWritten: 0 }; }
  resetStats() { this.stats = this.freshStats(); }
  ss(id) { if (!this.sheets[id]) this.sheets[id] = new Spreadsheet(this, id); return this.sheets[id]; }
}

function load(codePath, book, propsInit) {
  book.props = Object.assign({}, propsInit || {});
  const sandbox = {
    console: { error: (m) => book.logs.push('E:' + m), log: (m) => book.logs.push('L:' + m), warn: (m) => book.logs.push('W:' + m) },
    SpreadsheetApp: { openById: (id) => { if (!/^[A-Za-z0-9_-]+$/.test(id) || id.startsWith('MISSING')) throw new Error('No access'); return book.ss(id); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in book.props ? book.props[k] : null) }) },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (book.lockBusy || book.lockHeld) return false; book.lockHeld = true; return true; },
        releaseLock: () => { book.lockHeld = false; },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }),
    },
    Utilities: { getUuid: () => crypto.randomUUID() },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(codePath, 'utf8') + '\n;this.__exports = { doPost, doGet, initializeQuantixDatabase, checkConfiguration, SCHEMA };', ctx, { filename: 'Code.gs' });
  return ctx.__exports;
}

module.exports = { load, Book };
