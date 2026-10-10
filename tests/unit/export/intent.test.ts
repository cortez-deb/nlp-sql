/**
 * tests/unit/export/intent.test.ts
 */

import { detectExportIntent } from '../../../src/export/intent';

describe('detectExportIntent', () => {
  it.each([
    'csv', '/csv', 'export', '/export', 'send csv', 'send as csv',
    'download', 'download csv', 'export csv', 'as csv',
    '  CSV  ', 'Export CSV', 'send   as   csv',
  ])('"%s" -> last', (text) => {
    expect(detectExportIntent(text)).toEqual({ kind: 'last' });
  });

  it('extracts the question from a new export request', () => {
    expect(detectExportIntent('export all gold customers as csv')).toEqual({
      kind: 'new',
      question: 'all gold customers',
    });
  });

  it.each([
    ['download top 5 customers in a spreadsheet', 'top 5 customers'],
    ['send me all orders as an excel file', 'all orders'],
    ['send me all orders as excel file', 'all orders'],
    ['csv of last month sales', 'last month sales'],
    ['give me revenue by country into csv', 'give me revenue by country'],
    ['export csv of orders per month', 'orders per month'],
  ])('"%s" -> new "%s"', (text, question) => {
    expect(detectExportIntent(text)).toEqual({ kind: 'new', question });
  });

  it('falls back to last when nothing but filler remains', () => {
    expect(detectExportIntent('can you export that please')).toEqual({ kind: 'last' });
    expect(detectExportIntent('send me the last result as csv')).toEqual({ kind: 'last' });
    expect(detectExportIntent('export it as a csv file')).toEqual({ kind: 'last' });
  });

  it('does not match "exports" (plural) or other words containing the trigger', () => {
    expect(detectExportIntent('how many exports did we have in August')).toBeNull();
    expect(detectExportIntent('show me downloads by week')).toBeNull();
    expect(detectExportIntent('top 5 customers')).toBeNull();
  });

  it('returns null for empty or non-string input', () => {
    expect(detectExportIntent('')).toBeNull();
    expect(detectExportIntent('   ')).toBeNull();
    expect(detectExportIntent(undefined as unknown as string)).toBeNull();
  });

  it('known limitation: "export" used as a noun is treated as a new export request', () => {
    expect(detectExportIntent('what is the export revenue by country')).toEqual({
      kind: 'new',
      question: 'what is the revenue by country',
    });
  });
});
