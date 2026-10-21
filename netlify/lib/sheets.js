/**
 * Google Sheets access (service account + Sheets REST API).
 * HARD LIMIT: this app may only ever touch the CLASS DEMO spreadsheet below.
 */
import { JWT } from 'google-auth-library';
import { weekFromCalendar, findFoodSlot, WEEK_TAB } from './sheet-logic.js';
import { keyFromLabel } from '../../shared/rules.js';

export const CLASS_SPREADSHEET_ID = '1w9fMOnig0XHMxEd7ZW0oLyGhKh-BXXcnA4a3ZPhWduA'; // "Mister O1 Invoices - CLASS DEMO"

// Sheets the class app must never touch, even if someone changes the ID above by mistake.
// (The old TEST LOG is used by the work app.)
const FORBIDDEN_IDS = ['1IgetoijtxOSRaltXSUMFxuPXQDh7vvQ9Eocrkkv-Xr0'];

function assertClassSheet(id) {
  if (FORBIDDEN_IDS.includes(id) || id !== CLASS_SPREADSHEET_ID) {
    throw new Error('Refusing to use any spreadsheet except the CLASS DEMO sheet.');
  }
}

let jwt = null;
function credentials() {
  // Preferred: two short variables (Netlify Functions have a 4KB limit on all variables combined).
  let email = process.env.GOOGLE_SA_EMAIL;
  let key = process.env.GOOGLE_SA_PRIVATE_KEY;
  // Also accepted for local testing: the whole JSON file on one line.
  if ((!email || !key) && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const j = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    email = j.client_email; key = j.private_key;
  }
  if (!email || !key) throw new Error('Missing GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY in the environment variables.');
  return { email, key: key.replace(/\\n/g, '\n') };
}

/** Real Google API caller. Every request is checked against the CLASS DEMO spreadsheet ID. */
export function googleApi(spreadsheetId = CLASS_SPREADSHEET_ID) {
  assertClassSheet(spreadsheetId);
  return async (method, path, body) => {
    assertClassSheet(spreadsheetId);
    if (!jwt) {
      const c = credentials();
      jwt = new JWT({ email: c.email, key: c.key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    }
    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + path;
    const res = await jwt.request({ url, method, data: body, validateStatus: () => true });
    if (res.status >= 400) {
      const msg = (res.data && res.data.error && res.data.error.message) || ('HTTP ' + res.status);
      if (res.status === 403) throw new Error('Google Sheet: no access. Share the CLASS DEMO sheet with the service account email as Editor. (' + msg + ')');
      throw Object.assign(new Error('Google Sheet: ' + msg), { status: res.status });
    }
    return res.data;
  };
}

const q = (tab) => "'" + tab.replace(/'/g, "''") + "'"; // tab name inside a range, e.g. 'P10W3'!C7:D300
const enc = encodeURIComponent;

/** Everything the app needs from the sheet. `api` is googleApi() (or a fake one in tests). */
export function sheet(api) {
  async function tabs() {
    const meta = await api('GET', '?fields=sheets.properties(sheetId,title,index)');
    return meta.sheets.map((s) => s.properties);
  }
  async function values(range) {
    const r = await api('GET', '/values/' + enc(range) + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER');
    return r.values || [];
  }
  async function write(range, rows) {
    return api('PUT', '/values/' + enc(range) + '?valueInputOption=RAW', { range, values: rows });
  }

  /** "2026-10-15" -> { name: "P10W3", period: 10, week: 3 } using the "... Calendar" tab. */
  async function weekInfo(dateStr, allTabs) {
    const cal = (allTabs || await tabs()).find((t) => /calendar/i.test(t.title));
    if (!cal) throw new Error('No calendar tab found in the CLASS DEMO sheet.');
    return weekFromCalendar(await values(q(cal.title)), dateStr);
  }

  /** Looks for the same vendor + invoice digits in column C of every weekly tab. Returns { tab, row } or null. */
  async function findDuplicate(key) {
    const weekTabs = (await tabs()).filter((t) => WEEK_TAB.test(t.title));
    if (!weekTabs.length) return null;
    const ranges = weekTabs.map((t) => 'ranges=' + enc(q(t.title) + '!C7:D300')).join('&');
    const r = await api('GET', '/values:batchGet?' + ranges + '&valueRenderOption=UNFORMATTED_VALUE');
    for (let i = 0; i < weekTabs.length; i++) {
      const rows = (r.valueRanges[i] && r.valueRanges[i].values) || [];
      for (let j = 0; j < rows.length; j++) {
        if (keyFromLabel(rows[j][0]) === key) return { tab: weekTabs[i].title, row: j + 7 };
      }
    }
    return null;
  }

  /** Returns the week tab name, copying "Template" (placed right after it, newest first) if it's a new week. */
  async function getOrCreateWeekTab(dateStr) {
    const all = await tabs();
    const info = await weekInfo(dateStr, all);
    if (all.some((t) => t.title === info.name)) return info.name;
    const tpl = all.find((t) => t.title === 'Template');
    if (!tpl) throw new Error('No "Template" tab found in the CLASS DEMO sheet.');
    try {
      await api('POST', ':batchUpdate', { requests: [{ duplicateSheet: {
        sourceSheetId: tpl.sheetId, insertSheetIndex: tpl.index + 1, newSheetName: info.name } }] });
    } catch (e) {
      // Someone else created it a moment ago: fine, use it.
      if (!/already exists/i.test(e.message)) throw e;
      return info.name;
    }
    await write(q(info.name) + '!D4:E4', [[Number(dateStr.slice(0, 4)), 'P' + info.period + ' W' + info.week]]);
    return info.name;
  }

  /** Writes label | total | initials | comment in the first empty row of the Food section. Returns the row number. */
  async function writeWeekRow(tab, label, total, initials, comment) {
    const [b, c] = await Promise.all([values(q(tab) + '!B1:B400'), values(q(tab) + '!C1:F400')]);
    const slot = findFoodSlot(b.map((r) => r[0]), c.map((r) => r[0]));
    const newRow = [label, total, initials, comment];
    if (!slot.full) {
      await write(q(tab) + '!C' + slot.row + ':F' + slot.row, [newRow]);
      return slot.row;
    }
    // Food is full: insert a row INSIDE the merged Food block (so the block and any totals grow with it),
    // then keep the order: old last entry, then the new one.
    const sheetId = (await tabs()).find((t) => t.title === tab).sheetId;
    await api('POST', ':batchUpdate', { requests: [{ insertDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: slot.lastRow - 1, endIndex: slot.lastRow }, inheritFromBefore: true } }] });
    const oldLast = (c[slot.lastRow - 1] || []).slice(0, 4);
    while (oldLast.length < 4) oldLast.push('');
    await write(q(tab) + '!C' + slot.lastRow + ':F' + (slot.lastRow + 1), [oldLast, newRow]);
    return slot.lastRow + 1;
  }

  /** Replaces the comment (column F) of a row, e.g. to flag a failed email. */
  async function writeComment(tab, row, text) {
    await write(q(tab) + '!F' + row + ':F' + row, [[text]]);
  }

  return { weekInfo, findDuplicate, getOrCreateWeekTab, writeWeekRow, writeComment };
}
