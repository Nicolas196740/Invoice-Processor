/**
 * Mister O1 Invoice App — SERVER CODE
 * You should not need to edit this file. Settings live in Config.gs.
 *
 * Flow: phone uploads invoice PDF -> Claude reads it -> rules pick categories ->
 * person reviews -> app emails accounting, files the PDF in Drive, and writes the
 * row in the right weekly tab (creating the tab if it is a new week/period).
 */

// ───────────────────────── Web app entry ─────────────────────────

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Mister O1 Invoices')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ───────────────────────── Called from the phone ─────────────────────────

/** Checks the PIN and returns who is using the app plus the lists the screen needs. */
function login(pin) {
  const user = auth_(pin);
  return {
    name: user.name,
    initials: user.initials,
    testMode: CONFIG.TEST_MODE,
    vendors: VENDORS.map(function (v) { return v.name; }),
    categories: CATEGORIES,
  };
}

/** Saves the PDF as pending, has Claude read it, applies the rules and runs the checks. */
function analyzeInvoice(pin, base64Pdf) {
  auth_(pin);
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Pdf), 'application/pdf', 'pending-' + Date.now() + '.pdf');
  const pending = folder_(['_Pending']).createFile(blob);

  const ex = callClaude_(base64Pdf);
  const v = matchVendor_(ex.known_vendor, ex.vendor_name_on_invoice);
  const result = buildResult_(ex, v ? v.name : 'Other');
  result.pendingFileId = pending.getId();
  result.checks = check_(result);
  return result;
}

/** Re-applies the category rules when the person changes the vendor. */
function applyVendorRule(pin, extraction, vendorName) {
  auth_(pin);
  return buildResult_(extraction, vendorName);
}

/** Week tab + duplicate check, re-run when vendor / date / invoice # are edited. */
function checkInvoice(pin, d) {
  auth_(pin);
  return check_(d);
}

/** Final step: log in the weekly tab, email, file the PDF in Drive. */
function submitInvoice(pin, pendingFileId, d, allowDuplicate) {
  const user = auth_(pin);
  d = clean_(d);
  validate_(d);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // two people sending at the same time won't overwrite each other's row
  try {
    const dup = findDuplicate_(d.vendor, d.invoiceNumber);
    if (dup && !allowDuplicate) throw new Error('Already logged: ' + dup);

    const label = invoiceLabel_(d);
    const tab = getOrCreateWeekTab_(d.date);
    const comment = [d.comment, dup ? 'Sent again (duplicate override)' : ''].filter(String).join(' — ');

    // 1) Sheet row
    const row = writeWeekRow_(tab, label, d.total, user.initials, comment);

    // 2) File the PDF in Drive: Mister O1 Invoices / 2026 / P10W2 / GFS 10.10.26 #9041152744.pdf
    const file = DriveApp.getFileById(pendingFileId);
    file.setName(label + '.pdf');
    file.moveTo(folder_([d.date.slice(0, 4), tab.getName()]));

    // 3) Email (same format as before: subject = label, body = "Produce 298.07/ Poultry 76.14/ ...")
    const body = d.lines.map(function (l) { return l.category + ' ' + l.amount.toFixed(2); }).join('/ ');
    const to = CONFIG.TEST_MODE ? (CONFIG.TEST_EMAIL || Session.getEffectiveUser().getEmail()) : CONFIG.ACCOUNTING_EMAIL;
    const subject = (CONFIG.TEST_MODE ? '[TEST] ' : '') + label;
    try {
      MailApp.sendEmail({ to: to, subject: subject, body: body, attachments: [file.getBlob()] });
    } catch (e) {
      tab.getRange(row, 6).setValue('EMAIL FAILED — send manually. ' + comment);
      throw new Error('Logged in ' + tab.getName() + ' but the email failed: ' + e.message);
    }

    // 4) App log (audit trail of everything the app did)
    appLog_([new Date(), user.initials, d.vendor, d.date, "'" + d.invoiceNumber, d.total, body,
             tab.getName(), row, to, file.getUrl(), dup ? 'DUPLICATE OVERRIDE' : '']);

    return { label: label, subject: subject, to: to, body: body, tab: tab.getName(), row: row, fileUrl: file.getUrl() };
  } finally {
    lock.releaseLock();
  }
}

