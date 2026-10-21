import { supabase } from './supabase.js';
import { VENDORS, CATEGORIES } from '../shared/config.js';
import { buildResult, cleanInvoice, problems, invoiceLabel, emailBody, round2 } from '../shared/rules.js';

// ───────── state + small helpers ─────────
const S = { user: null, profile: null, files: [], data: null, extraction: null, pdfPath: null, checks: null, checking: false };
const $ = (id) => document.getElementById(id);

function show(id) {
  ['sLoading', 'sLogin', 'sHome', 'sWorking', 'sReview', 'sDone', 'sProfile'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
  window.scrollTo(0, 0);
}
function msg(el, cls, text) {
  $(el).innerHTML = '';
  if (!text) return;
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  $(el).appendChild(d);
}
const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────── sign in / out ─────────
$('btnGoogle').onclick = async () => {
  msg('loginMsg');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) msg('loginMsg', 'bad', error.message);
};

$('btnLogout').onclick = async () => {
  await supabase.auth.signOut();
};

// ───────── profile ─────────
async function loadProfile() {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', S.user.id).single();
  if (error) throw new Error('Could not load your profile: ' + error.message);
  S.profile = data;
  $('who').textContent = (data.full_name || data.email) + (data.initials ? ' (' + data.initials + ')' : '');
}

function fillProfile() {
  $('pEmail').value = S.profile.email;
  $('pName').value = S.profile.full_name;
  $('pInitials').value = S.profile.initials;
  msg('profileMsg', S.profile.initials ? '' : 'warn', S.profile.initials ? '' : 'Add your initials before sending invoices.');
}

$('btnSave').onclick = async () => {
  const full_name = $('pName').value.trim();
  const initials = $('pInitials').value.trim().toUpperCase();
  if (!/^[A-Z]{1,4}$/.test(initials)) return msg('profileMsg', 'bad', 'Initials must be 1–4 letters.');
  $('btnSave').disabled = true;
  const { error } = await supabase.from('profiles').update({ full_name, initials }).eq('id', S.user.id);
  $('btnSave').disabled = false;
  if (error) return msg('profileMsg', 'bad', error.message);
  await loadProfile();
  // Saved -> go to "New invoice". (Setting the hash only fires hashchange if it actually changes.)
  if (location.hash === '#/') route();
  else location.hash = '#/';
};

// ───────── upload ─────────
$('btnAdd').onclick = () => $('files').click();
$('files').onchange = () => {
  Array.prototype.forEach.call($('files').files, (f) => S.files.push(f));
  $('files').value = '';
  renderThumbs();
};
$('btnClear').onclick = () => { S.files = []; renderThumbs(); };

function renderThumbs() {
  const t = $('thumbs');
  t.innerHTML = '';
  S.files.forEach((f, i) => {
    const d = document.createElement('div');
    if (f.type.indexOf('image/') === 0) d.style.backgroundImage = 'url(' + URL.createObjectURL(f) + ')';
    d.textContent = f.type === 'application/pdf' ? 'PDF' : 'Page ' + (i + 1);
    t.appendChild(d);
  });
  $('btnRead').disabled = !S.files.length;
  $('btnClear').classList.toggle('hidden', !S.files.length);
  msg('uploadMsg');
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not open one of the photos.'));
    img.src = URL.createObjectURL(file);
  });
}

// One PDF is used as is. Photos are shrunk (still readable) and combined into one PDF, one photo per page.
async function buildPdf(files) {
  const pdfs = files.filter((f) => f.type === 'application/pdf');
  if (pdfs.length) {
    if (files.length > 1) throw new Error('Use either one PDF or photos, not both.');
    return pdfs[0];
  }
  const { jsPDF } = await import('jspdf'); // loaded only when needed (it's a big library)
  let doc = null;
  for (const f of files) {
    const img = await loadImage(f);
    // Longest side max 2200px: small enough to upload fast, sharp enough to read small print.
    const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
    const jpg = c.toDataURL('image/jpeg', 0.72);
    const o = w > h ? 'l' : 'p';
    if (!doc) doc = new jsPDF({ orientation: o, unit: 'pt', format: [w, h] });
    else doc.addPage([w, h], o);
    doc.addImage(jpg, 'JPEG', 0, 0, w, h);
  }
  return doc.output('blob');
}

