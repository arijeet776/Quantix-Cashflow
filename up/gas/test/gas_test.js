'use strict';
// Tests the REAL gas/Code.gs against the Sheets emulator.   node gas/test/gas_test.js
const path = require('path');
const { load, Book } = require('./emulator');

const SECRET = 's'.repeat(40);
const IDS = { core: 'CORE_T', tracking: 'TRACK_T', finance: 'FIN_T' };
let book, gs, pass = 0, fail = 0;

function fresh() {
  book = new Book();
  gs = load(path.join(__dirname, '..', 'Code.gs'), book, {
    CORE_SPREADSHEET_ID: IDS.core, TRACKING_SPREADSHEET_ID: IDS.tracking, FINANCE_SPREADSHEET_ID: IDS.finance, API_SECRET: SECRET,
  });
}
function call(req, secret = SECRET) {
  const body = JSON.stringify(Object.assign({ secret }, req));
  return JSON.parse(gs.doPost({ postData: { contents: body } }).getContent());
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name); } else { fail++; console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}
const J = (x) => JSON.stringify(x);
const iso = (d) => new Date(d).toISOString();

// ---------------------------------------------------------------- 1-4 init
fresh();
let r = gs.initializeQuantixDatabase();
const nTables = gs.SCHEMA.tables.length;
check('1 init creates every tab in all three spreadsheets', r.tabs_created === nTables && Object.keys(r.databases).length === 3, J({ c: r.tabs_created, n: nTables }));
check('1b tabs distributed core/tracking/finance', book.ss(IDS.finance).sheets.map((s) => s.name).sort().join() === 'FinancialLedger,Withdrawals');
check('1c default empty Sheet1 removed', !book.ss(IDS.core).getSheetByName('Sheet1'));
const hdr = book.ss(IDS.finance).getSheetByName('FinancialLedger').rows[0];
check('4 header row exact (ledger)', hdr.slice(0, 5).join() === 'id,ledger_id,idempotency_key,transaction_type,direction' && hdr[hdr.length - 1] === '_extra', hdr.join());
r = gs.initializeQuantixDatabase();
check('3 re-running init is a no-op (no tabs/headers added)', r.tabs_created === 0 && r.headers_added === 0);
check('4b no duplicated headers after re-init', book.ss(IDS.core).getSheetByName('Users').getLastColumn() === gs.SCHEMA.tables.find((t) => t.tab === 'Users').columns.length);

// existing data survives init + missing-tab creation
fresh();
gs.initializeQuantixDatabase();
call({ action: 'create', table: 'Settings', data: { key: 'k1', value: 'v1' } });
book.ss(IDS.core).deleteSheet(book.ss(IDS.core).getSheetByName('Users')); // tab goes missing
r = gs.initializeQuantixDatabase();
check('2 missing tab is re-created, only that one', r.tabs_created === 1);
const got = call({ action: 'find_one', table: 'Settings', filters: { key: 'k1' } });
check('3b existing rows untouched by re-init', got.success && got.data.value === 'v1');
// extra user-added column and a schema column missing from an older sheet
const st = book.ss(IDS.core).getSheetByName('Settings');
st.rows[0][1] = 'renamed_to_unknown'; // simulate an older sheet lacking "key" header
r = gs.initializeQuantixDatabase();
check('2b missing header appended at the end, nothing overwritten', r.headers_added === 1 && st.rows[0][1] === 'renamed_to_unknown' && st.rows[0][st.getLastColumn() - 1] === 'key');
// refuse to overwrite a headerless sheet that already has data
fresh();
const ss = book.ss(IDS.core); const bad = ss.insertSheet('Users'); bad.getRange(2, 1, 1, 1).setValues([['hello']]);
let threw = null; try { gs.initializeQuantixDatabase(); } catch (e) { threw = e; }
check('2c sheet with data but no header is never overwritten', threw && threw.code === 'SCHEMA_CONFLICT' && bad.rows[1][0] === 'hello');

