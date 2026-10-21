// Send: re-checks everything on the server, then
//   1) writes the row in the weekly tab of the CLASS DEMO sheet,
//   2) moves the PDF out of "pending" into <user>/<year>/<week tab>/,
//   3) saves the invoice + category lines in Supabase,
//   4) emails it ONLY to the signed-in user (address from their verified session).
import { admin, requireUser, httpError, json } from '../lib/supabase-admin.js';
import { sheet, googleApi } from '../lib/sheets.js';
import { findDuplicate } from '../lib/checks.js';
import { buildEmail, sendEmail } from '../lib/mail.js';
import { cleanInvoice, problems, invoiceLabel, emailBody, dupKey } from '../../shared/rules.js';

/** "GFS 10.15.26 #9041333489" -> "GFS 10.15.26 9041333489.pdf" (characters Storage accepts). */
function fileNameFor(label) {
  return label.replace(/[^A-Za-z0-9 ._()-]/g, '').replace(/\s+/g, ' ').trim() + '.pdf';
}

export default async (req) => {
  const done = []; // what already happened, so an error message can say so
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
    const text = emailBody(d.lines);
    const comment = [d.comment, dup ? 'Sent again (duplicate override)' : ''].filter(Boolean).join(' — ');

    // 1) Sheet row
    const tab = await sh.getOrCreateWeekTab(d.date);
    const row = await sh.writeWeekRow(tab, label, d.total, profile.initials, comment);
    done.push('written to sheet tab ' + tab + ' row ' + row);

    // 2) File the PDF: <user id>/2026/P10W3/GFS 10.15.26 9041333489.pdf
    const bucket = db.storage.from('invoices');
    const fileName = fileNameFor(label);
    let finalPath = user.id + '/' + d.date.slice(0, 4) + '/' + tab + '/' + fileName;
    let mv = await bucket.move(pdfPath, finalPath);
    if (mv.error && /exist/i.test(mv.error.message)) { // same name already filed (e.g. a duplicate override)
      finalPath = finalPath.replace(/\.pdf$/, ' (' + Date.now() + ').pdf');
      mv = await bucket.move(pdfPath, finalPath);
    }
    if (mv.error) throw new Error('Could not file the PDF: ' + mv.error.message);
    done.push('PDF filed');

    // 3) Save invoice + lines together
    const { data: invoiceId, error: saveErr } = await db.rpc('save_invoice', {
      inv: {
        user_id: user.id, vendor: d.vendor, invoice_number: d.invoiceNumber, dup_key: dupKey(d.vendor, d.invoiceNumber),
        invoice_date: d.date, total: d.total, period_tab: tab, sheet_row: row, sent_by: profile.initials,
        comment, pdf_path: finalPath, duplicate_override: !!dup,
      },
      lines: d.lines,
    });
    if (saveErr) throw new Error('Could not save the invoice: ' + saveErr.message);
    done.push('saved');

    // 4) Email — to the signed-in user only. If it fails, the invoice stays logged and is flagged.
    let emailError = null;
    try {
      const { data: pdf, error } = await bucket.download(finalPath);
      if (error) throw new Error('could not attach the PDF: ' + error.message);
      await sendEmail(buildEmail({ to: user.email, label, body: text, pdf: Buffer.from(await pdf.arrayBuffer()), fileName }));
      await db.from('invoices').update({ emailed_to: user.email }).eq('id', invoiceId);
    } catch (e) {
      emailError = e.message;
      await db.from('invoices').update({ email_error: emailError }).eq('id', invoiceId);
      await sh.writeComment(tab, row, ['EMAIL FAILED — send manually.', comment].filter(Boolean).join(' ')).catch(() => {});
    }

    const { data: link } = await bucket.createSignedUrl(finalPath, 60 * 60);
    return json(200, {
      label, subject: '[CLASS] ' + label, to: user.email, body: text, tab, row,
      fileUrl: link ? link.signedUrl : null, emailError, duplicateOverride: !!dup,
    });
  } catch (e) {
    const msg = done.length ? e.message + ' (Already ' + done.join(', ') + '.)' : e.message;
    return json(e.status && e.status < 500 ? e.status : 500, { error: msg });
  }
};
