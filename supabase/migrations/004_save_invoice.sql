-- Step 5: email result columns + one function that saves an invoice and its lines together
-- (all or nothing, so there's never an invoice without its category lines).
alter table public.invoices add column emailed_to text;
alter table public.invoices add column email_error text;

create function public.save_invoice(inv jsonb, lines jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  insert into public.invoices (user_id, vendor, invoice_number, dup_key, invoice_date, total, period_tab,
                               sheet_row, sent_by, comment, pdf_path, duplicate_override)
  values ((inv->>'user_id')::uuid, inv->>'vendor', inv->>'invoice_number', inv->>'dup_key',
          (inv->>'invoice_date')::date, (inv->>'total')::numeric, inv->>'period_tab',
          (inv->>'sheet_row')::int, inv->>'sent_by', coalesce(inv->>'comment', ''), inv->>'pdf_path',
          coalesce((inv->>'duplicate_override')::boolean, false))
  returning id into new_id;

  insert into public.invoice_lines (invoice_id, category, amount)
  select new_id, l->>'category', (l->>'amount')::numeric from jsonb_array_elements(lines) l;

  return new_id;
end $$;

-- Only the server (service role) may call it; signed-in users still can't write invoices.
revoke execute on function public.save_invoice(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_invoice(jsonb, jsonb) to service_role;