// ----------------------------------------------------------- auth/validation
fresh();
gs.initializeQuantixDatabase();
r = call({ action: 'count', table: 'Users' }, 'wrong-secret');
check('24 invalid secret -> UNAUTHORIZED, no data', !r.success && r.error.code === 'UNAUTHORIZED' && !J(r).includes(SECRET));
r = JSON.parse(gs.doPost({ postData: { contents: J({ action: 'count', table: 'Users' }) } }).getContent());
check('23 missing secret -> UNAUTHORIZED', r.error.code === 'UNAUTHORIZED');
r = JSON.parse(gs.doPost({ postData: { contents: 'not json' } }).getContent());
check('23b malformed body -> VALIDATION_ERROR (no stack)', r.error.code === 'VALIDATION_ERROR' && !J(r).includes('at '));
r = call({ action: 'count', table: 'NotATable' });
check('25 invalid table rejected', r.error.code === 'INVALID_TABLE');
r = call({ action: 'count', table: '../../etc' });
check('25b path-like table rejected', r.error.code === 'INVALID_TABLE');
r = call({ action: 'drop_everything', table: 'Users' });
check('26 invalid action rejected', r.error.code === 'INVALID_ACTION');
book.props.API_SECRET = 'short'; r = call({ action: 'ping' }, 'short');
check('23c too-short configured secret is refused', r.error.code === 'NOT_CONFIGURED'); book.props.API_SECRET = SECRET;
r = JSON.parse(gs.doGet({}).getContent());
check('23d GET exposes liveness only', r.success && Object.keys(r.data).sort().join() === 'service,status');
check('23e checkConfiguration never returns values', !J(gs.checkConfiguration()).includes(SECRET));
check('24b no secret in logs', !book.logs.join('\n').includes(SECRET));

// ------------------------------------------------------------------- CRUD
fresh(); gs.initializeQuantixDatabase();
const t0 = iso('2026-10-01T10:00:00Z');
r = call({ action: 'create', table: 'Users', data: { email: 'a@x.com', role: 'publisher', account_status: 'pending', email_verified: false, password_hash: 'h', created_at: t0, updated_at: t0 } });
check('6 create returns doc with generated 24-hex _id', r.success && /^[0-9a-f]{24}$/.test(r.data._id), J(r));
const uid = r.data._id;
r = call({ action: 'get', table: 'Users', id: uid });
check('7 read by id', r.data.email === 'a@x.com' && r.data.email_verified === false && r.data.created_at === t0, J(r));
r = call({ action: 'create', table: 'Users', data: { email: 'a@x.com', role: 'manager' } });
check('5 duplicate unique value prevented', r.error && r.error.code === 'DUPLICATE_KEY');
check('5b duplicate left no row behind', call({ action: 'count', table: 'Users' }).data.count === 1);
r = call({ action: 'update', table: 'Users', id: uid, update: { $set: { account_status: 'active' } } });
check('8 update by id', r.success && r.data.modified === 1 && r.data.data.account_status === 'active');
check('8b other fields preserved after update', r.data.data.email === 'a@x.com' && r.data.data.created_at === t0);
r = call({ action: 'update', table: 'Users', id: uid, update: { $set: { email: 'dup@x.com' } } });
call({ action: 'create', table: 'Users', data: { email: 'b@x.com', role: 'publisher' } });
r = call({ action: 'update', table: 'Users', id: uid, update: { $set: { email: 'b@x.com' } } });
check('5c update into an existing unique value refused', r.error && r.error.code === 'DUPLICATE_KEY');
r = call({ action: 'update', table: 'Users', id: uid, update: { $set: { _id: 'x'.repeat(24) } } });
check('8c _id is immutable', r.error && r.error.code === 'VALIDATION_ERROR');
r = call({ action: 'delete', table: 'Users', id: uid });
check('9 delete by id', r.success && r.data.deleted === 1 && call({ action: 'get', table: 'Users', id: uid }).data === null);

// unknown fields survive in _extra and round-trip; nested json
r = call({ action: 'create', table: 'Clicks', data: { quantix_click_id: 'QXC1', campaign_id: 'CAMP1', publisher_id: '1111', ip: '1.1.1.1', original_params: { p1: 'a', nested: { k: [1, 2] } }, click_created_at: t0, brand_new_field: 'zzz' } });
r = call({ action: 'find_one', table: 'Clicks', filters: { quantix_click_id: 'QXC1' } });
check('6b nested JSON column round-trips', J(r.data.original_params) === J({ p1: 'a', nested: { k: [1, 2] } }));
check('6c unknown field preserved via _extra', r.data.brand_new_field === 'zzz');
check('6d Mongo-style dotted query into JSON column', call({ action: 'count', table: 'Clicks', filters: { 'original_params.p1': 'a' } }).data.count === 1);
check('6e query on field living in _extra', call({ action: 'count', table: 'Clicks', filters: { brand_new_field: 'zzz' } }).data.count === 1);