$('btnRead').onclick = async () => {
  $('workingText').textContent = 'Preparing pages…';
  show('sWorking');
  try {
    const pdf = await buildPdf(S.files);
    if (pdf.size > 20 * 1024 * 1024) throw new Error('The invoice is too large. Try fewer or smaller photos.');

    // 1) Upload the PDF to the private "invoices" bucket, in the user's own folder.
    $('workingText').textContent = 'Uploading…';
    const path = S.user.id + '/pending/' + Date.now() + '.pdf';
    const up = await supabase.storage.from('invoices').upload(path, pdf, { contentType: 'application/pdf' });
    if (up.error) throw new Error('Upload failed: ' + up.error.message);

    // 2) Ask the server to start reading it (sends only the path, not the file).
    $('workingText').textContent = 'Reading invoice…';
    const { jobId } = await api('start-read', { pdfPath: path });

    // 3) Check every 2 seconds until the background function is done (max 3 minutes).
    const job = await waitForJob(jobId);
    startReview(job.result, path);
  } catch (e) {
    show('sHome');
    msg('uploadMsg', 'bad', e.message);
  }
};

async function waitForJob(jobId) {
  const started = Date.now();
  while (Date.now() - started < 3 * 60 * 1000) {
    await sleep(2000);
    const { data, error } = await supabase.from('ai_jobs').select('status, result, error').eq('id', jobId).single();
    if (error) continue; // a hiccup; try again next round
    if (data.status === 'done') return data;
    if (data.status === 'error') throw new Error(data.error || 'The AI could not read this invoice.');
  }
  throw new Error('Reading took too long. Try again.');
}

// ───────── review ─────────
// S.data holds what's on screen; S.extraction is what the AI read (to re-apply rules when the vendor changes).
function startReview(r, path) {
  S.extraction = r.extraction;
  S.pdfPath = path;
  S.data = buildResult(r.extraction, r.vendor);
  S.checks = null;
  const sel = $('vendor');
  sel.innerHTML = '';
  VENDORS.map((v) => v.name).concat(['Other']).forEach((v) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v === 'Other' ? 'Other (new vendor)' : v;
    sel.appendChild(o);
  });
  sel.value = S.data.vendor;
  $('vendorOther').value = S.data.vendor === 'Other' ? S.data.vendorOnInvoice : '';
  $('vendorOther').classList.toggle('hidden', S.data.vendor !== 'Other');
  $('onInvoice').textContent = S.data.vendorOnInvoice ? 'On the invoice: ' + S.data.vendorOnInvoice : '';
  $('date').value = S.data.date;
  $('number').value = S.data.invoiceNumber;
  $('total').value = money(S.data.total);
  $('comment').value = '';
  $('dupOk').checked = false;
  msg('sendMsg');
  S.files = [];
  renderThumbs();
  renderLines();
  renderWarnings();
  show('sReview');
  recheck();
}

function vendorName() { return $('vendor').value === 'Other' ? $('vendorOther').value.trim() : $('vendor').value; }

/** What would be sent, read from the screen. */
function screenInvoice() {
  return cleanInvoice({
    vendor: vendorName(), invoiceNumber: $('number').value, date: $('date').value,
    total: parseFloat($('total').value), lines: S.data.lines, comment: $('comment').value,
  });
}

function renderLines() {
  const box = $('lines');
  box.innerHTML = '';
  S.data.lines.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    const sel = document.createElement('select');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— pick category —';
    sel.appendChild(blank);
    CATEGORIES.forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
    sel.value = l.category || '';
    sel.onchange = () => { l.category = sel.value; update(); };
    const amt = document.createElement('input');
    amt.type = 'number'; amt.step = '0.01'; amt.inputMode = 'decimal'; amt.value = money(l.amount);
    amt.oninput = () => { l.amount = parseFloat(amt.value) || 0; update(); };
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Remove line');
    x.onclick = () => { S.data.lines.splice(i, 1); renderLines(); };
    row.appendChild(sel); row.appendChild(amt); row.appendChild(x);
    box.appendChild(row);
  });
  update();
}
$('btnAddLine').onclick = () => { S.data.lines.push({ category: '', amount: 0 }); renderLines(); };

function renderWarnings() {
  const w = $('warnings');
  w.innerHTML = '';
  (S.data.warnings || []).forEach((t) => {
    const d = document.createElement('div');
    d.className = 'msg warn';
    d.textContent = '⚠️ ' + t;
    w.appendChild(d);
  });
}

/** Re-checks everything and unlocks Send only when the invoice is ready. */
function update() {
  if (!S.data) return;
  const d = screenInvoice();
  const sum = round2(d.lines.reduce((a, l) => a + l.amount, 0));
  const total = isFinite(d.total) ? d.total : 0;
  const diff = round2(total - sum);
  const sumOk = Math.abs(diff) < 0.01 && total !== 0;
  msg('sumMsg', sumOk ? 'ok' : 'bad', sumOk
    ? '✓ Categories add up to the invoice total ($' + money(total) + ')'
    : 'Categories add up to $' + money(sum) + ' — invoice total is $' + money(total) + ' (off by $' + money(Math.abs(diff)) + ')');

  const c = S.checks || {};
  if (S.checking) msg('tabMsg', 'warn', 'Checking the sheet…');
  else if (c.weekTab) msg('tabMsg', 'ok', 'Goes in sheet tab ' + c.weekTab);
  else msg('tabMsg', 'bad', (c.errors || []).join(' ') || 'Could not check the sheet.');
  $('dupBox').classList.toggle('hidden', !c.duplicate);
  $('dupMsg').textContent = c.duplicate ? 'This invoice is already logged → ' + c.duplicate : '';
  const dupOk = !c.duplicate || $('dupOk').checked;

  $('btnSend').disabled = !(problems(d).length === 0 && dupOk && !S.checking && c.weekTab);
  const label = d.vendor && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? invoiceLabel(d) : (d.vendor || '?') + ' ??.??.?? #' + d.invoiceNumber;
  $('preview').textContent = 'Subject: [CLASS] ' + label + '\n\n' + emailBody(d.lines);
}