// ───────────────────────── Run once from the editor ─────────────────────────

/** Creates the app's log spreadsheet (and in TEST_MODE the test copy of the calendar + template) and the Drive folder. */
function setup() {
  const p = props_();
  if (!p.getProperty('APP_SS_ID')) {
    const ss = SpreadsheetApp.create('Mister O1 Invoice App - ' + (CONFIG.TEST_MODE ? 'TEST ' : '') + 'LOG');
    const src = SpreadsheetApp.openById(CONFIG.MODEL_SPREADSHEET_ID);
    ss.setSpreadsheetTimeZone(src.getSpreadsheetTimeZone());
    const log = ss.getSheets()[0];
    log.setName('App Log');
    log.appendRow(['Timestamp', 'Sent by', 'Vendor', 'Invoice date', 'Invoice #', 'Total', 'Email body',
                   'Week tab', 'Row', 'Emailed to', 'PDF in Drive', 'Notes']);
    log.setFrozenRows(1);
    // Test copy of the calendar and template so weekly tabs can be created without touching the real file.
    const cal = calendarSheet_(src);
    cal.copyTo(ss).setName(cal.getName());
    src.getSheetByName('Template').copyTo(ss).setName('Template');
    p.setProperty('APP_SS_ID', ss.getId());
  }
  Logger.log('Log / test spreadsheet: ' + appSS_().getUrl());
  Logger.log('Drive folder: ' + folder_([]).getUrl());
  Logger.log('Weekly tabs are written to: ' + targetSS_().getName());
}

/**
 * TEST MODE ONLY: wipes test results so you can start clean (e.g. before a demo).
 * Deletes the weekly tabs in the TEST spreadsheet, clears the App Log, and moves the
 * test PDFs to Drive trash (recoverable for 30 days). Never touches the real VENDOR MODEL.
 */
function resetTestData() {
  if (!CONFIG.TEST_MODE) throw new Error('resetTestData only works while TEST_MODE is true.');
  const ss = appSS_();
  if (ss.getId() === CONFIG.MODEL_SPREADSHEET_ID) throw new Error('Refusing to touch the real VENDOR MODEL.');
  let tabs = 0;
  ss.getSheets().forEach(function (sh) {
    if (/^P\d{2}W\d$/.test(sh.getName())) { ss.deleteSheet(sh); tabs++; }
  });
  const log = ss.getSheetByName('App Log');
  const rows = Math.max(0, log.getLastRow() - 1);
  if (rows) log.deleteRows(2, rows);
  let files = 0;
  const root = folder_([]);
  (function trash(f) {
    const it = f.getFiles();
    while (it.hasNext()) { it.next().setTrashed(true); files++; }
    const subs = f.getFolders();
    while (subs.hasNext()) { const s = subs.next(); trash(s); s.setTrashed(true); }
  })(root);
  Logger.log('Deleted ' + tabs + ' test tabs, cleared ' + rows + ' App Log rows, moved ' + files + ' test files to Drive trash.');
}

/** Quick check that the Claude API key works. */
function testApiKey() {
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': prop_('ANTHROPIC_API_KEY', true), 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: CONFIG.MODEL, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with: OK' }] }),
  });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText());
}

// ───────────────────────── AI ─────────────────────────

