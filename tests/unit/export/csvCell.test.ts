/**
 * tests/unit/export/csvCell.test.ts
 */

import { stringify } from 'csv-stringify/sync';
import { parse } from 'csv-parse/sync';
import { csvCell } from '../../../src/export/csvCell';

describe('csvCell', () => {
  it('formula guard prefixes a quote on strings starting with = + - @ tab CR', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('-abc')).toBe("'-abc");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('+254712345001')).toBe("'+254712345001");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('\rx')).toBe("'\rx");
  });

  it('leaves plain numeric strings alone, including negatives and big integers', () => {
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell('12.50')).toBe('12.50');
    expect(csvCell('-7')).toBe('-7');
    expect(csvCell('9007199254740993123')).toBe('9007199254740993123');
  });

  it('does not treat near-numbers as numbers', () => {
    expect(csvCell('-12.')).toBe("'-12.");
    expect(csvCell('-1e5')).toBe("'-1e5");
    expect(csvCell('--1')).toBe("'--1");
  });

  it('leaves ordinary strings unchanged', () => {
    expect(csvCell('hello')).toBe('hello');
    expect(csvCell('Zoë')).toBe('Zoë');
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('')).toBe('');
  });

  it('null and undefined become empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('numbers, bigints, booleans', () => {
    expect(csvCell(42)).toBe('42');
    expect(csvCell(-1.5)).toBe('-1.5');
    expect(csvCell(10n)).toBe('10');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(false)).toBe('false');
  });

  it('Date -> ISO string; invalid Date -> empty', () => {
    expect(csvCell(new Date('2026-10-07T19:05:01.000Z'))).toBe('2026-10-07T19:05:01.000Z');
    expect(csvCell(new Date('nope'))).toBe('');
  });

  it('Buffer -> 0x hex', () => {
    expect(csvCell(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe('0xdeadbeef');
  });

  it('plain object and array -> JSON', () => {
    expect(csvCell({ a: 1, b: ['x'] })).toBe('{"a":1,"b":["x"]}');
    expect(csvCell([1, 2])).toBe('[1,2]');
  });

  it('header names get the same guard', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe("'=HYPERLINK(\"http://evil\")");
    expect(csvCell('total')).toBe('total');
  });

  it('commas, quotes and newlines round-trip through csv-stringify and csv-parse', () => {
    const values = ['a,b', 'say "hi"', 'line1\nline2', 'cr\rhere', 'crlf\r\nhere', 'plain', "it's", ''];
    const cells = values.map(csvCell);
    const text = stringify([cells], {
      record_delimiter: 'windows',
      quoted_string: false,
      quoted_match: /[\r\n]/,
    });
    const parsed = parse(text, { relax_column_count: false }) as string[][];
    expect(parsed).toEqual([values]);
  });
});
