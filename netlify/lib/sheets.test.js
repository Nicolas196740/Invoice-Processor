// Run with: npm test — uses a fake in-memory spreadsheet shaped like the CLASS DEMO sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { weekFromCalendar, toISODate, findFoodSlot } from './sheet-logic.js';
import { sheet, googleApi, CLASS_SPREADSHEET_ID } from './sheets.js';
import { dupKey } from '../../shared/rules.js';

// "2026 Calendar" as Google returns it (dates as serial numbers). 46293 = 2026-09-28.
const serial = (iso) => (Date.UTC(...iso.split('-').map((n, i) => (i === 1 ? n - 1 : +n))) - Date.UTC(1899, 11, 30)) / 86400000;
const CAL = [[], [], [], ['', 'Closing Calendar Mister O1 2026'], [], [], [],
  ['', 'Weeks per Period', 'Period', 'StartDate', 'EndDate'],
  ['', '5 weeks', 'P9', serial('2026-08-24'), serial('2026-09-27')],
  ['', '4 weeks', 'P10', serial('2026-09-28'), serial('2026-10-25')],
  ['', '4 weeks', 'P11', '10/26/26', '11/22/26']]; // text dates work too

test('dates and week tabs match the closing calendar', () => {
  assert.equal(toISODate(serial('2026-09-28')), '2026-09-28');
  assert.equal(weekFromCalendar(CAL, '2026-10-10').name, 'P10W2');
  assert.equal(weekFromCalendar(CAL, '2026-10-15').name, 'P10W3');
  assert.equal(weekFromCalendar(CAL, '2026-09-28').name, 'P10W1');
  assert.equal(weekFromCalendar(CAL, '2026-10-25').name, 'P10W4');
  assert.equal(weekFromCalendar(CAL, '2026-09-27').name, 'P09W5');
  assert.deepEqual(weekFromCalendar(CAL, '2026-11-01'), { name: 'P11W1', period: 11, week: 1 });
  assert.throws(() => weekFromCalendar(CAL, '2027-03-01'), /not in this year/);
});

test('Food slot: first empty row, or full', () => {
  const b = ['', '', '', '', '', 'Category', 'Food', '', '', 'Beverage'];
  assert.deepEqual(findFoodSlot(b, ['', '', '', '', '', 'x', 'GFS 1', '', '', '']), { row: 8 });
  assert.deepEqual(findFoodSlot(b, ['', '', '', '', '', 'x', 'a', 'b', 'c', '']), { full: true, lastRow: 9 });
});

// ───────── fake Google Sheets API ─────────
function fakeSheet() {
  const template = () => {
    const g = Array.from({ length: 30 }, () => ['', '', '', '', '', '']);
    g[3] = ['', 'Mister O1 Boca Raton - Accounting weekly report', '', 2023, 'PX WX', ''];
    g[5] = ['', 'Category', 'Company - Date -  #Invoice', 'Amount', 'Sent By', 'Comments'];
    g[6][1] = 'Food';          // B7:B10 merged
    g[10][1] = 'Beverage';     // B11
    return g;
  };
  const tabs = [
    { title: 'App Log', grid: [[]] },
    { title: '2026 Calendar', grid: CAL },
    { title: 'Template', grid: template() },
  ].map((t, i) => ({ ...t, sheetId: 100 + i }));
  const calls = [];
  const col = (L) => L.charCodeAt(0) - 65;
  const parse = (range) => {
    const m = decodeURIComponent(range).match(/^'(.+)'(?:!([A-Z])(\d+):([A-Z])(\d+))?$/);
    const tab = tabs.find((t) => t.title === m[1]);
    if (!m[2]) return { tab, r0: 0, r1: tab.grid.length - 1, c0: 0, c1: 25 };
    return { tab, r0: +m[3] - 1, r1: +m[5] - 1, c0: col(m[2]), c1: col(m[4]) };
  };
  const read = ({ tab, r0, r1, c0, c1 }) => {
    const out = [];
    for (let r = r0; r <= Math.min(r1, tab.grid.length - 1); r++) out.push((tab.grid[r] || []).slice(c0, c1 + 1));
    return out;
  };
  const api = async (method, path, body) => {
    calls.push(method + ' ' + decodeURIComponent(path));
    if (path.startsWith('?fields')) return { sheets: tabs.map((t, index) => ({ properties: { sheetId: t.sheetId, title: t.title, index } })) };
    if (path.startsWith('/values:batchGet')) {
      const ranges = path.split('?')[1].split('&').filter((p) => p.startsWith('ranges=')).map((p) => p.slice(7));
      return { valueRanges: ranges.map((r) => ({ values: read(parse(r)) })) };
    }
    if (path.startsWith('/values/') && method === 'GET') return { values: read(parse(path.slice(8).split('?')[0])) };
    if (path.startsWith('/values/') && method === 'PUT') {
      const p = parse(path.slice(8).split('?')[0]);
      body.values.forEach((row, i) => row.forEach((v, j) => { p.tab.grid[p.r0 + i][p.c0 + j] = v; }));
      return {};
    }
    if (path === ':batchUpdate') {
      const rq = body.requests[0];
      if (rq.duplicateSheet) {
        const src = tabs.find((t) => t.sheetId === rq.duplicateSheet.sourceSheetId);
        tabs.splice(rq.duplicateSheet.insertSheetIndex, 0,
          { title: rq.duplicateSheet.newSheetName, sheetId: 200 + tabs.length, grid: src.grid.map((r) => r.slice()) });
      }
      if (rq.insertDimension) {
        const t = tabs.find((x) => x.sheetId === rq.insertDimension.range.sheetId);
        t.grid.splice(rq.insertDimension.range.startIndex, 0, ['', '', '', '', '', '']);
      }
      return {};
    }
    throw new Error('fake api: unhandled ' + method + ' ' + path);
  };
  return { api, tabs, calls };
}