function callClaude_(base64Pdf) {
  const tool = {
    name: 'record_invoice',
    description: 'Record the data read from a vendor invoice.',
    input_schema: {
      type: 'object',
      properties: {
        known_vendor: { type: 'string', enum: VENDORS.map(function (v) { return v.name; }).concat(['Other']),
          description: 'Which known vendor this is. GFS = Gordon Food Service. Use Other if none fit.' },
        vendor_name_on_invoice: { type: 'string', description: 'Company name as printed on the invoice.' },
        invoice_number: { type: 'string', description: 'Invoice number exactly as printed, keep leading zeros, no #.' },
        invoice_date: { type: 'string', description: 'Invoice date as YYYY-MM-DD.' },
        invoice_total: { type: 'number', description: 'Final invoice total (amount due), including tax and fees.' },
        summary_groups: {
          type: 'array',
          description: 'GFS ONLY: every row of the "Category Summary" or "Group Summary" table, including Fuel Charge, using the TOTAL column (amount + tax). Do not include the Total row. Empty for other vendors.',
          items: { type: 'object', properties: { label: { type: 'string' }, total: { type: 'number' } }, required: ['label', 'total'] },
        },
        category_split: {
          type: 'array',
          description: 'NOT GFS: split of the invoice total by category (amounts must add up to invoice_total). Use only the allowed categories.',
          items: { type: 'object', properties: { category: { type: 'string', enum: CATEGORIES }, amount: { type: 'number' } }, required: ['category', 'amount'] },
        },
        notes: { type: 'string', description: 'Only if something needs a human: handwritten changes, credits/returns, unreadable numbers, missing pages. Empty otherwise.' },
      },
      required: ['known_vendor', 'vendor_name_on_invoice', 'invoice_number', 'invoice_date', 'invoice_total'],
    },
  };

  const vendorHints = VENDORS.filter(function (v) { return v.rule === 'ai'; })
    .map(function (v) { return '- ' + v.name + ': allowed categories ' + v.allowed.join(', ') + '. ' + (v.hint || ''); }).join('\n');

  const prompt =
    'This is a vendor invoice for Mister O1, a pizza restaurant. Read it and call the record_invoice tool. You must call the tool; do not answer in plain text.\n' +
    'Rules:\n' +
    '- Read numbers exactly as printed. Never guess a number; if unreadable, say so in notes.\n' +
    '- GFS (Gordon Food Service) invoices have a "Category Summary" or "Group Summary" table on the last page. Copy every row into summary_groups with its TOTAL column.\n' +
    '- For other vendors, fill category_split so it adds up to the invoice total.\n' +
    vendorHints + '\n' +
    '- For unknown vendors, choose the most fitting categories from the list.';

  const payload = {
    model: CONFIG.MODEL,
    max_tokens: 2000,
    tools: [tool],
    tool_choice: { type: 'auto' }, // this model doesn't allow forcing a tool; the prompt says it must call it
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf } },
      { type: 'text', text: prompt },
    ] }],
  };

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': prop_('ANTHROPIC_API_KEY', true), 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
  });
  const code = res.getResponseCode();
  let body;
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = {}; }
  if (code !== 200) {
    throw new Error('AI error (' + code + '): ' + ((body.error && body.error.message) || res.getContentText().slice(0, 300)));
  }
  const use = (body.content || []).filter(function (c) { return c.type === 'tool_use'; })[0];
  if (!use) throw new Error('The AI did not return invoice data. Try a clearer photo.');
  return use.input;
}

// ───────────────────────── Rules ─────────────────────────

function matchVendor_(knownName, text) {
  if (knownName && knownName !== 'Other') {
    const k = VENDORS.filter(function (v) { return v.name === knownName; })[0];
    if (k) return k;
  }
  const t = String(text || '').trim();
  if (!t) return null;
  return VENDORS.filter(function (v) { return v.match.test(t); })[0] || null;
}

function gfsCategory_(label) {
  const l = String(label).toLowerCase();
  for (const key in GFS_GROUPS) {
    if (l.indexOf(key) >= 0) return GFS_GROUPS[key] === '__FUEL__' ? CONFIG.FUEL_CATEGORY : GFS_GROUPS[key];
  }
  return '';
}

