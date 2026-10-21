// Step 2 of reading an invoice (background function, up to 15 minutes):
// downloads the PDF from Supabase Storage, sends it to Claude, saves the answer in the job row.
// The "-background" at the end of the file name is what makes Netlify run it in the background.
import { admin } from '../lib/supabase-admin.js';
import { readInvoice } from '../lib/claude.js';
import { matchVendor } from '../../shared/rules.js';

const MAX_PDF_BYTES = 20 * 1024 * 1024; // Claude accepts up to 32 MB per request; base64 makes files ~33% bigger.

export default async (req) => {
  const db = admin();
  const { jobId } = await req.json().catch(() => ({}));
  if (!jobId) return;

  // Claim the job. Only a "queued" job created by start-read can run, and only once.
  const { data: job } = await db.from('ai_jobs')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', jobId).eq('status', 'queued').select('*').maybeSingle();
  if (!job) return;

  try {
    const { data: file, error } = await db.storage.from('invoices').download(job.pdf_path);
    if (error) throw new Error('Could not open the uploaded PDF: ' + error.message);
    if (file.size > MAX_PDF_BYTES) throw new Error('The invoice is too large. Try fewer or smaller photos.');
    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64');

    const extraction = await readInvoice(base64);
    const v = matchVendor(extraction.known_vendor, extraction.vendor_name_on_invoice);

    await db.from('ai_jobs').update({
      status: 'done',
      result: { extraction, vendor: v ? v.name : 'Other' },
      updated_at: new Date().toISOString(),
    }).eq('id', job.id);
  } catch (e) {
    console.error(e);
    await db.from('ai_jobs').update({
      status: 'error',
      error: e.message || 'Something went wrong reading the invoice.',
      updated_at: new Date().toISOString(),
    }).eq('id', job.id);
  }
};
