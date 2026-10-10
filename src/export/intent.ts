/**
 * export/intent.ts
 *
 * Pure helper that decides whether a chat message is asking for a CSV export.
 *
 * Known limitation: a question that merely uses the word "export" as a noun,
 * e.g. "what is the export revenue by country", is treated as an export
 * request (`kind: 'new'` with the word removed). Plural/other forms such as
 * "how many exports did we have in August" do NOT match (whole-word match).
 */

export type ExportIntent = { kind: 'last' } | { kind: 'new'; question: string } | null;

const LAST_PHRASES = new Set([
  'csv',
  '/csv',
  'export',
  '/export',
  'send csv',
  'send as csv',
  'download',
  'download csv',
  'export csv',
  'as csv',
]);

const TRIGGER_WORD = /\b(csv|export|download|excel|spreadsheet)\b/i;

// Order matters: remove the longer phrases first.
const REMOVE_PATTERNS: RegExp[] = [
  /\b(as|in|to|into)\s+((a|an)\s+)?(csv|excel|spreadsheet)(\s+file)?\b/gi,
  /\b(csv|excel|spreadsheet)(\s+file)?\b/gi,
  /\bsend\s+me\b/gi,
  /\b(export|download)\b/gi,
];

// Words that carry no query content. If nothing else is left, the user meant
// "export the last result".
const FILLER = new Set([
  'please', 'pls', 'can', 'could', 'would', 'you', 'me', 'the', 'a', 'an', 'this', 'that', 'it',
  'now', 'as', 'in', 'to', 'into', 'of', 'send', 'give', 'get', 'file', 'result', 'results',
  'last', 'previous', 'data', 'query', 'answer', 'above', 'i', 'want', 'need', 'like', 'and',
]);

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function detectExportIntent(text: string): ExportIntent {
  if (typeof text !== 'string') return null;

  const normalised = normalise(text).toLowerCase();
  if (normalised === '') return null;
  if (LAST_PHRASES.has(normalised)) return { kind: 'last' };

  if (!TRIGGER_WORD.test(text)) return null;

  let question = text;
  for (const re of REMOVE_PATTERNS) {
    question = question.replace(re, ' ');
  }
  question = normalise(question)
    .replace(/^[\s,.:;!?-]+|[\s,.:;!?-]+$/g, '')
    .replace(/^of\s+/i, '');
  question = normalise(question);

  if (question === '') return { kind: 'last' };

  const tokens = question.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  if (tokens.every((t) => FILLER.has(t))) return { kind: 'last' };

  return { kind: 'new', question };
}