test('new week: copies Template right after it, sets D4/E4, writes the first Food row', async () => {
  const f = fakeSheet();
  const sh = sheet(f.api);
  const tab = await sh.getOrCreateWeekTab('2026-10-15');
  assert.equal(tab, 'P10W3');
  assert.deepEqual(f.tabs.map((t) => t.title), ['App Log', '2026 Calendar', 'Template', 'P10W3']);
  const g = f.tabs[3].grid;
  assert.deepEqual([g[3][3], g[3][4]], [2026, 'P10 W3']);
  assert.equal(f.tabs[2].grid[3][3], 2023, 'Template itself is untouched');

  assert.equal(await sh.writeWeekRow(tab, 'GFS 10.15.26 #9041333489', 2520.32, 'NM', ''), 7);
  assert.equal(await sh.writeWeekRow(tab, 'Capri 10.16.26 #16502', 384, 'NM', 'short 1 case'), 8);
  assert.deepEqual(g[7].slice(2), ['Capri 10.16.26 #16502', 384, 'NM', 'short 1 case']);

  // Same week again: reuses the tab, newest tab goes right after Template.
  assert.equal(await sh.getOrCreateWeekTab('2026-10-17'), 'P10W3');
  await sh.getOrCreateWeekTab('2026-10-20');
  assert.deepEqual(f.tabs.map((t) => t.title), ['App Log', '2026 Calendar', 'Template', 'P10W4', 'P10W3']);
});

test('full Food section: inserts a row inside it and keeps the order', async () => {
  const f = fakeSheet();
  const sh = sheet(f.api);
  const tab = await sh.getOrCreateWeekTab('2026-10-15');
  for (let i = 1; i <= 4; i++) await sh.writeWeekRow(tab, 'V' + i + ' 10.15.26 #' + i, i, 'NM', '');
  assert.equal(await sh.writeWeekRow(tab, 'V5 10.15.26 #5', 5, 'NM', ''), 11);
  const g = f.tabs.find((t) => t.title === tab).grid;
  assert.deepEqual(g.slice(6, 12).map((r) => r[2]), ['V1 10.15.26 #1', 'V2 10.15.26 #2', 'V3 10.15.26 #3', 'V4 10.15.26 #4', 'V5 10.15.26 #5', '']);
  assert.equal(g[11][1], 'Beverage', 'Beverage section moved down one row, not overwritten');
});

test('duplicates are found in the weekly tabs (old Wynwood name = Warehouse)', async () => {
  const f = fakeSheet();
  const sh = sheet(f.api);
  const tab = await sh.getOrCreateWeekTab('2026-10-10');
  await sh.writeWeekRow(tab, 'Wynwood 10.10.26 #003885', 1445.85, 'NM', '');
  assert.deepEqual(await sh.findDuplicate(dupKey('Warehouse', '3885')), { tab: 'P10W2', row: 7 });
  assert.equal(await sh.findDuplicate(dupKey('Warehouse', '3886')), null);
});

test('refuses any spreadsheet except the CLASS DEMO sheet (and never the old TEST LOG)', () => {
  assert.throws(() => googleApi('1IgetoijtxOSRaltXSUMFxuPXQDh7vvQ9Eocrkkv-Xr0'), /Refusing/);
  assert.throws(() => googleApi('some-other-spreadsheet-id'), /Refusing/);
  assert.doesNotThrow(() => googleApi(CLASS_SPREADSHEET_ID));
  assert.doesNotThrow(() => googleApi());
});
