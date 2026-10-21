/**
 * Pure helpers for the weekly sheet (no Google calls), ported from reference/Code.gs.
 * Kept separate so they can be tested without a real spreadsheet.
 */

/** Google Sheets date number (days since 1899-12-30) -> "2026-10-15". Text dates like "9/28/26" also work. */
export function toISODate(v) {
  if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  return null;
}

function dayDiff(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

/**
 * Uses the closing calendar rows (Period, StartDate, EndDate) to find the tab name.
 * 2026-10-15 is in P10 (starts 9/28) -> 17 days in -> week 3 -> "P10W3".
 */
export function weekFromCalendar(rows, dateStr) {
  let hr = -1, pc = -1;
  for (let r = 0; r < rows.length && hr < 0; r++) {
    for (let c = 0; c < (rows[r] || []).length; c++) {
      if (String(rows[r][c]).trim().toLowerCase() === 'period') { hr = r; pc = c; break; }
    }
  }
  if (hr < 0) throw new Error('Could not read the closing calendar.');
  const hdr = rows[hr].map((x) => String(x).replace(/\s/g, '').toLowerCase());
  const sc = hdr.indexOf('startdate'), ec = hdr.indexOf('enddate');
  if (sc < 0 || ec < 0) throw new Error('The closing calendar needs StartDate and EndDate columns.');
  for (let r = hr + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const p = String(row[pc] ?? '').trim();
    const s = toISODate(row[sc]), e = toISODate(row[ec]);
    if (!p || !s || !e) continue;
    if (dateStr >= s && dateStr <= e) {
      const period = parseInt(p.replace(/\D/g, ''), 10);
      const week = Math.floor(dayDiff(s, dateStr) / 7) + 1;
      return { name: 'P' + String(period).padStart(2, '0') + 'W' + week, period, week };
    }
  }
  throw new Error('The date ' + dateStr + ' is not in this year\'s closing calendar. Check the date.');
}

/**
 * Finds where to write in the Food section.
 * colB / colC are column values starting at row 1. "Food" is a merged cell, so only its first row has text;
 * the section ends where the next label in column B starts.
 * Returns { row } for the first empty row, or { full: true, lastRow } when every row is used.
 */
export function findFoodSlot(colB, colC) {
  const b = colB.map((v) => String(v ?? '').trim());
  const foodRow = b.indexOf('Food') + 1; // 1-based
  if (foodRow < 1) throw new Error('Could not find the Food section.');
  let nextSection = -1;
  for (let i = foodRow; i < b.length; i++) { if (b[i]) { nextSection = i + 1; break; } }
  if (nextSection < 0) throw new Error('Could not find the section after Food.');
  for (let r = foodRow; r < nextSection; r++) {
    if (!String(colC[r - 1] ?? '').trim()) return { row: r };
  }
  return { full: true, lastRow: nextSection - 1 };
}

export const WEEK_TAB = /^P\d{2}W\d$/;
