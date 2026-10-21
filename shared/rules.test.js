// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResult, cleanNumber, dupKey, keyFromLabel, invoiceLabel, emailBody, cleanInvoice, problems, gfsCategory } from './rules.js';

test('GFS groups map to our categories (Seafood + Grocery merge into Other food)', () => {
  const r = buildResult({
    known_vendor: 'GFS', vendor_name_on_invoice: 'Gordon Food Service', invoice_number: '9041152744',
    invoice_date: '2026-10-10', invoice_total: 451.13, notes: '', category_split: [],
    summary_groups: [
      { label: 'Produce', total: 298.07 }, { label: 'Poultry', total: 76.14 },
      { label: 'Seafood', total: 10 }, { label: 'Canned & Dry Grocery', total: 20 },
      { label: 'Disposables', total: 40.42 }, { label: 'Fuel Charge', total: 6.5 },
    ],
  }, 'GFS');
  assert.deepEqual(r.lines, [
    { category: 'Produce', amount: 298.07 }, { category: 'Poultry', amount: 76.14 },
    { category: 'Other food', amount: 30 }, { category: 'Paper & Packaging', amount: 40.42 },
    { category: 'Restaurant Expense', amount: 6.5 },
  ]);
  assert.deepEqual(r.warnings, []);
});

test('unknown GFS group gets a blank category and a warning', () => {
  assert.equal(gfsCategory('Smallwares'), '');
  const r = buildResult({ invoice_total: 5, summary_groups: [{ label: 'Smallwares', total: 5 }] }, 'GFS');
  assert.equal(r.lines[0].category, '');
  assert.match(r.warnings[0], /Smallwares/);
});

test('one-category vendor puts the whole total in that category', () => {
  const r = buildResult({ invoice_total: 120.5, category_split: [{ category: 'Meat', amount: 120.5 }] }, 'Capri');
  assert.deepEqual(r.lines, [{ category: 'Dairy', amount: 120.5 }]);
});

test('Tita keeps only Beverage / Other food from the AI split', () => {
  const r = buildResult({ invoice_total: 100, category_split: [
    { category: 'Beverage', amount: 60 }, { category: 'Dairy', amount: 40 }] }, 'Tita');
  assert.deepEqual(r.lines, [{ category: 'Beverage', amount: 60 }, { category: '', amount: 40 }]);
});

test('unknown vendor -> Other + warning', () => {
  const r = buildResult({ invoice_total: 10, category_split: [{ category: 'Pest Control', amount: 10 }] }, 'Other');
  assert.equal(r.vendor, 'Other');
  assert.match(r.warnings[0], /New vendor/);
});

test('invoice numbers are cleaned', () => {
  assert.equal(cleanNumber('#CO - 003885'), '003885');
  assert.equal(cleanNumber('# 9041152744'), '9041152744');
  assert.equal(cleanNumber('264945-SCHDL'), '264945-SCHDL');
});

test('duplicate key ignores leading zeros, prefixes and old vendor names', () => {
  assert.equal(dupKey('Warehouse', '003885'), dupKey('Warehouse', '3885'));
  assert.equal(keyFromLabel('Wynwood 10.10.26 #003885'), dupKey('Warehouse', 'CO - 3885'));
  assert.equal(keyFromLabel('GFS 10.10.26 #9041152744'), dupKey('GFS', '9041152744'));
  assert.notEqual(dupKey('GFS', '1'), dupKey('Capri', '1'));
  assert.equal(keyFromLabel('Total'), null);
});

test('label and email body match the old format', () => {
  assert.equal(invoiceLabel({ vendor: 'GFS', date: '2026-10-10', invoiceNumber: '9041152744' }), 'GFS 10.10.26 #9041152744');
  assert.equal(emailBody([{ category: 'Produce', amount: 298.07 }, { category: 'Meat', amount: 66.9 }]), 'Produce 298.07/ Meat 66.90');
});

test('Send is blocked unless categories add up to the total to the cent', () => {
  const d = cleanInvoice({ vendor: 'GFS', invoiceNumber: '1', date: '2026-10-10', total: 100,
    lines: [{ category: 'Produce', amount: 60 }, { category: 'Meat', amount: 39.99 }] });
  assert.match(problems(d)[0], /add up to 99.99/);
  d.lines[1].amount = 40;
  assert.deepEqual(problems(d), []);
});