/** Calls one of our Netlify Functions as the signed-in user. */
async function api(name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch('/.netlify/functions/' + name, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (session ? session.access_token : '') },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'Server error (' + res.status + ').');
  return out;
}

/** Asks the server which week tab this goes in and whether it was already sent (app + Google Sheet). */
let checkTimer = null, checkSeq = 0;
function recheck() {
  S.checking = true;
  update();
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    const seq = ++checkSeq;
    const d = screenInvoice();
    let checks;
    try {
      checks = await api('check-invoice', { vendor: d.vendor, invoiceNumber: d.invoiceNumber, date: d.date });
    } catch (e) {
      checks = { weekTab: null, duplicate: null, errors: [e.message] };
    }
    if (seq !== checkSeq) return; // a newer check is on its way
    S.checks = checks;
    S.checking = false;
    update();
  }, 600);
}

$('vendor').onchange = () => {
  $('vendorOther').classList.toggle('hidden', $('vendor').value !== 'Other');
  if ($('vendor').value === 'Other' && !$('vendorOther').value) $('vendorOther').value = S.data.vendorOnInvoice;
  // Re-apply the new vendor's category rule to what the AI read.
  const r = buildResult(S.extraction, $('vendor').value);
  S.data.lines = r.lines;
  S.data.warnings = r.warnings;
  renderLines();
  renderWarnings();
  recheck();
};
$('vendorOther').oninput = recheck;
$('number').oninput = recheck;
$('date').onchange = recheck;
$('total').oninput = update;
$('comment').oninput = update;
$('dupOk').onchange = update;

$('btnCancel').onclick = () => { S.data = null; show('sHome'); };

$('btnSend').onclick = async () => {
  $('btnSend').disabled = true;
  $('workingText').textContent = 'Sending…';
  show('sWorking');
  try {
    const r = await api('submit-invoice', { pdfPath: S.pdfPath, invoice: screenInvoice(), allowDuplicate: $('dupOk').checked });
    const box = $('doneInfo');
    box.innerHTML = '';
    if (r.emailError) msg('doneInfo', 'bad', 'Logged and saved, but the email failed: ' + r.emailError + ' The sheet row is flagged "EMAIL FAILED".');
    [['Subject', r.subject], ['Sent to', r.emailError ? '— (not sent)' : r.to], ['Sheet', 'tab ' + r.tab + ', row ' + r.row], ['Body', r.body]].forEach(([k, v]) => {
      const p = document.createElement('p');
      const b = document.createElement('b');
      b.textContent = k + ': ';
      p.appendChild(b);
      p.appendChild(document.createTextNode(v));
      box.appendChild(p);
    });
    if (r.fileUrl) {
      const a = document.createElement('a');
      a.href = r.fileUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open the PDF';
      box.appendChild(a);
    }
    S.data = null;
    show('sDone');
  } catch (e) {
    show('sReview');
    msg('sendMsg', 'bad', e.message);
    update();
  }
};
$('btnAnother').onclick = () => show('sHome');

// ───────── pages ─────────
function route() {
  if (!S.user) return show('sLogin');
  // No initials yet (e.g. Google gave no name) -> send them to the profile page first.
  if (location.hash === '#/profile' || !S.profile.initials) {
    fillProfile();
    return show('sProfile');
  }
  show('sHome');
}
window.addEventListener('hashchange', route);

// Runs on page load and whenever someone signs in or out.
supabase.auth.onAuthStateChange((event, session) => {
  // Token refreshes (and repeat "signed in" events when the tab regains focus) happen in the
  // background; don't jump screens, e.g. while an invoice is being read.
  if (session && S.user && session.user.id === S.user.id) return;
  // Supabase recommends not awaiting inside this callback, so the work runs right after it.
  setTimeout(async () => {
    S.user = session ? session.user : null;
    $('nav').classList.toggle('hidden', !S.user);
    if (!S.user) { S.profile = null; return route(); }
    try {
      await loadProfile();
      route();
    } catch (e) {
      show('sLogin');
      msg('loginMsg', 'bad', e.message);
    }
  }, 0);
});
