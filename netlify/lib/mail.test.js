import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { buildEmail } from './mail.js';

process.env.GMAIL_USER = '04munoznicolas@gmail.com';
const base = { label: 'GFS 10.15.26 #9041333489', body: 'Produce 181.05/ Meat 592.42', pdf: Buffer.from('%PDF-1.4'), fileName: 'GFS 10.15.26 9041333489.pdf' };

test('email goes to the signed-in user with the old subject/body format and the PDF', async () => {
  const m = buildEmail({ ...base, to: 'nico@example.com' });
  assert.equal(m.to, 'nico@example.com');
  assert.equal(m.subject, '[CLASS] GFS 10.15.26 #9041333489');
  assert.equal(m.text, 'Produce 181.05/ Meat 592.42');
  // Render it for real (without sending) to be sure Nodemailer accepts it.
  const info = await nodemailer.createTransport({ jsonTransport: true }).sendMail(m);
  const sent = JSON.parse(info.message);
  assert.equal(sent.attachments[0].filename, 'GFS 10.15.26 9041333489.pdf');
  assert.deepEqual(sent.to, [{ address: 'nico@example.com', name: '' }]);
});

test('never emails accounting', () => {
  assert.throws(() => buildEmail({ ...base, to: 'payables@bill.com' }), /Refusing/);
  assert.throws(() => buildEmail({ ...base, to: '' }), /no email/);
});
