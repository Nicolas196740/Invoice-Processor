import nodemailer from 'nodemailer';

// Class project: invoices must never reach accounting. Checked on every send.
const BLOCKED = /@bill\.com$/i;

/**
 * Builds the email. `to` must be the signed-in user's email from their verified Supabase session.
 * Subject: "[CLASS] GFS 10.15.26 #9041333489", body: "Produce 181.05/ Meat 592.42/ ...".
 */
export function buildEmail({ to, label, body, pdf, fileName }) {
  const from = process.env.GMAIL_USER;
  if (!from) throw new Error('Missing GMAIL_USER in the environment variables.');
  if (!to || !/^[^@\s]+@[^@\s]+$/.test(to)) throw new Error('Your account has no email address.');
  if (BLOCKED.test(to)) throw new Error('Refusing to email an accounting address from the class project.');
  return {
    from: '"Mister O1 Invoices (class project)" <' + from + '>',
    to,
    subject: '[CLASS] ' + label,
    text: body,
    attachments: [{ filename: fileName, content: pdf, contentType: 'application/pdf' }],
  };
}

/** Sends through Gmail with an App Password (needs 2-Step Verification on the Gmail account). */
export async function sendEmail(message) {
  const user = process.env.GMAIL_USER;
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, ''); // Google shows it as "abcd efgh ijkl mnop"
  if (!user || !pass) throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD in the environment variables.');
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transport.sendMail(message);
}