// formats: text columns stay text (ISO date, formula-looking text, leading zeros)
call({ action: 'create', table: 'Clicks', data: { quantix_click_id: 'QXC2', campaign_id: '=HYPERLINK("x")', publisher_id: '0042', ip: '2.2.2.2', click_created_at: iso('2026-10-02T00:00:00Z') } });
const dump = book.ss(IDS.tracking).getSheetByName('Clicks');
const cidx = dump.rows[0].indexOf('campaign_id'), pidx = dump.rows[0].indexOf('publisher_id'), tidx = dump.rows[0].indexOf('click_created_at');
check('formula-looking text is stored as text, not evaluated', dump.rows[2][cidx] === '=HYPERLINK("x")');
check('leading-zero id stays text', dump.rows[2][pidx] === '0042');
check('ISO timestamp stays text (not auto-converted to a date)', typeof dump.rows[2][tidx] === 'string');

// --------------------------------------------------- query/pagination/sort
fresh(); gs.initializeQuantixDatabase();
const rows = [];
for (let i = 1; i <= 250; i++) {
  rows.push({ quantix_click_id: 'QX' + String(i).padStart(4, '0'), campaign_id: i % 2 ? 'CAMP1' : 'CAMP2', publisher_id: i % 5 === 0 ? '9999' : '1111', ip: '10.0.0.' + (i % 7), click_created_at: iso(Date.UTC(2026, 9, 1) + i * 3600000) });
}
book.resetStats();
r = call({ action: 'create', table: 'Clicks', rows });
const writeStats = Object.assign({}, book.stats);
check('12 batch write of 250 rows uses ONE setValues call', r.success && writeStats.setValues === 1, J(writeStats));
r = call({ action: 'query', table: 'Clicks', filters: {}, page: 1, limit: 100 });
check('11 pagination page 1', r.data.length === 100 && r.pagination.total === 250 && r.pagination.pages === 3 && r.pagination.page === 1);
r = call({ action: 'query', table: 'Clicks', filters: {}, page: 3, limit: 100 });
check('11b last page has remainder', r.data.length === 50 && r.data[0].quantix_click_id === 'QX0201');
r = call({ action: 'query', table: 'Clicks', filters: { publisher_id: '9999' }, sort: { click_created_at: -1 }, limit: 5 });
check('10 filter + sort desc', r.pagination.total === 50 && r.data[0].quantix_click_id === 'QX0250', J(r.data.map((d) => d.quantix_click_id)));
r = call({ action: 'query', table: 'Clicks', filters: { click_created_at: { $gte: iso(Date.UTC(2026, 9, 1) + 100 * 3600000), $lt: iso(Date.UTC(2026, 9, 1) + 110 * 3600000) } }, limit: 100 });
check('10b date range ($gte/$lt) exact', r.pagination.total === 10 && r.data[0].quantix_click_id === 'QX0100');
r = call({ action: 'query', table: 'Clicks', filters: { $or: [{ ip: '10.0.0.3' }, { quantix_click_id: { $regex: '^QX0001' } }], campaign_id: { $in: ['CAMP1'] } }, limit: 1000 });
check('10c $or/$in/$regex combine', r.data.every((d) => d.campaign_id === 'CAMP1') && r.data.length > 0, J(r.pagination));
r = call({ action: 'query', table: 'Clicks', filters: { ip: { $nin: ['10.0.0.1', '10.0.0.2'] }, publisher_id: { $ne: '9999' } }, limit: 1000 });
check('10d $nin/$ne', r.data.every((d) => d.ip !== '10.0.0.1' && d.ip !== '10.0.0.2' && d.publisher_id !== '9999'));
r = call({ action: 'query', table: 'Clicks', filters: { quantix_click_id: { $regex: 'qx0007', $options: 'i' } } });
check('10e case-insensitive regex', r.data.length === 1);
r = call({ action: 'query', table: 'Clicks', filters: { quantix_click_id: { $regex: '(' } } });
check('10f bad regex -> VALIDATION_ERROR (no crash)', r.error.code === 'VALIDATION_ERROR');
r = call({ action: 'query', table: 'Clicks', filters: { $where: '1==1' } });
check('10g unsupported operator ($where) refused', r.error.code === 'VALIDATION_ERROR');
r = call({ action: 'query', table: 'Clicks', limit: 99999 });
check('11c limit clamped to MAX_LIMIT', r.pagination.limit === 1000);
r = call({ action: 'query', table: 'Clicks', filters: { publisher_id: '1111' }, projection: { quantix_click_id: 1 }, limit: 2 });
check('10h projection', Object.keys(r.data[0]).sort().join() === '_id,quantix_click_id');
// column-first: filtered query must NOT read full-width rows of every record
book.resetStats();
r = call({ action: 'query', table: 'Clicks', filters: { publisher_id: '9999' }, limit: 10 });
const colCells = book.stats.cellsRead;
const width = gs.SCHEMA.tables.find((t) => t.tab === 'Clicks').columns.length;
check('7b filtered query reads far fewer cells than a full scan', colCells < 250 * width / 3, `read ${colCells} vs full ${250 * width}`);
// sum / count
r = call({ action: 'count', table: 'Clicks', filters: { campaign_id: 'CAMP1' } });
check('count with filter', r.data.count === 125);

