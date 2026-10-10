import { formatAnswer, friendlyError, escapeWhatsAppText } from '../src/format';
import type { QueryResult } from 'nlsql';

describe('Formatting module', () => {
  const baseResult: QueryResult = {
    sql: 'SELECT * FROM test',
    results: [],
    error: null,
    attempts: 1,
    truncated: false,
    rowCount: 0,
    timing: {
      retrievalMs: 10,
      generationMs: 100,
      validationMs: 5,
      executionMs: 20,
      totalMs: 135,
    },
  };

  it('renders zero rows as "No matching records found."', () => {
    const res = formatAnswer({ ...baseResult, rowCount: 0, results: [] });
    expect(res).toBe('No matching records found.');
  });

  it('renders single value (1 row, 1 col) with summary as summary only', () => {
    const res = formatAnswer({
      ...baseResult,
      rowCount: 1,
      results: [{ count: 42 }],
      summary: 'There are 42 active customers.',
    });
    expect(res).toBe('There are 42 active customers.');
  });

  it('renders small table when rowCount >= 2', () => {
    const res = formatAnswer({
      ...baseResult,
      rowCount: 2,
      results: [
        { name: 'Widget A', price: 15.5 },
        { name: 'Widget B', price: 99.0 },
      ],
      summary: 'Found 2 widgets.',
    });
    expect(res).toMatchSnapshot('small table');
    expect(res).toContain('Widget A');
    expect(res).toContain('Widget B');
    expect(res).toContain('Found 2 widgets.');
  });

  it('renders wide table with +N more columns indicator', () => {
    const res = formatAnswer({
      ...baseResult,
      rowCount: 2,
      results: [
        { c1: 'A', c2: 'B', c3: 'C', c4: 'D', c5: 'E', c6: 'F' },
        { c1: '1', c2: '2', c3: '3', c4: '4', c5: '5', c6: '6' },
      ],
    });
    expect(res).toMatchSnapshot('wide table');
    expect(res).toContain('+2 more columns');
  });

  it('renders 10+ rows footer and export prompt when rows are cut', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      item: `Item ${i + 1}`,
      qty: (i + 1) * 10,
    }));
    const res = formatAnswer(
      {
        ...baseResult,
        rowCount: 15,
        results: rows,
      },
      { exportEnabled: true }
    );
    expect(res).toMatchSnapshot('10+ rows footer');
    expect(res).toContain('Showing 10 of 15 rows.');
    expect(res).toContain('Reply "csv" for the full result as a file.');
  });

  it('renders truncated footer when result is truncated', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      item: `Item ${i + 1}`,
    }));
    const res = formatAnswer(
      {
        ...baseResult,
        rowCount: 10,
        results: rows,
        truncated: true,
      },
      { exportEnabled: true }
    );
    expect(res).toMatchSnapshot('truncated footer');
    expect(res).toContain('Result limited to 10 rows.');
    expect(res).toContain('Reply "csv" for the full result as a file.');
  });

  it('truncates long cell content to 18 chars with ellipsis', () => {
    const res = formatAnswer({
      ...baseResult,
      rowCount: 2,
      results: [
        { desc: 'This is a very long description that exceeds eighteen characters' },
        { desc: 'Short' },
      ],
    });
    expect(res).toMatchSnapshot('long cell');
    expect(res).toContain('…');
    expect(res).not.toContain('eighteen characters');
  });

  it('sanitizes backticks and control characters in data', () => {
    const res = formatAnswer({
      ...baseResult,
      rowCount: 2,
      results: [
        { code: 'SELECT `id` FROM `users`\x00' },
        { code: 'test' },
      ],
    });
    expect(res).not.toContain('`id`');
    expect(res).toContain("'id'");
  });

  it('does not apply number formatting to id or phone columns', () => {
    const res = formatAnswer({
      ...baseResult,
      rowCount: 2,
      results: [
        { user_id: '12345678', phone_number: '254712345678', amount: 12345678 },
        { user_id: '87654321', phone_number: '254787654321', amount: 87654321 },
      ],
    });
    // user_id and phone_number must retain unformatted raw digits
    expect(res).toContain('12345678');
    expect(res).toContain('254712345678');
    // amount should be formatted with commas
    expect(res).toContain('12,345,678');
  });

  it('respects 3500-char cap by dropping table and trimming summary', () => {
    const longSummary = 'A'.repeat(4000);
    const rows = Array.from({ length: 5 }, (_, i) => ({ val: `Row ${i}` }));
    const res = formatAnswer({
      ...baseResult,
      rowCount: 5,
      results: rows,
      summary: longSummary,
    });
    expect(res.length).toBeLessThanOrEqual(3500);
  });

  describe('friendlyError', () => {
    it('formats unable error with reason', () => {
      const err = friendlyError({
        ...baseResult,
        error: '-- UNABLE_TO_ANSWER: no such column found in schema',
        errorKind: 'unable',
      });
      expect(err).toBe(
        "I can't answer that from the available data: no such column found in schema"
      );
    });

    it('formats rejected error', () => {
      const err = friendlyError({
        ...baseResult,
        error: 'Validation rejected',
        errorKind: 'rejected',
      });
      expect(err).toBe("I couldn't build a safe query for that. Try rephrasing.");
    });

    it('formats timeout error', () => {
      const err = friendlyError({
        ...baseResult,
        error: 'Query timed out',
        errorKind: 'timeout',
      });
      expect(err).toBe(
        'That query took too long. Try narrowing it (for example a date range).'
      );
    });

    it('formats llm failure error', () => {
      const err = friendlyError({
        ...baseResult,
        error: 'Gemini network failure',
        errorKind: 'llm',
      });
      expect(err).toBe(
        'The AI service is unavailable right now. Please try again shortly.'
      );
    });

    it('formats generic fallback error', () => {
      const err = friendlyError({
        ...baseResult,
        error: 'Unknown internal error',
        errorKind: 'config',
      });
      expect(err).toBe("I couldn't answer that. Try rephrasing.");
    });
  });

  describe('escapeWhatsAppText', () => {
    it('disarms leading formatting symbols', () => {
      const escaped = escapeWhatsAppText('*bold* and _italic_');
      expect(escaped).toContain('\u200B*');
      expect(escaped).toContain('\u200B_');
    });
  });
});
