import { supabase } from './supabase.js';

// ───────── state + small helpers ─────────
const S = { user: null, profile: null };
const $ = (id) => document.getElementById(id);

function show(id) {
  ['sLoading', 'sLogin', 'sHome', 'sProfile'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
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
  fillProfile();
  msg('profileMsg', 'ok', 'Saved.');
};

// ───────── pages ─────────
function route() {
  if (!S.user) return show('sLogin');
  // No initials yet (e.g. Google gave no name) -> send them to the profile page first.
  if (location.hash === '#/profile' || !S.profile.initials) {
    fillProfile();
    return show('sProfile');
  }
  $('hello').textContent = 'Signed in as ' + S.profile.full_name + ' (' + S.profile.initials + ').';
  show('sHome');
}
window.addEventListener('hashchange', route);

// Runs on page load and whenever someone signs in or out.
supabase.auth.onAuthStateChange((_event, session) => {
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
