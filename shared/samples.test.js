// The 3 sample invoices on the About page (public/samples/, made by scripts/make_samples.py):
// what Claude should read from each one, and what the app's rules must turn that into.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResult, problems, cleanInvoice, invoiceLabel, emailBody } from './rules.js';
import { matchVendor } from './rules.js';
import { weekFromCalendar } from '../netlify/lib/sheet-logic.js';

const CAL = [['Period', 'StartDate', 'EndDate'], ['P10', '9/28/26', '10/25/26']];

const samples = [
  {
    file: 'sample-gfs-9041587206.pdf',
    read: { known_vendor: 'GFS', vendor_name_on_invoice: 'Gordon Food Service', invoice_number: '9041587206',
      invoice_date: '2026-10-20', invoice_total: 1068.87, category_split: [], notes: '',
      summary_groups: [
        { label: 'Seafood', total: 38.42 }, { label: 'Grocery', total: 209.80 }, { label: 'Produce', total: 90.24 },
        { label: 'Frozen', total: 93.80 }, { label: 'Dairy', total: 362.70 }, { label: 'Disposables', total: 129.84 },
        { label: 'Chemical', total: 81.38 }, { label: 'Beverage', total: 55.74 }, { label: 'Fuel Charge', total: 6.95 }] },
    expect: { vendor: 'GFS', number: '9041587206', tab: 'P10W4', label: 'GFS 10.20.26 #9041587206',
      body: 'Other food 248.22/ Produce 90.24/ Dough 93.80/ Dairy 362.70/ Paper & Packaging 129.84/ ' +
            'Janitorial & Cleaning Supplies 81.38/ Beverage 55.74/ Restaurant Expense 6.95' },
  },
  {
    file: 'sample-warehouse-CO-004512.pdf',
    read: { known_vendor: 'Warehouse', vendor_name_on_invoice: 'Warehouse 305', invoice_number: 'CO - 004512',
      invoice_date: '2026-10-21', invoice_total: 1320.00, summary_groups: [], notes: '',
      category_split: [{ category: 'Dough', amount: 1320.00 }] },
    expect: { vendor: 'Warehouse', number: '004512', tab: 'P10W4', label: 'Warehouse 10.21.26 #004512', body: 'Dough 1320.00' },
  },
  {
    file: 'sample-tita-11873.pdf',
    read: { known_vendor: 'Tita', vendor_name_on_invoice: 'Tita Italian Wines & Imports', invoice_number: '11873',
      invoice_date: '2026-10-19', invoice_total: 385.80, summary_groups: [], notes: '',
      category_split: [{ category: 'Beverage', amount: 385.80 }] },
    expect: { vendor: 'Tita', number: '11873', tab: 'P10W4', label: 'Tita 10.19.26 #11873', body: 'Beverage 385.80' },
  },
];

for (const s of samples) {
  test('sample ' + s.file + ' -> ' + s.expect.label, () => {
    const v = matchVendor(s.read.known_vendor, s.read.vendor_name_on_invoice);
    const r = buildResult(s.read, v ? v.name : 'Other');
    assert.equal(r.vendor, s.expect.vendor);
    assert.equal(r.invoiceNumber, s.expect.number);
    assert.deepEqual(r.warnings, []);
    const d = cleanInvoice({ vendor: r.vendor, invoiceNumber: r.invoiceNumber, date: r.date, total: r.total, lines: r.lines });
    assert.deepEqual(problems(d), [], 'categories add up to the total to the cent');
    assert.equal(invoiceLabel(d), s.expect.label);
    assert.equal(emailBody(d.lines), s.expect.body);
    assert.equal(weekFromCalendar(CAL, d.date).name, s.expect.tab);
  });
}

test('vendor is recognized from the letterhead alone too', () => {
  assert.equal(matchVendor('Other', 'Gordon Food Service').name, 'GFS');
  assert.equal(matchVendor('Other', 'WAREHOUSE 305').name, 'Warehouse');
  assert.equal(matchVendor('Other', 'Tita Italian Wines & Imports').name, 'Tita');
});
