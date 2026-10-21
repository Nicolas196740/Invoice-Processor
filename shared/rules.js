/**
 * Vendor + category rules, ported from reference/Code.gs.
 * Step 2 uses matchVendor; the rest is filled in with the review screen in step 3.
 */
import { VENDORS } from './config.js';

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
