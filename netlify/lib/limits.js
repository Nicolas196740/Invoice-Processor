// Daily limit on AI reads (Claude calls), enforced on the server before calling Claude.
export const DAILY_READS = 10;

// Accounts with a bigger limit. Matched on the email from the verified session.
const BIGGER_LIMITS = { '04munoznicolas@gmail.com': 50 };

export function dailyLimitFor(user) {
  const email = String((user && user.email) || '').toLowerCase();
  const confirmed = !!(user && (user.email_confirmed_at || user.confirmed_at)); // Google sign-ins are confirmed
  return (confirmed && BIGGER_LIMITS[email]) || DAILY_READS;
}

export function limitMessage(limit) {
  return 'Daily limit reached (' + limit + ' invoices). Try again tomorrow.';
}
