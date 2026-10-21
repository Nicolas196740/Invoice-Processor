import { dupKey, invoiceLabel } from '../../shared/rules.js';

/** Same vendor + invoice digits already saved in Supabase or written in the TEST sheet? Returns a description or null. */
export async function findDuplicate(db, sh, vendor, invoiceNumber) {
  const key = dupKey(vendor, invoiceNumber);
  const { data, error } = await db.from('invoices')
    .select('vendor, invoice_number, invoice_date, total, period_tab, sent_by')
    .eq('dup_key', key).limit(1);
  if (error) throw new Error('Could not check for duplicates: ' + error.message);
  if (data.length) {
    const x = data[0];
    return 'App ' + x.period_tab + ': ' + invoiceLabel({ vendor: x.vendor, date: x.invoice_date, invoiceNumber: x.invoice_number }) +
      ' ($' + Number(x.total).toFixed(2) + ', sent by ' + x.sent_by + ')';
  }
  return sh.findDuplicate(key);
}
