import { dupKey } from '../../shared/rules.js';

/** What the user sees for a repeat. On purpose it never says who sent it or any of their details. */
export function duplicateMessage(tab) {
  return 'This invoice was already logged' + (tab ? ' (sheet tab ' + tab + ')' : '') + '.';
}

/**
 * Was this vendor + invoice number already sent by ANYONE (Supabase or the CLASS DEMO sheet)?
 * The check is global on purpose (that's the demo); the answer only names the week tab.
 */
export async function findDuplicate(db, sh, vendor, invoiceNumber) {
  const key = dupKey(vendor, invoiceNumber);
  const { data, error } = await db.from('invoices').select('period_tab').eq('dup_key', key).limit(1);
  if (error) throw new Error('Could not check for duplicates: ' + error.message);
  if (data.length) return duplicateMessage(data[0].period_tab);
  const hit = await sh.findDuplicate(key);
  return hit ? duplicateMessage(hit.tab) : null;
}
