// Step 1 of reading an invoice (fast, normal function):
// checks who is signed in, creates a job row, and starts the background function.
import { admin, requireUser, httpError, json } from '../lib/supabase-admin.js';

export default async (req) => {
  try {
    if (req.method !== 'POST') throw httpError(405, 'Use POST.');
    const db = admin();
    const user = await requireUser(req, db);

    const { pdfPath } = await req.json().catch(() => ({}));
    // Only files in the user's own pending folder, e.g. "<user id>/pending/1729500000000.pdf".
    const ok = typeof pdfPath === 'string' && new RegExp('^' + user.id + '/pending/[\\w-]+\\.pdf$').test(pdfPath);
    if (!ok) throw httpError(400, 'Bad file path.');

    const { data: job, error } = await db.from('ai_jobs')
      .insert({ user_id: user.id, pdf_path: pdfPath }).select('id').single();
    if (error) throw new Error('Could not create the job: ' + error.message);

    // Background functions answer "202 Accepted" right away and keep running for up to 15 minutes.
    const bg = await fetch(new URL('/.netlify/functions/read-invoice-background', req.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    });
    if (bg.status !== 202) {
      await db.from('ai_jobs').update({ status: 'error', error: 'Could not start the AI reader.' }).eq('id', job.id);
      throw new Error('Could not start the AI reader (' + bg.status + ').');
    }
    return json(200, { jobId: job.id });
  } catch (e) {
    return json(e.status || 500, { error: e.message });
  }
};