function buildResult_(ex, vendorName) {
  const v = VENDORS.filter(function (x) { return x.name === vendorName; })[0] || null;
  const lines = [];
  const warnings = [];
  const total = round2_(ex.invoice_total);

  if (v && v.rule === 'gfs') {
    const groups = ex.summary_groups || [];
    groups.forEach(function (g) {
      const cat = gfsCategory_(g.label);
      if (!cat) warnings.push('Unknown GFS group "' + g.label + '" — pick a category for it.');
      addLine_(lines, cat, g.total);
    });
    if (!groups.length) warnings.push('Could not find the Category/Group Summary. Add the categories by hand.');
  } else if (v && v.category) {
    addLine_(lines, v.category, total);
  } else {
    const allowed = v && v.allowed ? v.allowed : CATEGORIES;
    (ex.category_split || []).forEach(function (s) {
      addLine_(lines, allowed.indexOf(s.category) >= 0 ? s.category : '', s.amount);
    });
    if (!lines.length) addLine_(lines, '', total);
    if (!v) warnings.push('New vendor — type the vendor name the way you want it in the subject, and check the categories.');
    else if (v.category === null && !v.rule) warnings.push('No category rule for ' + v.name + ' yet — pick one (and tell Nico so it can be added).');
  }
  if (ex.notes) warnings.push('AI note: ' + ex.notes);

  return {
    vendor: vendorName,
    vendorOnInvoice: ex.vendor_name_on_invoice || '',
    invoiceNumber: cleanNumber_(ex.invoice_number),
    date: ex.invoice_date || '',
    total: total,
    lines: lines,
    warnings: warnings,
    extraction: ex,
  };
}

function addLine_(lines, cat, amt) {
  amt = round2_(amt);
  const same = cat ? lines.filter(function (l) { return l.category === cat; })[0] : null;
  if (same) same.amount = round2_(same.amount + amt);
  else lines.push({ category: cat, amount: amt });
}

// ───────────────────────── Checks ─────────────────────────

function check_(d) {
  const out = { weekTab: null, duplicate: null, errors: [] };
  if (/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) {
    try { out.weekTab = weekInfo_(targetSS_(), d.date).name; } catch (e) { out.errors.push(e.message); }
  } else {
    out.errors.push('Invoice date is missing.');
  }
  if (d.vendor && d.invoiceNumber) out.duplicate = findDuplicate_(d.vendor, d.invoiceNumber);
  return out;
}

function clean_(d) {
  return {
    vendor: String(d.vendor || '').trim(),
    invoiceNumber: cleanNumber_(d.invoiceNumber),
    date: String(d.date || '').trim(),
    total: round2_(d.total),
    comment: String(d.comment || '').trim(),
    lines: (d.lines || []).map(function (l) { return { category: String(l.category || ''), amount: round2_(l.amount) }; })
      .filter(function (l) { return l.amount !== 0 || l.category; }),
  };
}

