// Send: re-checks everything on the server, then writes the row in the weekly tab of the TEST sheet.
// (Saving to Supabase and the email are added in step 5.)
import { admin, requireUser, httpError, json } from '../lib/supabase-admin.js';
import { sheet, googleApi } from '../lib/sheets.js';
import { findDuplicate } from '../lib/checks.js';
import { cleanInvoice, problems, invoiceLabel } from '../../shared/rules.js';

export default async (req) => {
  try {
    if (req.method !== 'POST') throw httpError(405, 'Use POST.');
    const db = admin();
    const user = await requireUser(req, db);
    const body = await req.json().catch(() => ({}));

    // Initials come from the user's profile in the database, never from the browser.
    const { data: profile } = await db.from('profiles').select('initials').eq('id', user.id).single();
    if (!profile || !profile.initials) throw httpError(400, 'Add your initials on the profile page first.');

    const pdfPath = String(body.pdfPath || '');
    if (!new RegExp('^' + user.id + '/pending/[\\w-]+\\.pdf$').test(pdfPath)) throw httpError(400, 'Bad file path.');

    // Same checks as the review screen, done again here so nobody can skip them.
    const d = cleanInvoice(body.invoice || {});
    const bad = problems(d);
    if (bad.length) throw httpError(400, bad[0]);

    const sh = sheet(googleApi());
    const dup = await findDuplicate(db, sh, d.vendor, d.invoiceNumber);
    if (dup && !body.allowDuplicate) throw httpError(409, 'Already logged: ' + dup);

    const label = invoiceLabel(d);
    const comment = [d.comment, dup ? 'Sent again (duplicate override)' : ''].filter(Boolean).join(' — ');
    const tab = await sh.getOrCreateWeekTab(d.date);
    const row = await sh.writeWeekRow(tab, label, d.total, profile.initials, comment);

    return json(200, { label, tab, row, duplicateOverride: !!dup });
  } catch (e) {
    return json(e.status && e.status < 500 ? e.status : 500, { error: e.message });
  }
};
