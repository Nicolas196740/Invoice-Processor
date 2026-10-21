# Mister O1 — AI Invoice Processor (ISM4421 midterm)

A phone-friendly web app that reads a vendor invoice with Claude, splits it into accounting
categories using the restaurant's rules, logs it in the weekly tab of a **test** Google Sheet,
and emails it **only to the person who sent it**. It rebuilds a Google Apps Script app that runs
at Mister O1 Boca (see `reference/`).

## How it fits together

| Piece | What it does |
|---|---|
| **Browser** (Vite + plain JS, `src/`) | Sign-in, upload, review screen, dashboard. Holds no secrets. |
| **Supabase** | Google sign-in, the database (profiles, invoices, invoice_lines, vendors, categories) and the private `invoices` bucket for PDFs. Row Level Security on every table. |
| **Netlify Functions** (`netlify/functions/`) | Everything that needs a secret: Claude API, Google Sheets, Gmail. |
| **Netlify** | Hosts the site and runs the functions. |

## Database (`supabase/migrations/`)
- `001_init.sql`: tables, security rules, storage bucket, seed data (17 categories, 10 vendors).
- `002_cleanup_songforge.sql`: one-time cleanup of the old SongForge table (run by hand).
- `003_ai_jobs.sql`: one row per "read this invoice" request (used for the background reader).
- `004_save_invoice.sql`: email result columns + the `save_invoice` function.

## How an invoice is read (step 2)
Netlify stops normal functions after 30 seconds, and Claude can take 15–30 s on a scanned
invoice. So reading runs in a **background function** (up to 15 minutes):
1. The phone combines the photos into one PDF and uploads it to Supabase Storage.
2. `start-read` (normal function) checks who is signed in, creates an `ai_jobs` row, and starts
   `read-invoice-background`.
3. `read-invoice-background` downloads the PDF, sends it to Claude (`claude-sonnet-5-5`, tool
   `record_invoice`), and saves the answer in the job row.
4. The phone checks the job row every 2 seconds and shows the result.

## Google Sheet (step 4)
- The app writes **only** to the CLASS DEMO spreadsheet `1w9fMOnig0XHMxEd7ZW0oLyGhKh-BXXcnA4a3ZPhWduA`
  ("Mister O1 Invoices - CLASS DEMO"). The ID is hard-coded in `netlify/lib/sheets.js` and every request checks it.
  The old TEST LOG sheet (used by the work app) is also explicitly blocked.
- `check-invoice`: finds the week tab from the "2026 Calendar" tab (P10W3 = period 10, week 3) and looks for
  duplicates in the app's database and in column C of every weekly tab.
- `submit-invoice`: re-checks everything, creates the week tab from "Template" if needed (right after Template,
  D4 = year, E4 = "P10 W3") and writes label / amount / initials / comment in the first empty Food row.
  If Food is full, it adds a row inside the Food section.
- Known limit: two people pressing Send in the same second could pick the same empty row
  (Apps Script had a lock for this; the Sheets API doesn't).

## Send (step 5)
`submit-invoice` re-checks the invoice on the server, then in order:
1. writes the row in the weekly tab of the CLASS DEMO sheet;
2. moves the PDF from `<user>/pending/` to `<user>/<year>/<week tab>/GFS 10.15.26 9041333489.pdf`;
3. saves the invoice and its category lines together (`save_invoice` in `004_save_invoice.sql`; only the
   server can call it);
4. emails it with Nodemailer through Gmail **only to the signed-in user**. The address comes from their
   verified Supabase session, never from the browser, and `@bill.com` addresses are always refused.
   If the email fails, the invoice stays logged, the sheet comment says "EMAIL FAILED — send manually."
   and the error is saved in `invoices.email_error`.

Tests: `npm test` (rules, calendar/week logic, the sheet code against a fake spreadsheet, and the email).

## Public pages
- `/about` — the first screen for signed-out visitors (`/` sends them there): what the app does, how to test it,
  a link to the live spreadsheet, and a "Sign in to try it" button (`/#/signin` goes straight to Google).
- `/privacy` — Privacy Policy: what is stored (Google name and email, invoice PDFs, invoice data) and who handles it.

## Deploy (Netlify)
`netlify.toml` builds with `npm run build`, publishes `dist/`, and deploys `netlify/functions/`.
Environment variables (Netlify → Site configuration → Environment variables):
- Builds only: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
- Functions: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`,
  `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY` (all of a function's variables together must stay under 4KB)

## Local setup
1. `npm install`
2. Copy `.env.example` to `.env` (the two `VITE_` values are already filled in).
3. Fill in the secret values in `.env` (see the comments in `.env.example`).
4. `npx netlify-cli@latest dev` and open http://localhost:8888 (this runs the site **and** the
   functions; plain `npm run dev` runs only the site).

## Progress
- [x] Step 1: setup, Supabase tables, Google login, profile page
- [x] Step 2: upload + AI read
- [x] Step 3: rules + review screen (`shared/rules.js`)
- [x] Step 4: Google Sheet + period/week tabs
- [x] Step 5: email + save
- [ ] Step 6: dashboard
- [x] Step 7: deploy to Netlify (config + About/Privacy pages)
