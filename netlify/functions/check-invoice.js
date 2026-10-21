// Called by the review screen whenever vendor / date / invoice # change:
// which week tab it goes in, and whether it was already sent.
import { admin, requireUser, httpError, json } from '../lib/supabase-admin.js';
import { sheet, googleApi } from '../lib/sheets.js';
import { findDuplicate } from '../lib/checks.js';
import { cleanNumber } from '../../shared/rules.js';

export default async (req) => {
  try {
    if (req.method !== 'POST') throw httpError(405, 'Use POST.');
    const db = admin();
    await requireUser(req, db);
    const body = await req.json().catch(() => ({}));
    const vendor = String(body.vendor || '').trim();
    const number = cleanNumber(body.invoiceNumber);
    const date = String(body.date || '');
    const sh = sheet(googleApi());

    const out = { weekTab: null, duplicate: null, errors: [] };
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      try { out.weekTab = (await sh.weekInfo(date)).name; } catch (e) { out.errors.push(e.message); }
    } else {
      out.errors.push('Invoice date is missing.');
    }
    if (vendor && vendor !== 'Other' && number) out.duplicate = await findDuplicate(db, sh, vendor, number);
    return json(200, out);
  } catch (e) {
    return json(e.status && e.status < 500 ? e.status : 500, { error: e.message });
  }
};
