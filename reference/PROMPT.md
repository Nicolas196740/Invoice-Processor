You are helping me build and deploy my ISM4421 (Applied AI for Business) midterm project.
I'm a Business student, not a programmer. Before each step, explain in plain language what
it does and why, then give me numbered steps to run. Keep the code simple. If something
breaks, tell me what went wrong in plain words.

## What to build
An "AI Invoice Processor" web app for a pizza restaurant (Mister O1 Boca), deployed on
Netlify, with Supabase for login + database + PDF storage. It rebuilds an app I already run
at work in Google Apps Script. The reference files are in the `reference/` folder of this
project (Code.gs, Config.gs, Index.html). Read them first, and reuse their vendor rules,
categories and checks exactly.

## Stack
- Frontend: Vite + plain JavaScript, mobile-first.
- Hosting: Netlify, connected to my GitHub repo (I'll connect it myself; tell me when).
- Backend: Netlify Functions for everything secret (Claude API, Google Sheets, email).
- Supabase:
  - Auth: "Sign in with Google" (Supabase Google provider). Walk me through creating the
    Google Cloud OAuth client (consent screen, authorized redirect URI = my Supabase
    callback URL) and enabling Google in Supabase. Keep the OAuth consent screen in
    "Testing" mode so only test users I add can log in.
    On first login, create a profiles row with the name from Google and initials from it
    (e.g. "Nicolas Munoz" -> "NM"); let the user edit initials on a profile page.
    Initials go in the sheet's "Sent By" column.
  - Storage: private bucket "invoices" for the PDFs (do NOT use Google Drive).
  - Tables: profiles, invoices (vendor, invoice_number, invoice_date, total, period_tab,
    sent_by, pdf_path, duplicate_override, created_at), invoice_lines (invoice_id,
    category, amount). Row Level Security on every table.
- AI: Anthropic Claude API, called only from a Netlify Function.
- Email: Nodemailer through my Gmail (04munoznicolas@gmail.com) using a Gmail App Password
  (walk me through creating it; it needs 2-Step Verification on). Send each invoice email
  ONLY to the email of the logged-in user who sent it, taken from their verified Supabase
  session on the server, never from anything the browser sends. Never send to any
  accounting address.
- Google Sheet: write to my TEST spreadsheet only:
  ID 1IgetoijtxOSRaltXSUMFxuPXQDh7vvQ9Eocrkkv-Xr0 ("Mister O1 Invoice App - TEST LOG").
  Use a Google Cloud service account + the Sheets API; walk me through creating it and
  sharing the sheet with it. Hard-code a check that refuses to write to any other
  spreadsheet ID.
- Secrets (ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY, GMAIL_USER, GMAIL_APP_PASSWORD,
  Google service account JSON) go in Netlify environment variables only, never in the
  browser or GitHub. Add .gitignore + .env.example.

## The flow
1. User signs in with Google.
2. User uploads one invoice PDF, or several phone photos that the browser combines into one
   PDF with jsPDF (one photo per page, max 2200px long side, JPEG ~0.72).
3. Browser uploads the PDF to Supabase Storage, then calls a Netlify Function with the
   storage path (don't send big files in the function body).
4. The function sends the PDF to Claude as a base64 "document" block with a tool
   "record_invoice" returning: known_vendor (enum of vendor names + "Other"),
   vendor_name_on_invoice, invoice_number, invoice_date (YYYY-MM-DD; the invoice date,
   NOT the due date), invoice_total, summary_groups [{label,total}] (GFS only: every row
   of the "Category Summary"/"Group Summary" table incl. Fuel Charge, using the TOTAL
   column), category_split [{category,amount}] (non-GFS), notes.
   LESSON FROM v1: the model rejected tool_choice {type:"tool"}. Use {type:"auto"} and say
   in the prompt that it MUST call the tool. Use the current Claude Sonnet model ID
   (check the docs).
5. Apply rules in code (same as reference/Config.gs):
   Categories: Produce, Poultry, Meat, Other food, Dough, Dairy, Beverage,
   Paper & Packaging, Janitorial & Cleaning Supplies, Restaurant Operating Supplies,
   Linen, R&M, Restaurant Expense, Pest Control, Equipment Rental, Office Expenses,
   Miscellaneous.
   GFS summary groups: Seafood + Grocery -> Other food, Produce -> Produce,
   Poultry -> Poultry, Meat -> Meat, Frozen -> Dough, Dairy -> Dairy,
   Disposables -> Paper & Packaging, Chemical -> Janitorial & Cleaning Supplies,
   Beverage -> Beverage, Fuel Charge -> Restaurant Expense.
   Vendors: GFS (Gordon Food Service) = summary rule; Capri = Dairy;
   Warehouse (formerly "Wynwood"; aliases wynwood/wywnood/wharehouse) = Dough;
   Tita = AI picks Beverage (wine) or Other food (truffle oil); PW = Beverage;
   Unifirst = Linen; Alsco = Linen; ER Pumping = R&M; Commissary = R&M; Cozzini = R&M.
   Unknown vendor -> AI suggests, user must confirm and type the vendor name.
   Clean invoice numbers: strip "#" and short letter prefixes ("CO - 003885" -> "003885").
6. Review screen: user can edit vendor, date, invoice #, total, category lines.
   Send stays locked until:
   - categories add up to the invoice total to the cent, AND
   - not a duplicate: same vendor + invoice-number digits (leading zeros dropped), checked
     against the Supabase invoices table AND the weekly tabs of the test sheet
     (rows look like "GFS 10.10.26 #9041152744" in column C). Old aliases count as the
     same vendor. Allow "Send anyway" with a checkbox and record the override.
7. On Send:
   a) Find the week tab from the sheet's "2026 Calendar" tab (header row has "Period",
      "StartDate", "EndDate"; rows P1..P12). Week = floor(days since period start / 7) + 1.
      Tab name format: P10W2 (2-digit period). If the tab doesn't exist, copy the
      "Template" tab, rename it, place it right after Template, and set D4 = year,
      E4 = "P10 W2".
   b) In that tab, write to the first empty row of the "Food" section (column B says
      "Food"; the section ends where the next label in column B starts; insert a row if
      full): C = "Vendor MM.DD.YY #InvoiceNumber", D = total, E = sender initials,
      F = comment.
   c) Save invoice + lines in Supabase.
   d) Email (to the logged-in user only): subject "[CLASS] Vendor MM.DD.YY #InvoiceNumber",
      body like "Produce 298.07/ Poultry 76.14/ Meat 66.92", PDF attached.
8. Dashboard page: invoices by period/week with category totals, who sent each, PDF link.

## Things to check and tell me about
- Netlify Function time limits: Claude reading a 3–4 page scanned PDF can take 15–30 s.
  Check the current limits and pick an approach that won't time out (faster model,
  background function + polling, or a Supabase Edge Function). Explain the trade-off
  before choosing.
- Seed Supabase with my categories and vendors.

## How we work
Small steps, stopping after each so I can test: (1) setup + Supabase tables + Google login,
(2) upload + AI read, (3) rules + review screen, (4) Google Sheet + period/week tabs,
(5) email + save, (6) dashboard, (7) deploy to Netlify. At the end, give me the Netlify URL,
a plain-language README of the architecture, and a list of what you built vs. what I did,
for my AI-use disclosure.