function validate_(d) {
  if (!d.vendor || d.vendor === 'Other') throw new Error('Vendor name is missing.');
  if (!d.invoiceNumber) throw new Error('Invoice number is missing.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new Error('Invoice date is missing.');
  if (!isFinite(d.total) || d.total === 0) throw new Error('Invoice total is missing.');
  if (!d.lines.length) throw new Error('Add at least one category.');
  d.lines.forEach(function (l) {
    if (CATEGORIES.indexOf(l.category) < 0) throw new Error('Pick a category for every line.');
    if (!isFinite(l.amount)) throw new Error('Every category needs an amount.');
  });
  const sum = round2_(d.lines.reduce(function (a, l) { return a + l.amount; }, 0));
  if (Math.abs(sum - d.total) > 0.009) {
    throw new Error('Categories add up to ' + sum.toFixed(2) + ' but the invoice total is ' + d.total.toFixed(2) + '.');
  }
}

/** Looks for the same vendor + invoice # in every weekly tab (and, in test mode, in the real file too). */
function findDuplicate_(vendor, number) {
  const key = dupKey_(vendor, number);
  const books = [targetSS_()];
  if (CONFIG.TEST_MODE) books.push(SpreadsheetApp.openById(CONFIG.MODEL_SPREADSHEET_ID));
  for (let b = 0; b < books.length; b++) {
    const sheets = books[b].getSheets();
    for (let s = 0; s < sheets.length; s++) {
      const sh = sheets[s];
      if (!/^P\d{2}W\d$/.test(sh.getName())) continue;
      const last = Math.min(sh.getLastRow(), 300);
      if (last < 7) continue;
      const vals = sh.getRange(7, 3, last - 6, 2).getValues();
      for (let i = 0; i < vals.length; i++) {
        const k = keyFromLabel_(vals[i][0]);
        if (k && k === key) {
          return (b === 1 ? 'REAL FILE ' : '') + sh.getName() + ' row ' + (i + 7) + ': ' + vals[i][0] + ' ($' + vals[i][1] + ')';
        }
      }
    }
  }
  return null;
}

function keyFromLabel_(text) {
  const m = String(text || '').match(/^(.*?)\s*\d{1,2}\.\d{1,2}\.\d{2,4}\s*#\s*(\S+)/);
  if (!m) return null;
  const v = matchVendor_(null, m[1]);
  return dupKey_(v ? v.name : m[1], m[2]);
}

/** "#CO - 003885" -> "003885" (drops # and short letter prefixes like "CO -"; keeps suffixes like "264945-SCHDL"). */
function cleanNumber_(n) {
  return String(n || '').trim().replace(/^#\s*/, '').replace(/^[A-Za-z]{1,4}\s*-\s*(?=\d)/, '').replace(/\s+/g, '');
}

/** Vendor + the digits of the invoice number, so "003885", "3885" and "CO - 003885" all match. */
function dupKey_(vendor, num) {
  const digits = String(num).replace(/\D/g, '').replace(/^0+/, '');
  return String(vendor).toLowerCase().replace(/[^a-z]/g, '') + '|' +
         (digits || String(num).toLowerCase().replace(/[^a-z0-9]/g, ''));
}

// ───────────────────────── Weekly tabs ─────────────────────────

function calendarSheet_(ss) {
  const cal = ss.getSheets().filter(function (s) { return /calendar/i.test(s.getName()); })[0];
  if (!cal) throw new Error('No calendar tab found in ' + ss.getName());
  return cal;
}

/** Uses the closing calendar (P1–P12, start/end dates) to find the tab name, e.g. 2026-10-10 -> P10W2. */
function weekInfo_(ss, dateStr) {
  const tz = ss.getSpreadsheetTimeZone();
  const vals = calendarSheet_(ss).getDataRange().getValues();
  let hr = -1, pc = -1;
  for (let r = 0; r < vals.length && hr < 0; r++) {
    for (let c = 0; c < vals[r].length; c++) {
      if (String(vals[r][c]).trim().toLowerCase() === 'period') { hr = r; pc = c; break; }
    }
  }
  if (hr < 0) throw new Error('Could not read the closing calendar.');
  const hdr = vals[hr].map(function (x) { return String(x).replace(/\s/g, '').toLowerCase(); });
  const sc = hdr.indexOf('startdate'), ec = hdr.indexOf('enddate');
  for (let r = hr + 1; r < vals.length; r++) {
    const p = String(vals[r][pc]).trim(), s = vals[r][sc], e = vals[r][ec];
    if (!p || !(s instanceof Date) || !(e instanceof Date)) continue;
    const sStr = Utilities.formatDate(s, tz, 'yyyy-MM-dd');
    const eStr = Utilities.formatDate(e, tz, 'yyyy-MM-dd');
    if (dateStr >= sStr && dateStr <= eStr) return periodWeek_(p, sStr, dateStr);
  }
  throw new Error('The date ' + dateStr + ' is not in this year\'s closing calendar. Check the date, or update MODEL_SPREADSHEET_ID for the new year.');
}

function periodWeek_(periodText, startStr, dateStr) {
  const pn = parseInt(String(periodText).replace(/\D/g, ''), 10);
  const week = Math.floor(dayDiff_(startStr, dateStr) / 7) + 1;
  return { name: 'P' + ('0' + pn).slice(-2) + 'W' + week, period: pn, week: week };
}

function dayDiff_(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

/** Returns the week tab, creating it from Template (placed right after Template, newest first) if needed. */
function getOrCreateWeekTab_(dateStr) {
  const ss = targetSS_();
  const info = weekInfo_(ss, dateStr);
  let sh = ss.getSheetByName(info.name);
  if (sh) return sh;
  const tpl = ss.getSheetByName('Template');
  if (!tpl) throw new Error('No "Template" tab found in ' + ss.getName());
  sh = ss.insertSheet(info.name, tpl.getIndex(), { template: tpl });
  sh.getRange('D4').setValue(Number(dateStr.slice(0, 4)));
  sh.getRange('E4').setValue('P' + info.period + ' W' + info.week);
  return sh;
}

/** Writes "GFS 10.10.26 #..." | amount | initials | comment in the first empty row of the Food section. */
function writeWeekRow_(sh, label, total, initials, comment) {
  const colB = sh.getRange(1, 2, sh.getLastRow(), 1).getValues().map(function (r) { return String(r[0]).trim(); });
  const foodRow = colB.indexOf('Food') + 1; // 1-based
  if (foodRow < 1) throw new Error('Could not find the Food section in ' + sh.getName());
  let nextSection = -1;
  for (let i = foodRow; i < colB.length; i++) { if (colB[i]) { nextSection = i + 1; break; } }
  if (nextSection < 0) throw new Error('Could not find the section after Food in ' + sh.getName());

  const vals = sh.getRange(foodRow, 3, nextSection - foodRow, 1).getValues();
  let row = -1;
  for (let i = 0; i < vals.length; i++) { if (!String(vals[i][0]).trim()) { row = foodRow + i; break; } }
  if (row < 0) { sh.insertRowBefore(nextSection); row = nextSection; }
  sh.getRange(row, 3, 1, 4).setValues([[label, total, initials, comment]]);
  return row;
}

function invoiceLabel_(d) {
  const p = d.date.split('-');
  return d.vendor + ' ' + p[1] + '.' + p[2] + '.' + p[0].slice(2) + ' #' + d.invoiceNumber;
}

// ───────────────────────── Helpers ─────────────────────────

function auth_(pin) {
  const pins = JSON.parse(prop_('PINS', true));
  const u = pins[String(pin || '').trim()];
  if (!u) throw new Error('Wrong PIN.');
  return u;
}

function props_() { return PropertiesService.getScriptProperties(); }

function prop_(k, required) {
  const v = props_().getProperty(k);
  if (required && !v) throw new Error('Missing setting "' + k + '". Add it in Project Settings → Script Properties.');
  return v;
}

function appSS_() {
  const id = prop_('APP_SS_ID');
  if (!id) throw new Error('Run setup() once from the script editor first.');
  return SpreadsheetApp.openById(id);
}

/** Where weekly tabs are written: the test copy in TEST_MODE, the real VENDOR MODEL otherwise. */
function targetSS_() {
  return CONFIG.TEST_MODE ? appSS_() : SpreadsheetApp.openById(CONFIG.MODEL_SPREADSHEET_ID);
}

function appLog_(row) { appSS_().getSheetByName('App Log').appendRow(row); }

/** Drive folder under the app's root folder, creating subfolders as needed. */
function folder_(path) {
  const p = props_();
  const rootKey = CONFIG.TEST_MODE ? 'DRIVE_FOLDER_ID_TEST' : 'DRIVE_FOLDER_ID';
  let root;
  try { root = DriveApp.getFolderById(p.getProperty(rootKey)); } catch (e) { root = null; }
  if (!root) {
    root = DriveApp.createFolder(CONFIG.DRIVE_FOLDER_NAME + (CONFIG.TEST_MODE ? ' (TEST)' : ''));
    p.setProperty(rootKey, root.getId());
  }
  return path.reduce(function (f, name) {
    const it = f.getFoldersByName(name);
    return it.hasNext() ? it.next() : f.createFolder(name);
  }, root);
}

function round2_(n) { return Math.round(Number(n) * 100) / 100; }
