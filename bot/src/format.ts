import type { QueryResult } from 'nlsql';

export interface FormatOptions {
  locale?: string;
  exportEnabled?: boolean;
  maxTableRows?: number;
  maxTableCols?: number;
  maxTotalChars?: number;
}

export function escapeWhatsAppText(text: string): string {
  if (!text) return '';
  // Strip control characters except newline and tab
  let clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Disarm leading *, _, ~ so WhatsApp does not format unexpectedly
  clean = clean.replace(/(^|\s)([*_~])/g, '$1\u200B$2');
  return clean;
}

export function cleanCodeBlockCell(val: string): string {
  if (!val) return '';
  // Replace backticks with single quotes and strip control characters
  return val.replace(/`/g, "'").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
}

function isIdOrPhoneColumn(colName: string): boolean {
  return /^(id|phone.*|.*_id)$/i.test(colName);
}

function truncateCell(str: string, maxLen = 18): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function isNumericValue(val: any, colName: string): boolean {
  if (isIdOrPhoneColumn(colName)) return false;
  if (typeof val === 'number' && !Number.isNaN(val)) return true;
  if (typeof val === 'bigint') return true;
  if (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val.trim())) return true;
  return false;
}

function formatCellValue(val: any, colName: string, locale: string): { formatted: string; isNumeric: boolean } {
  if (val === null || val === undefined) {
    return { formatted: 'NULL', isNumeric: false };
  }

  if (isNumericValue(val, colName)) {
    const num = Number(val);
    try {
      const nf = new Intl.NumberFormat(locale);
      return { formatted: nf.format(num), isNumeric: true };
    } catch {
      return { formatted: String(val), isNumeric: true };
    }
  }

  if (val instanceof Date) {
    return { formatted: val.toISOString().slice(0, 10), isNumeric: false };
  }

  return { formatted: cleanCodeBlockCell(String(val)), isNumeric: false };
}

export function renderTable(
  rows: Record<string, any>[],
  locale = 'en-US',
  maxRows = 10,
  maxCols = 4
): { tableMarkdown: string; extraCols: number } {
  if (!rows || rows.length === 0) {
    return { tableMarkdown: '', extraCols: 0 };
  }

  const allColumns = Object.keys(rows[0]);
  const shownColumns = allColumns.slice(0, maxCols);
  const extraCols = Math.max(0, allColumns.length - maxCols);

  const displayRows = rows.slice(0, maxRows);

  // Compute column properties (widths and alignment)
  const colProps = shownColumns.map((col) => {
    const headerStr = truncateCell(cleanCodeBlockCell(col));
    let isNumeric = false;
    let maxLen = headerStr.length;

    const cellStrings: string[] = [];

    for (const row of displayRows) {
      const rawVal = row[col];
      const { formatted, isNumeric: num } = formatCellValue(rawVal, col, locale);
      if (num) isNumeric = true;
      const truncated = truncateCell(formatted);
      cellStrings.push(truncated);
      if (truncated.length > maxLen) {
        maxLen = truncated.length;
      }
    }

    return {
      name: col,
      header: headerStr,
      isNumeric,
      width: maxLen,
      cells: cellStrings,
    };
  });

  // Build header row
  const headerParts = colProps.map((p) => p.header.padEnd(p.width));
  const separatorParts = colProps.map((p) => '-'.repeat(p.width));

  const lines: string[] = [];
  lines.push(headerParts.join('  '));
  lines.push(separatorParts.join('  '));

  // Build data rows
  for (let r = 0; r < displayRows.length; r++) {
    const rowParts = colProps.map((p) => {
      const cell = p.cells[r] ?? '';
      return p.isNumeric ? cell.padStart(p.width) : cell.padEnd(p.width);
    });
    lines.push(rowParts.join('  '));
  }

  const tableMarkdown = '```\n' + lines.join('\n') + '\n```';
  return { tableMarkdown, extraCols };
}

export function formatAnswer(result: QueryResult, opts?: FormatOptions): string {
  const locale = opts?.locale ?? 'en-US';
  const exportEnabled = opts?.exportEnabled ?? true;
  const maxTableRows = opts?.maxTableRows ?? 10;
  const maxTableCols = opts?.maxTableCols ?? 4;
  const maxTotalChars = opts?.maxTotalChars ?? 3500;

  const rows = result.results;
  const rowCount = result.rowCount;

  if (rowCount === 0 || !rows || rows.length === 0) {
    return 'No matching records found.';
  }

  // Single row / single column with summary -> summary only
  if (rowCount === 1 && Object.keys(rows[0]).length === 1 && result.summary) {
    return result.summary;
  }

  const parts: string[] = [];

  // 1. Summary
  if (result.summary) {
    parts.push(result.summary);
  }

  // 2. Table block
  const shouldIncludeTable = rowCount >= 2 || !result.summary;
  let tablePart = '';
  let extraCols = 0;

  if (shouldIncludeTable) {
    const rendered = renderTable(rows, locale, maxTableRows, maxTableCols);
    tablePart = rendered.tableMarkdown;
    extraCols = rendered.extraCols;
    if (tablePart) {
      parts.push(tablePart);
    }
  }

  // 3. Footers
  const footers: string[] = [];
  if (extraCols > 0) {
    footers.push(`+${extraCols} more column${extraCols > 1 ? 's' : ''}`);
  }

  if (rowCount > maxTableRows) {
    footers.push(`Showing ${maxTableRows} of ${rowCount} rows.`);
  }

  if (result.truncated) {
    footers.push(`Result limited to ${rowCount} rows.`);
  }

  if ((rowCount > maxTableRows || result.truncated) && exportEnabled) {
    footers.push('Reply "csv" for the full result as a file.');
  }

  if (footers.length > 0) {
    parts.push(footers.join('\n'));
  }

  let fullOutput = parts.join('\n\n');

  // Hard cap 3500 chars: drop table first, then shorten summary
  if (fullOutput.length > maxTotalChars) {
    if (tablePart) {
      // Reassemble without tablePart
      const noTableParts: string[] = [];
      if (result.summary) noTableParts.push(result.summary);
      if (footers.length > 0) noTableParts.push(footers.join('\n'));
      fullOutput = noTableParts.join('\n\n');
    }

    if (fullOutput.length > maxTotalChars && result.summary) {
      const allowedSummaryLen = Math.max(100, maxTotalChars - (footers.join('\n').length + 20));
      const truncatedSummary = result.summary.slice(0, allowedSummaryLen) + '…';
      const truncatedParts: string[] = [truncatedSummary];
      if (footers.length > 0) truncatedParts.push(footers.join('\n'));
      fullOutput = truncatedParts.join('\n\n');
    }
  }

  return fullOutput;
}

export function friendlyError(result: QueryResult): string {
  const kind = result.errorKind;
  const errorMsg = result.error ?? '';

  if (kind === 'unable' || errorMsg.includes('-- UNABLE_TO_ANSWER')) {
    const match = errorMsg.match(/--\s*UNABLE_TO_ANSWER[:\s]*(.*)/i);
    const reason = match && match[1] ? match[1].trim() : '';
    return reason
      ? `I can't answer that from the available data: ${reason}`
      : "I can't answer that from the available data.";
  }

  if (kind === 'rejected' || errorMsg.includes('Validation rejected')) {
    return "I couldn't build a safe query for that. Try rephrasing.";
  }

  if (kind === 'timeout' || /timed out|timeout/i.test(errorMsg)) {
    return 'That query took too long. Try narrowing it (for example a date range).';
  }

  if (kind === 'llm' || /gemini|ai service|model/i.test(errorMsg)) {
    return 'The AI service is unavailable right now. Please try again shortly.';
  }

  return "I couldn't answer that. Try rephrasing.";
}
