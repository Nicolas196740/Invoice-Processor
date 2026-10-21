import Anthropic from '@anthropic-ai/sdk';
import { MODEL, CATEGORIES, VENDORS } from '../../shared/config.js';

// Same tool as reference/Code.gs. strict: true makes Claude's answer always match this shape.
const TOOL = {
  name: 'record_invoice',
  description: 'Record the data read from a vendor invoice.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      known_vendor: { type: 'string', enum: VENDORS.map((v) => v.name).concat(['Other']),
        description: 'Which known vendor this is. GFS = Gordon Food Service. Use Other if none fit.' },
      vendor_name_on_invoice: { type: 'string', description: 'Company name as printed on the invoice.' },
      invoice_number: { type: 'string', description: 'Invoice number exactly as printed, keep leading zeros, no #.' },
      invoice_date: { type: 'string', description: 'The INVOICE date (not the due date, ship date or order date) as YYYY-MM-DD.' },
      invoice_total: { type: 'number', description: 'Final invoice total (amount due), including tax and fees.' },
      summary_groups: {
        type: 'array',
        description: 'GFS ONLY: every row of the "Category Summary" or "Group Summary" table, including Fuel Charge, using the TOTAL column (amount + tax). Do not include the Total row. Empty array for other vendors.',
        items: { type: 'object', additionalProperties: false,
          properties: { label: { type: 'string' }, total: { type: 'number' } }, required: ['label', 'total'] },
      },
      category_split: {
        type: 'array',
        description: 'NOT GFS: split of the invoice total by category (amounts must add up to invoice_total). Use only the allowed categories. Empty array for GFS.',
        items: { type: 'object', additionalProperties: false,
          properties: { category: { type: 'string', enum: CATEGORIES }, amount: { type: 'number' } }, required: ['category', 'amount'] },
      },
      notes: { type: 'string', description: 'Only if something needs a human: handwritten changes, credits/returns, unreadable numbers, missing pages. Empty string otherwise.' },
    },
    required: ['known_vendor', 'vendor_name_on_invoice', 'invoice_number', 'invoice_date', 'invoice_total',
               'summary_groups', 'category_split', 'notes'],
  },
};

const vendorHints = VENDORS.filter((v) => v.rule === 'ai')
  .map((v) => '- ' + v.name + ': allowed categories ' + v.allowed.join(', ') + '. ' + (v.hint || '')).join('\n');

const PROMPT =
  'This is a vendor invoice for Mister O1, a pizza restaurant. Read it and call the record_invoice tool. You must call the tool; do not answer in plain text.\n' +
  'Rules:\n' +
  '- Read numbers exactly as printed. Never guess a number; if unreadable, say so in notes.\n' +
  '- invoice_date is the invoice date, not the due date.\n' +
  '- GFS (Gordon Food Service) invoices have a "Category Summary" or "Group Summary" table on the last page. Copy every row into summary_groups with its TOTAL column.\n' +
  '- For other vendors, fill category_split so it adds up to the invoice total.\n' +
  vendorHints + '\n' +
  '- For unknown vendors, choose the most fitting categories from the list.';

/** Sends the PDF to Claude and returns the record_invoice fields. */
export async function readInvoice(base64Pdf) {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

  // This model doesn't allow forcing a tool (tool_choice "tool"), so we ask in the prompt
  // and try once more if it answers without calling the tool.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' }, // enough care to read numbers, without slowing every upload
      // If Claude's safety filter wrongly blocks a request, Anthropic retries it on another model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      tools: [TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf } },
        { type: 'text', text: PROMPT },
      ] }],
    });
    if (res.stop_reason === 'refusal') throw new Error('The AI declined to read this file. Try a clearer photo.');
    if (res.stop_reason === 'max_tokens') throw new Error('The AI answer was cut off. Try again.');
    const use = res.content.find((c) => c.type === 'tool_use' && c.name === TOOL.name);
    if (use) return use.input;
  }
  throw new Error('The AI did not return invoice data. Try a clearer photo.');
}
