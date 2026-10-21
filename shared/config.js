/**
 * Mister O1 rules — copied from reference/Config.gs.
 * Used by the Netlify Functions (AI prompt + rules) and by the browser (review screen).
 * The same vendors and categories are also stored in Supabase (seeded in 001_init.sql).
 */

export const MODEL = 'claude-sonnet-5-5';

// Where the GFS fuel charge goes.
export const FUEL_CATEGORY = 'Restaurant Expense';

// Category names exactly as they are written in the emails to accounting.
export const CATEGORIES = [
  'Produce',
  'Poultry',
  'Meat',
  'Other food',
  'Dough',
  'Dairy',
  'Beverage',
  'Paper & Packaging',
  'Janitorial & Cleaning Supplies',
  'Restaurant Operating Supplies',
  'Linen',
  'R&M',
  'Restaurant Expense',
  'Pest Control',
  'Equipment Rental',
  'Office Expenses',
  'Miscellaneous',
];

// GFS "Category Summary" / "Group Summary" rows -> our category.
// Keys are lowercase words that appear in the GFS row name.
export const GFS_GROUPS = {
  seafood: 'Other food',
  grocery: 'Other food',
  produce: 'Produce',
  poultry: 'Poultry',
  meat: 'Meat',
  frozen: 'Dough',          // only frozen item is the gluten-free crust
  dairy: 'Dairy',
  disposable: 'Paper & Packaging',
  chemical: 'Janitorial & Cleaning Supplies',
  beverage: 'Beverage',
  fuel: '__FUEL__',         // uses FUEL_CATEGORY
};

// Vendors.
//   rule 'gfs'  -> split using the GFS summary page
//   rule 'ai'   -> the AI splits the invoice between the categories in 'allowed'
//   category    -> the whole invoice goes to that one category
// 'match' is how the app recognizes the vendor from the invoice letterhead or from old sheet rows.
export const VENDORS = [
  { name: 'GFS',        match: /gordon|\bgfs\b/i,                     rule: 'gfs' },
  { name: 'Capri',      match: /capri/i,                               category: 'Dairy' },
  // Warehouse 305 (used to be called Wynwood — old rows still match so duplicates are caught)
  { name: 'Warehouse',  match: /wh?arehouse|wyn?w?ood|wywnood/i,       category: 'Dough' },
  { name: 'Tita',       match: /\btita\b/i,                            rule: 'ai', allowed: ['Beverage', 'Other food'],
    hint: 'Wine is Beverage. Truffle oil (and other food items) is Other food. Usually the whole invoice is one or the other.' },
  { name: 'PW',         match: /^\s*p\.?\s*w\.?\s*$/i,                 category: 'Beverage' },
  { name: 'Unifirst',   match: /uni\s*f\w{0,3}st/i,                    category: 'Linen' },
  { name: 'Alsco',      match: /alsco/i,                               category: 'Linen' },
  { name: 'ER Pumping', match: /pumping|^\s*e\.?\s*r\.?\s*p?\s*$/i,    category: 'R&M' },
  { name: 'Commissary', match: /com+is+ary/i,                          category: 'R&M' },
  { name: 'Cozzini',    match: /cozzini/i,                             category: 'R&M' },
];
