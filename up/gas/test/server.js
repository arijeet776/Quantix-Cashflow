'use strict';
// Local stand-in for the deployed Apps Script web app (tests only).
const http = require('http');
const path = require('path');
const { load, Book } = require('./emulator');

const book = new Book();
const SECRET = process.env.TEST_API_SECRET || 'test-secret-0123456789abcdef0123456789';
const props = {
  CORE_SPREADSHEET_ID: 'CORE_TEST_SHEET', TRACKING_SPREADSHEET_ID: 'TRACKING_TEST_SHEET', FINANCE_SPREADSHEET_ID: 'FINANCE_TEST_SHEET',
  API_SECRET: SECRET,
};
const gs = load(path.join(__dirname, '..', 'Code.gs'), book, props);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/__stats') { res.end(JSON.stringify(book.stats)); return; }
    if (url.pathname === '/__reset_stats') { book.resetStats(); res.end('{}'); return; }
    if (url.pathname === '/__lock') { book.lockBusy = url.searchParams.get('busy') === '1'; res.end('{}'); return; }
    if (url.pathname === '/__logs') { res.end(JSON.stringify(book.logs)); return; }
    if (url.pathname === '/__props') {
      const p = JSON.parse(body || '{}');
      for (const k of Object.keys(p)) { if (p[k] === null) delete book.props[k]; else book.props[k] = p[k]; }
      res.end('{}'); return;
    }
    if (url.pathname === '/__dump') {
      const ss = book.ss(url.searchParams.get('id')); const sh = ss.getSheetByName(url.searchParams.get('sheet'));
      res.end(JSON.stringify(sh ? { rows: sh.rows.slice(0, sh.lastRow), lastRow: sh.lastRow, maxRows: sh.maxRows, sheets: ss.sheets.map((s) => s.name) } : { sheets: ss.sheets.map((s) => s.name) }));
      return;
    }
    if (url.pathname === '/__poke') { // write a raw cell (simulates a human editing the sheet)
      const p = JSON.parse(body); const sh = book.ss(p.id).getSheetByName(p.sheet);
      sh.getRange(p.row, p.col, 1, 1).setValues([[p.value]]); res.end('{}'); return;
    }
    if (url.pathname === '/__init_direct') { res.end(JSON.stringify(gs.initializeQuantixDatabase())); return; }
    if (req.method === 'GET') { res.end(gs.doGet({}).getContent()); return; }
    res.end(gs.doPost({ postData: { contents: body } }).getContent());
  });
});
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\n');
});
