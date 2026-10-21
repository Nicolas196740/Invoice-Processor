// Security tests for the server code (fake database, fake users A and B). Run with: npm test
// The database rules themselves (Row Level Security + Storage) are tested against the real
// database by supabase/tests/security_test.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRead } from '../functions/start-read.js';
import { isOwnPendingPath, isInOwnFolder } from './supabase-admin.js';
import { dailyLimitFor, limitMessage } from './limits.js';
import { findDuplicate, duplicateMessage } from './checks.js';
import { dupKey } from '../../shared/rules.js';

const A = { id: 'aaaaaaaa-0000-4000-8000-00000000000a', email: 'a@example.com', email_confirmed_at: '2026-10-01' };
const B = { id: 'bbbbbbbb-0000-4000-8000-00000000000b', email: 'b@example.com', email_confirmed_at: '2026-10-01' };
const OWNER = { id: 'cccccccc-0000-4000-8000-00000000000c', email: '04MunozNicolas@gmail.com', email_confirmed_at: '2026-10-01' };

// ───────── a tiny fake Supabase: logins by token, start_ai_job with a real per-user daily count ─────────
function fakeDb() {
  const users = { 'token-a': A, 'token-b': B, 'token-owner': OWNER };
  const jobsToday = {};
  const calls = [];
  return {
    calls,
    auth: { getUser: async (t) => (users[t] ? { data: { user: users[t] }, error: null } : { data: {}, error: { message: 'bad' } }) },
    rpc: async (name, args) => {
      calls.push([name, args]);
      const n = jobsToday[args.p_user] || 0;
      if (n >= args.p_limit) return { data: null, error: null };
      jobsToday[args.p_user] = n + 1;
      return { data: 'job-' + args.p_user.slice(0, 1) + '-' + (n + 1), error: null };
    },
    from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({}) }) }) }),
  };
}
const req = (token, body) => new Request('https://example.com/.netlify/functions/start-read', {
  method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const read = async (db, token, pdfPath) => {
  const res = await startRead(req(token, { pdfPath }), { db, trigger: async () => true });
  return { status: res.status, body: await res.json() };
};

test('A cannot start an AI read of B\'s PDF by guessing its path', async () => {
  const db = fakeDb();
  for (const p of [B.id + '/pending/1.pdf', B.id + '/2026/P10W4/GFS 10.20.26 9041587206.pdf',
                   A.id + '/pending/../../' + B.id + '/pending/1.pdf', '/' + B.id + '/pending/1.pdf']) {
    const r = await read(db, 'token-a', p);
    assert.equal(r.status, 400, p);
  }
  assert.equal(db.calls.length, 0, 'nothing reached the database');
  assert.equal((await read(db, 'token-a', A.id + '/pending/1.pdf')).status, 200);
});

test('no login, no read', async () => {
  const r = await read(fakeDb(), 'stolen-or-made-up', A.id + '/pending/1.pdf');
  assert.equal(r.status, 401);
});

test('path rules: only your own folder', () => {
  assert.ok(isOwnPendingPath(A.id, A.id + '/pending/1792563450935.pdf'));
  assert.ok(!isOwnPendingPath(A.id, B.id + '/pending/1792563450935.pdf'));
  assert.ok(!isOwnPendingPath(A.id, A.id + '/pending/../x.pdf'));
  assert.ok(isInOwnFolder(A.id, A.id + '/2026/P10W4/GFS 10.20.26 9041587206.pdf'));
  assert.ok(!isInOwnFolder(A.id, B.id + '/2026/P10W4/x.pdf'));
  assert.ok(!isInOwnFolder(A.id, A.id + '/../' + B.id + '/x.pdf'));
});

test('the 11th read in a day is refused with a friendly message', async () => {
  const db = fakeDb();
  for (let i = 1; i <= 10; i++) assert.equal((await read(db, 'token-a', A.id + '/pending/' + i + '.pdf')).status, 200, 'read ' + i);
  const r = await read(db, 'token-a', A.id + '/pending/11.pdf');
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'Daily limit reached (10 invoices). Try again tomorrow.');
  // B has their own count.
  assert.equal((await read(db, 'token-b', B.id + '/pending/1.pdf')).status, 200);
});

test('the owner account gets 50 a day; the email must be confirmed', async () => {
  assert.equal(dailyLimitFor(OWNER), 50);
  assert.equal(dailyLimitFor({ ...OWNER, email_confirmed_at: null }), 10);
  assert.equal(dailyLimitFor(A), 10);
  assert.equal(limitMessage(50), 'Daily limit reached (50 invoices). Try again tomorrow.');
  const db = fakeDb();
  for (let i = 1; i <= 50; i++) await read(db, 'token-owner', OWNER.id + '/pending/' + i + '.pdf');
  assert.equal((await read(db, 'token-owner', OWNER.id + '/pending/51.pdf')).status, 429);
});

test('duplicate check works across users without saying who sent it', async () => {
  // B already sent GFS 9041587206. A tries the same invoice.
  const filters = [];
  const db = {
    from: (table) => ({
      select: (cols) => ({
        eq: (col, val) => {
          filters.push([table, cols, col, val]);
          return { limit: async () => ({ data: val === dupKey('GFS', '9041587206')
            ? [{ period_tab: 'P10W4', sent_by: 'UB', total: 1068.87, user_id: B.id }] : [], error: null }) };
        },
      }),
    }),
  };
  const noSheetHit = { findDuplicate: async () => null };
  const msg = await findDuplicate(db, noSheetHit, 'GFS', '9041587206');
  assert.equal(msg, 'This invoice was already logged (sheet tab P10W4).');
  for (const secret of ['UB', '1068', B.id, B.email]) assert.ok(!msg.includes(secret), 'leaks ' + secret);
  assert.deepEqual(filters[0], ['invoices', 'period_tab', 'dup_key', dupKey('GFS', '9041587206')], 'global lookup, only the week tab read');

  // Only in the sheet (e.g. sent before the app saved invoices).
  const sheetHit = { findDuplicate: async () => ({ tab: 'P10W3', row: 9 }) };
  assert.equal(await findDuplicate(db, sheetHit, 'Warehouse', '004512'), 'This invoice was already logged (sheet tab P10W3).');
  assert.equal(await findDuplicate(db, noSheetHit, 'Warehouse', '004512'), null);
  assert.equal(duplicateMessage(null), 'This invoice was already logged.');
});
