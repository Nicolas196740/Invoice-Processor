import { supabase } from './supabase.js';

// ───────── state + small helpers ─────────
const S = { user: null, profile: null, files: [], pollTimer: null };
const $ = (id) => document.getElementById(id);

function show(id) {
  ['sLoading', 'sLogin', 'sHome', 'sWorking', 'sResult', 'sProfile'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
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
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/.netlify/functions/start-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ pdfPath: path }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not start reading (' + res.status + ').');

    // 3) Check every 2 seconds until the background function is done (max 3 minutes).
    const job = await waitForJob(body.jobId);
    showResult(job.result, path);
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

// ───────── result (becomes the editable review screen in step 3) ─────────
function showResult(r, path) {
  const ex = r.extraction;
  const box = $('resultBox');
  box.innerHTML = '';
  const t = document.createElement('table');
  const row = (k, v) => {
    const tr = t.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = v;
  };
  row('Vendor (matched)', r.vendor);
  row('Name on invoice', ex.vendor_name_on_invoice);
  row('Invoice #', ex.invoice_number);
  row('Invoice date', ex.invoice_date);
  row('Total', '$' + money(ex.invoice_total));
  (ex.summary_groups || []).forEach((g) => row('GFS group: ' + g.label, money(g.total)));
  (ex.category_split || []).forEach((s) => row(s.category, money(s.amount)));
  box.appendChild(t);
  if (ex.notes) {
    const n = document.createElement('div');
    n.className = 'msg warn';
    n.textContent = '⚠️ AI note: ' + ex.notes;
    box.appendChild(n);
  }
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = 'Saved as ' + path;
  box.appendChild(p);
  S.files = [];
  renderThumbs();
  show('sResult');
}
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
