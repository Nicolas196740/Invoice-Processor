/**
 * Vendor + category rules and checks, ported from reference/Code.gs.
 * Shared by the browser (review screen) and the Netlify Functions (final check before sending).
 */
import { VENDORS, CATEGORIES, GFS_GROUPS, FUEL_CATEGORY } from './config.js';

export const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Finds the vendor from Claude's pick, or from a name like "Gordon Food Service" / an old sheet label. */
export function matchVendor(knownName, text) {
  if (knownName && knownName !== 'Other') {
    const k = VENDORS.find((v) => v.name === knownName);
    if (k) return k;
  }
  const t = String(text || '').trim();
  if (!t) return null;
  return VENDORS.find((v) => v.match.test(t)) || null;
}

/** "Fuel Charge" -> "Restaurant Expense", "Canned & Dry Grocery" -> "Other food", unknown -> "". */
export function gfsCategory(label) {
  const l = String(label).toLowerCase();
  for (const key in GFS_GROUPS) {
    if (l.indexOf(key) >= 0) return GFS_GROUPS[key] === '__FUEL__' ? FUEL_CATEGORY : GFS_GROUPS[key];
  }
  return '';
}

/** Adds an amount to a category line, merging lines with the same category (e.g. Seafood + Grocery -> Other food). */
function addLine(lines, cat, amt) {
  amt = round2(amt);
  const same = cat ? lines.find((l) => l.category === cat) : null;
  if (same) same.amount = round2(same.amount + amt);
  else lines.push({ category: cat, amount: amt });
}

/**
 * Turns what Claude read into the review screen's starting values, using the vendor's rule:
 * GFS -> summary groups, one-category vendors -> whole total, Tita/unknown -> the AI's split.
 */
export function buildResult(ex, vendorName) {
  const v = VENDORS.find((x) => x.name === vendorName) || null;
  const lines = [];
  const warnings = [];
  const total = round2(ex.invoice_total);

  if (v && v.rule === 'gfs') {
    const groups = ex.summary_groups || [];
    groups.forEach((g) => {
      const cat = gfsCategory(g.label);
      if (!cat) warnings.push('Unknown GFS group "' + g.label + '" — pick a category for it.');
      addLine(lines, cat, g.total);
    });
    if (!groups.length) warnings.push('Could not find the Category/Group Summary. Add the categories by hand.');
  } else if (v && v.category) {
    addLine(lines, v.category, total);
  } else {
    const allowed = v && v.allowed ? v.allowed : CATEGORIES;
    (ex.category_split || []).forEach((s) => {
      addLine(lines, allowed.indexOf(s.category) >= 0 ? s.category : '', s.amount);
    });
    if (!lines.length) addLine(lines, '', total);
    if (!v) warnings.push('New vendor — type the vendor name the way you want it in the subject, and check the categories.');
  }
  if (ex.notes) warnings.push('AI note: ' + ex.notes);

  return {
    vendor: v ? v.name : 'Other',
    vendorOnInvoice: ex.vendor_name_on_invoice || '',
    invoiceNumber: cleanNumber(ex.invoice_number),
    date: /^\d{4}-\d{2}-\d{2}$/.test(ex.invoice_date || '') ? ex.invoice_date : '',
    total,
    lines,
    warnings,
  };
}

/** "#CO - 003885" -> "003885" (drops # and short letter prefixes like "CO -"; keeps suffixes like "264945-SCHDL"). */
export function cleanNumber(n) {
  return String(n || '').trim().replace(/^#\s*/, '').replace(/^[A-Za-z]{1,4}\s*-\s*(?=\d)/, '').replace(/\s+/g, '');
}

/** Vendor + the digits of the invoice number, so "003885", "3885" and "CO - 003885" all match. */
export function dupKey(vendor, num) {
  const v = matchVendor(null, vendor);
  const name = v ? v.name : String(vendor);
  const digits = String(num).replace(/\D/g, '').replace(/^0+/, '');
  return name.toLowerCase().replace(/[^a-z]/g, '') + '|' +
         (digits || String(num).toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/** Duplicate key from an old sheet row like "Wynwood 10.10.26 #003885" (old vendor names count as the same vendor). */
export function keyFromLabel(text) {
  const m = String(text || '').match(/^(.*?)\s*\d{1,2}\.\d{1,2}\.\d{2,4}\s*#\s*(\S+)/);
  if (!m) return null;
  return dupKey(m[1], m[2]);
}

/** "GFS 10.10.26 #9041152744" — the email subject and the sheet's column C. */
export function invoiceLabel(d) {
  const p = d.date.split('-');
  return d.vendor + ' ' + p[1] + '.' + p[2] + '.' + p[0].slice(2) + ' #' + d.invoiceNumber;
}

/** "Produce 298.07/ Poultry 76.14/ Meat 66.92" — the email body. */
export function emailBody(lines) {
  return lines.map((l) => (l.category || '?') + ' ' + round2(l.amount).toFixed(2)).join('/ ');
}

/** Tidies what the review screen sends. */
export function cleanInvoice(d) {
  return {
    vendor: String(d.vendor || '').trim(),
    invoiceNumber: cleanNumber(d.invoiceNumber),
    date: String(d.date || '').trim(),
    total: round2(d.total),
    comment: String(d.comment || '').trim(),
    lines: (d.lines || []).map((l) => ({ category: String(l.category || ''), amount: round2(l.amount) }))
      .filter((l) => l.amount !== 0 || l.category),
  };
}

/** Everything that must be true before Send. Returns a list of problems (empty = OK). */
export function problems(d) {
  const out = [];
  if (!d.vendor || d.vendor === 'Other') out.push('Vendor name is missing.');
  if (!d.invoiceNumber) out.push('Invoice number is missing.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) out.push('Invoice date is missing.');
  if (!isFinite(d.total) || d.total === 0) out.push('Invoice total is missing.');
  if (!d.lines.length) out.push('Add at least one category.');
  if (d.lines.some((l) => CATEGORIES.indexOf(l.category) < 0)) out.push('Pick a category for every line.');
  if (d.lines.some((l) => !isFinite(l.amount))) out.push('Every category needs an amount.');
  const sum = round2(d.lines.reduce((a, l) => a + l.amount, 0));
  if (isFinite(d.total) && Math.abs(sum - d.total) > 0.009) {
    out.push('Categories add up to ' + sum.toFixed(2) + ' but the invoice total is ' + round2(d.total).toFixed(2) + '.');
  }
  return out;
}