// multi-update / delete many
r = call({ action: 'update', table: 'Clicks', filters: { publisher_id: '9999' }, many: true, update: { $set: { city: 'Pune' } } });
check('8d update many', r.data.modified === 50 && call({ action: 'count', table: 'Clicks', filters: { city: 'Pune' } }).data.count === 50);
r = call({ action: 'update', table: 'Clicks', filters: { quantix_click_id: 'QX0001' }, update: { $inc: { config_version: 2 } } });
check('8e $inc on missing numeric', r.data.data.config_version === 2);
r = call({ action: 'delete', table: 'Clicks', filters: { city: 'Pune' }, many: true });
check('9b delete many (contiguous groups)', r.data.deleted === 50 && call({ action: 'count', table: 'Clicks' }).data.count === 200);
check('9c remaining rows intact after deletes', call({ action: 'get', table: 'Clicks', id: call({ action: 'find_one', table: 'Clicks', filters: { quantix_click_id: 'QX0003' } }).data._id }).data.quantix_click_id === 'QX0003');

// -------------------------------------------------------- atomic updates
fresh(); gs.initializeQuantixDatabase();
call({ action: 'create', table: 'Conversions', data: { conversion_id: 'CV1', idempotency_key: 'k1', campaign_id: 'C1', approval_status: 'pending_report', payout: 10, conversion_created_at: t0 } });
r = call({ action: 'find_one_and_update', table: 'Conversions', filters: { conversion_id: 'CV1', approval_status: { $in: ['pending_report'] } }, update: { $set: { approval_status: 'confirmed' } }, return_document: 'after' });
check('atomic transition succeeds once', r.success && r.data.approval_status === 'confirmed');
r = call({ action: 'find_one_and_update', table: 'Conversions', filters: { conversion_id: 'CV1', approval_status: { $in: ['pending_report'] } }, update: { $set: { approval_status: 'rejected' } }, return_document: 'after' });
check('second transition from the old state is refused (null)', r.success && r.data === null);
r = call({ action: 'find_one_and_update', table: 'Settings', filters: { key: 'accent' }, update: { $set: { value: 'blue' }, $setOnInsert: { key: 'accent', created_at: t0 } }, upsert: true, return_document: 'after' });
check('upsert inserts with $setOnInsert', r.data.key === 'accent' && r.data.value === 'blue');
r = call({ action: 'find_one_and_update', table: 'Settings', filters: { key: 'accent' }, update: { $set: { value: 'red' }, $setOnInsert: { key: 'accent', created_at: 'zzz' } }, upsert: true, return_document: 'after' });
check('upsert updates existing, $setOnInsert ignored, still one row', r.data.value === 'red' && r.data.created_at === t0 && call({ action: 'count', table: 'Settings' }).data.count === 1);
call({ action: 'create', table: 'SupportTickets', data: { ticket_id: 'T1', messages: [{ body: 'hi' }] } });
call({ action: 'update', table: 'SupportTickets', filters: { ticket_id: 'T1' }, update: { $push: { messages: { body: 'again' } } } });
check('$push appends to JSON array', call({ action: 'find_one', table: 'SupportTickets', filters: { ticket_id: 'T1' } }).data.messages.length === 2);

