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

## How an invoice is read (step 2)
Netlify stops normal functions after 30 seconds, and Claude can take 15–30 s on a scanned
invoice. So reading runs in a **background function** (up to 15 minutes):
1. The phone combines the photos into one PDF and uploads it to Supabase Storage.
2. `start-read` (normal function) checks who is signed in, creates an `ai_jobs` row, and starts
   `read-invoice-background`.
3. `read-invoice-background` downloads the PDF, sends it to Claude (`claude-sonnet-5-5`, tool
   `record_invoice`), and saves the answer in the job row.
4. The phone checks the job row every 2 seconds and shows the result.

## Local setup
1. `npm install`
2. Copy `.env.example` to `.env` (the two `VITE_` values are already filled in).
3. Fill in `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY` in `.env`.
4. `npx netlify-cli@latest dev` and open http://localhost:8888 (this runs the site **and** the
   functions; plain `npm run dev` runs only the site).

## Progress
- [x] Step 1: setup, Supabase tables, Google login, profile page
- [x] Step 2: upload + AI read
- [ ] Step 3: rules + review screen
- [ ] Step 4: Google Sheet + period/week tabs
- [ ] Step 5: email + save
- [ ] Step 6: dashboard
- [ ] Step 7: deploy to Netlify
