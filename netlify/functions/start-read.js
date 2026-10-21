// Step 1 of reading an invoice (fast, normal function):
// checks who is signed in, enforces the daily limit, creates a job row, and starts the background function.
import { admin, requireUser, httpError, json, isOwnPendingPath } from '../lib/supabase-admin.js';
import { dailyLimitFor, limitMessage } from '../lib/limits.js';

/** The real work, with the database and the background trigger passed in (so tests can use fakes). */
export async function startRead(req, { db, trigger }) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'Use POST.');
    const user = await requireUser(req, db);

    const { pdfPath } = await req.json().catch(() => ({}));
    // Only files in the user's OWN pending folder, e.g. "<user id>/pending/1729500000000.pdf".
    if (!isOwnPendingPath(user.id, pdfPath)) throw httpError(400, 'Bad file path.');

    // Counts today's reads and creates the job in one locked step, so rapid clicks can't get past the limit.
    const limit = dailyLimitFor(user);
    const { data: jobId, error } = await db.rpc('start_ai_job', { p_user: user.id, p_pdf_path: pdfPath, p_limit: limit });
    if (error) throw new Error('Could not create the job: ' + error.message);
    if (!jobId) throw httpError(429, limitMessage(limit));

    if (!(await trigger(jobId))) {
      await db.from('ai_jobs').update({ status: 'error', error: 'Could not start the AI reader.' }).eq('id', jobId).eq('user_id', user.id);
      throw new Error('Could not start the AI reader.');
    }
    return json(200, { jobId });
  } catch (e) {
    return json(e.status || 500, { error: e.message });
  }
}

export default (req) => startRead(req, {
  db: admin(),
  // Background functions answer "202 Accepted" right away and keep running for up to 15 minutes.
  trigger: async (jobId) => {
    const bg = await fetch(new URL('/.netlify/functions/read-invoice-background', req.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    return bg.status === 202;
  },
});