// ----------------------------------------------------------- concurrency
fresh(); gs.initializeQuantixDatabase();
book.lockBusy = true;
r = call({ action: 'create', table: 'Settings', data: { key: 'x', value: '1' } });
check('13 write while locked -> SERVER_BUSY, nothing written', r.error.code === 'SERVER_BUSY');
book.lockBusy = false;
check('13b busy-lock write left no row', call({ action: 'count', table: 'Settings' }).data.count === 0);
r = call({ action: 'create', table: 'Settings', data: { key: 'x', value: '1' } });
check('13c lock released after success', r.success && !book.lockHeld);
call({ action: 'create', table: 'Settings', data: { key: 'x', value: '2' } });
check('13d lock released after a failing write', !book.lockHeld);
const results = [];
for (let i = 0; i < 40; i++) results.push(call({ action: 'create', table: 'Settings', data: { key: 'same', value: String(i) } }));
check('14 40 racing creates of one unique key -> exactly one wins', results.filter((x) => x.success).length === 1 && call({ action: 'count', table: 'Settings', filters: { key: 'same' } }).data.count === 1);
const ids = new Set();
for (let i = 0; i < 200; i++) ids.add(call({ action: 'create', table: 'Settings', data: { key: 'k' + i } }).data._id);
check('14b 200 generated _ids are all unique', ids.size === 200);

// ----------------------------------------------------- finance: ledger etc
fresh(); gs.initializeQuantixDatabase();
const P = '4821';
const led = (key, type, dir, amt, extra) => Object.assign({ ledger_id: 'LDG' + key, idempotency_key: key, transaction_type: type, direction: dir, publisher_id: P, amount: amt, currency: 'INR', status: 'posted', source: 'conversion_engine', created_at: t0, effective_at: t0 }, extra || {});
r = call({ action: 'create', table: 'FinancialLedger', data: led('earning:CV1', 'earning', 'credit', '100.00', { conversion_id: 'CV1' }) });
check('15 ledger entry created with autoinc id=1', r.success && r.data.id === 1, J(r));
call({ action: 'create', table: 'FinancialLedger', data: led('earning:CV2', 'earning', 'credit', '250.50', { conversion_id: 'CV2' }) });
r = call({ action: 'create', table: 'FinancialLedger', data: led('earning:CV2', 'earning', 'credit', '9.00') });
check('15b duplicate idempotency_key refused (ledger idempotency)', r.error.code === 'DUPLICATE_KEY');
call({ action: 'create', table: 'FinancialLedger', data: led('reversal:CV1', 'earning_reversal', 'debit', '100', { conversion_id: 'CV1' }) });
call({ action: 'create', table: 'FinancialLedger', data: led('other', 'earning', 'credit', '5.00', { publisher_id: '7777' }) });
r = call({ action: 'ledger_summary', filters: { publisher_id: P } });
check('16 wallet computed from ledger rows (credits-debits)', r.data.total_credits === '350.50' && r.data.total_debits === '100.00' && r.data.total_earned === '350.50' && r.data.total_reversed === '100.00', J(r));
check('16b other publisher excluded', call({ action: 'ledger_summary', filters: { publisher_id: '7777' } }).data.total_credits === '5.00');
check('16c network-wide summary', call({ action: 'ledger_summary', filters: {} }).data.total_credits === '355.50');
check('16d no float drift (0.1+0.2 style)', (() => { call({ action: 'create', table: 'FinancialLedger', data: led('f1', 'adjustment_credit', 'credit', '0.10', { publisher_id: '5555' }) }); call({ action: 'create', table: 'FinancialLedger', data: led('f2', 'adjustment_credit', 'credit', '0.20', { publisher_id: '5555' }) }); return call({ action: 'ledger_summary', filters: { publisher_id: '5555' } }).data.total_credits === '0.30'; })());
r = call({ action: 'update', table: 'FinancialLedger', id: 'LDGearning:CV1', update: { $set: { amount: '1.00' } } });
check('15c ledger is append-only: update refused', r.error.code === 'FORBIDDEN_TABLE_OPERATION');
r = call({ action: 'delete', table: 'FinancialLedger', id: 'LDGearning:CV1' });
check('15d ledger is append-only: delete refused', r.error.code === 'FORBIDDEN_TABLE_OPERATION');
r = call({ action: 'create', table: 'FinancialLedger', data: led('bad', 'earning', 'credit', 'abc') });
check('15e non-numeric money rejected', r.error.code === 'VALIDATION_ERROR');
call({ action: 'create', table: 'FinancialLedger', data: led('void', 'earning', 'credit', '999.00', { status: 'voided' }) });
check('16e voided entries ignored by the projection', call({ action: 'ledger_summary', filters: { publisher_id: P } }).data.total_credits === '350.50');

