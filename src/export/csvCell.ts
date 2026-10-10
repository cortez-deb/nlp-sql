/**
 * export/csvCell.ts
 *
 * Pure functions that turn database values into safe CSV cell text.
 */

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Spreadsheet apps execute cells that start with = + - @ tab or CR.
 * Prefix a single quote, EXCEPT when the whole string is a plain number
 * (e.g. "-12.50", or big integers delivered as strings by bigNumberStrings).
 */
function guardFormula(s: string): string {
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) {
    return `'${s}`;
  }
  return s;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  switch (typeof value) {
    case 'string':
      return guardFormula(value);
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
    case 'object': {
      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? '' : value.toISOString();
      }
      if (Buffer.isBuffer(value)) {
        return '0x' + value.toString('hex');
      }
      try {
        // Plain objects/arrays (JSON columns). JSON text starts with { [ or ",
        // never with a formula character.
        return JSON.stringify(value) ?? '';
      } catch {
        return String(value);
      }
    }
    default:
      return guardFormula(String(value));
  }
}