// withdrawal flow = one atomic batch
const wdBatch = (wid, amount) => ({ action: 'batch', operations: [
  { op: 'guard', type: 'balance_gte', publisher_id: P, amount },
  { op: 'create', table: 'Withdrawals', as: 'w', data: { withdrawal_id: wid, idempotency_key: 'idem-' + wid, publisher_id: P, amount, currency: 'INR', status: 'requested', requested_at: t0, updated_at: t0 } },
  { op: 'create', table: 'FinancialLedger', data: led('withdrawal_hold:' + wid, 'withdrawal_hold', 'debit', amount, { withdrawal_id: wid, source: 'withdrawal_engine' }) },
] });
r = call(wdBatch('WD1', '200.00'));
check('17 withdrawal request (balance check + row + hold) in one batch', r.success && r.data[1].status === 'requested', J(r));
check('17b hold reduces available balance', (() => { const s = call({ action: 'ledger_summary', filters: { publisher_id: P } }).data; return (parseFloat(s.total_credits) - parseFloat(s.total_debits)).toFixed(2) === '50.50' && s.total_held_ever === '200.00'; })());
r = call(wdBatch('WD2', '100.00'));
check('17c over-balance request refused, nothing written', r.error.code === 'INSUFFICIENT_BALANCE' && call({ action: 'count', table: 'Withdrawals' }).data.count === 1 && call({ action: 'count', table: 'FinancialLedger', filters: { withdrawal_id: 'WD2' } }).data.count === 0);
r = call({ action: 'batch', operations: [
  { op: 'find_one_and_update', table: 'Withdrawals', as: 'w', filters: { withdrawal_id: 'WD1', status: { $in: ['requested', 'under_review'] } }, update: { $set: { status: 'rejected', rejection_reason: 'no', reviewed_by: 'sa', updated_at: t0 } }, return_document: 'after' },
  { op: 'create', table: 'FinancialLedger', if: 'w', data: led('withdrawal_release:WD1', 'withdrawal_release', 'credit', '$w.amount', { withdrawal_id: 'WD1', publisher_id: '$w.publisher_id', source: 'withdrawal_engine' }) },
] });
check('17d reject = status change + release in one atomic batch, amount taken from the row', r.success && r.data[0].status === 'rejected' && r.data[1].amount === '200.00' && r.data[1].publisher_id === P, J(r));
check('17e funds are available again', (() => { const s = call({ action: 'ledger_summary', filters: { publisher_id: P } }).data; return (parseFloat(s.total_credits) - parseFloat(s.total_debits)).toFixed(2) === '250.50'; })());
r = call({ action: 'batch', operations: [
  { op: 'find_one_and_update', table: 'Withdrawals', as: 'w', filters: { withdrawal_id: 'WD1', status: { $in: ['requested', 'under_review'] } }, update: { $set: { status: 'rejected' } }, return_document: 'after' },
  { op: 'create', table: 'FinancialLedger', if: 'w', data: led('withdrawal_release:WD1x', 'withdrawal_release', 'credit', '1.00') },
] });
check('17f repeating the reject is a no-op: second release is skipped', r.success && r.data[0] === null && r.data[1].skipped === true && call({ action: 'count', table: 'FinancialLedger', filters: { transaction_type: 'withdrawal_release' } }).data.count === 1);
r = call(wdBatch('WD3', '100.00')); // request again, then approve + pay
call({ action: 'update', table: 'Withdrawals', filters: { withdrawal_id: 'WD3', status: 'requested' }, update: { $set: { status: 'approved', reviewed_by: 'sa' } } });
r = call({ action: 'find_one_and_update', table: 'Withdrawals', filters: { withdrawal_id: 'WD3', status: 'approved' }, update: { $set: { status: 'paid', paid_by: 'sa', reference: 'UTR123' } }, return_document: 'after' });
check('18 payment record: withdrawal marked paid with reference', r.data.status === 'paid' && r.data.reference === 'UTR123' && r.data.paid_by === 'sa');
check('18b paid is not re-payable', call({ action: 'find_one_and_update', table: 'Withdrawals', filters: { withdrawal_id: 'WD3', status: 'approved' }, update: { $set: { status: 'paid' } }, return_document: 'after' }).data === null);
r = call({ action: 'sum', table: 'Withdrawals', field: 'amount', filters: { status: 'paid' } });
check('18c server-side money sum', r.data.sum === '100.00' && r.data.count === 1);
r = call({ action: 'sum', table: 'FinancialLedger', field: 'amount', filters: { publisher_id: P, status: 'posted' }, group_by: ['transaction_type'] });
check('15f group_by sum', r.data.groups.some((g) => g.key[0] === 'earning' && g.sum === '350.50'), J(r.data.groups));
r = call({ action: 'create', table: 'Withdrawals', data: { withdrawal_id: 'WD4', idempotency_key: 'idem-WD3', publisher_id: P, amount: '100', status: 'requested' } });
check('17g duplicate withdrawal idempotency_key refused', r.error.code === 'DUPLICATE_KEY');
r = call({ action: 'update', table: 'Withdrawals', id: 'WD1', update: { $set: { withdrawal_id: 'HACK' } } });
check('17h withdrawal_id immutable', r.error.code === 'VALIDATION_ERROR');
r = call({ action: 'batch', operations: [{ op: 'create', table: 'Settings', data: { key: 'ok-in-batch' } }, { op: 'create', table: 'Settings', data: { key: 'ok-in-batch' } }] });
check('12b batch failure reports failed_index + applied (for compensation)', r.error.code === 'DUPLICATE_KEY' && r.error.failed_index === 1 && r.error.applied.length === 1);

// ------------------------------------------------- postbacks/convs/audit
fresh(); gs.initializeQuantixDatabase();
r = call({ action: 'create', table: 'PublisherPostbackConfigs', data: { publisher_id: P, campaign_id: null, version: 1, url_template: 'https://x/?c={click_id}', macros_selected: ['click_id'], enabled: true, deleted: false, created_at: t0 } });
call({ action: 'create', table: 'PublisherPostbackConfigs', data: { publisher_id: P, campaign_id: 'C1', version: 1, url_template: 'https://y/', enabled: true, created_at: t0 } });
call({ action: 'create', table: 'PublisherPostbackConfigs', data: { publisher_id: P, campaign_id: 'C1', version: 2, url_template: 'https://y/', enabled: false, created_at: t0 } });
r = call({ action: 'find_one', table: 'PublisherPostbackConfigs', filters: { publisher_id: P, campaign_id: null }, sort: { version: -1 } });
check('19 global (null campaign) postback config found by null filter', r.data && r.data.url_template.includes('{click_id}') && r.data.macros_selected[0] === 'click_id', J(r));
r = call({ action: 'find_one', table: 'PublisherPostbackConfigs', filters: { publisher_id: P, campaign_id: 'C1' }, sort: { version: -1 } });
check('19b latest campaign version wins (sort desc)', r.data.version === 2 && r.data.enabled === false);
r = call({ action: 'create', table: 'OutboundPostbacks', data: { outbound_id: 'OB1', conversion_id: 'CV1', publisher_id: P, url: 'https://x/?c=1', attempts: [{ attempt: 1, http_status: 200, sent_at: { $date: t0 } }], attempt_count: 1, final_status: 'delivered', created_at: t0 } });
check('19c postback log persisted with attempts array', call({ action: 'find_one', table: 'OutboundPostbacks', filters: { conversion_id: 'CV1' } }).data.attempts[0].http_status === 200);
call({ action: 'create', table: 'Conversions', data: { conversion_id: 'CV9', idempotency_key: 'i9', quantix_click_id: 'QXC9', event: 'KYC', payout: 25.5, status: 'approved', sub_ids: { p1: 'a' }, conversion_created_at: t0, suspicious_velocity: false } });
r = call({ action: 'find_one', table: 'Conversions', filters: { quantix_click_id: 'QXC9' } });
check('21 conversion record: numbers/bools/json typed correctly', r.data.payout === 25.5 && r.data.suspicious_velocity === false && r.data.sub_ids.p1 === 'a' && r.data.event === 'KYC');
call({ action: 'create', table: 'AuditLogs', data: { action: 'PUBLISHER_APPROVED', actor_user_id: 'u1', target_user_id: 'u2', before: { s: 'pending' }, after: { s: 'active' }, metadata: { k: 1 }, timestamp: t0 } });
r = call({ action: 'query', table: 'AuditLogs', filters: { action: 'PUBLISHER_APPROVED' } });
check('22 audit record stored and queryable, before/after intact', r.data.length === 1 && r.data[0].after.s === 'active' && r.data[0].actor_user_id === 'u1');

// --------------------------------------------------------- large dataset
fresh(); gs.initializeQuantixDatabase();
const big = [];
for (let i = 0; i < 6000; i++) big.push({ quantix_click_id: 'B' + i, campaign_id: 'C' + (i % 10), publisher_id: 'P' + (i % 50), ip: '9.9.9.' + (i % 255), click_created_at: iso(Date.UTC(2026, 9, 1) + i * 60000), original_params: { p1: 'v' + i } });
for (let off = 0; off < big.length; off += 500) { const x = call({ action: 'create', table: 'Clicks', rows: big.slice(off, off + 500) }); if (!x.success) { check('27 bulk load', false, J(x)); break; } }
book.resetStats();
let t = Date.now();
r = call({ action: 'query', table: 'Clicks', filters: { publisher_id: 'P7', click_created_at: { $gte: iso(Date.UTC(2026, 9, 3)) } }, sort: { click_created_at: -1 }, limit: 50 });
const ms = Date.now() - t;
check('27 6,000-row table: filtered+sorted page correct', r.pagination.total > 0 && r.data.length <= 50 && r.data.every((d) => d.publisher_id === 'P7') && r.data[0].click_created_at >= r.data[r.data.length - 1].click_created_at, J(r.pagination));
check('27b it used a handful of range reads (not per-row)', book.stats.getValues <= 12 && book.stats.getRange <= 14, J(book.stats));
check('27c count over the whole table', call({ action: 'count', table: 'Clicks' }).data.count === 6000);
r = call({ action: 'create', table: 'Clicks', rows: [{ quantix_click_id: 'B5', campaign_id: 'x' }] });
check('27d unique check holds on a large table', r.error.code === 'DUPLICATE_KEY');
call({ action: 'create', table: 'Clicks', rows: [{ quantix_click_id: 'NEWROW', campaign_id: 'x', click_created_at: iso('2026-12-01') }] });
check('27e sheet grows past its initial row count', book.ss(IDS.tracking).getSheetByName('Clicks').maxRows > 6000 && call({ action: 'get', table: 'Clicks', id: call({ action: 'find_one', table: 'Clicks', filters: { quantix_click_id: 'NEWROW' } }).data._id }).data.campaign_id === 'x');
r = call({ action: 'create', table: 'Clicks', rows: new Array(501).fill(0).map((_, i) => ({ quantix_click_id: 'Z' + i })) });
check('27f oversize batch refused', r.error.code === 'VALIDATION_ERROR');
r = call({ action: 'create', table: 'Clicks', data: { quantix_click_id: 'HUGE', user_agent: 'a'.repeat(60000) } });
check('27g oversize cell refused (no truncation)', r.error.code === 'VALUE_TOO_LONG');
console.log(`   (large filtered query took ${ms} ms in the emulator)`);

// human edits: a person reorders columns / edits a cell -> still readable
fresh(); gs.initializeQuantixDatabase();
call({ action: 'create', table: 'Settings', data: { key: 'a', value: 'b' } });
const sh = book.ss(IDS.core).getSheetByName('Settings');
const [h0, h1] = [sh.rows[0][0], sh.rows[0][1]];
sh.rows[0][0] = h1; sh.rows[0][1] = h0; const d0 = sh.rows[1][0]; sh.rows[1][0] = sh.rows[1][1]; sh.rows[1][1] = d0;
check('28 header-position based reads survive manual column reordering', call({ action: 'find_one', table: 'Settings', filters: { key: 'a' } }).data.value === 'b');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
