/**
 * tests/unit/openRowStream.test.ts
 *
 * NLSQLClient.openRowStream: validation, no LIMIT, no connection on rejection.
 */

import { Readable } from 'stream';
import { NLSQLClient } from '../../src/core/NLSQLClient';
import type { NLSQLClientConfig } from '../../src/core/NLSQLClient';
import { SqlRejectedError } from '../../src/core/errors';

jest.mock('../../src/db/MySQLAdapter', () => ({ MySQLAdapter: { create: jest.fn() } }));
jest.mock('../../src/llm/GeminiLLM', () => ({ GeminiLLM: jest.fn() }));
jest.mock('../../src/storage/EnrichmentStore', () => ({
  EnrichmentStore: jest.fn(),
  MySQLEnrichmentStore: jest.fn(),
}));
jest.mock('../../src/storage/FileEnrichmentStore', () => ({ FileEnrichmentStore: jest.fn() }));
jest.mock('../../src/core/SchemaEnricher', () => ({ SchemaEnricher: jest.fn() }));

import { MySQLAdapter } from '../../src/db/MySQLAdapter';
import { GeminiLLM } from '../../src/llm/GeminiLLM';
import { FileEnrichmentStore } from '../../src/storage/FileEnrichmentStore';
import { SchemaEnricher } from '../../src/core/SchemaEnricher';

const config: NLSQLClientConfig = {
  db: { host: 'localhost', user: 'u', password: 'p', database: 'test_db' },
  llm: { provider: 'gemini', apiKey: 'k', model: 'm' },
};

function setup(rows: Record<string, unknown>[] = [{ id: 1 }, { id: 2 }]) {
  const destroy = jest.fn().mockResolvedValue(undefined);
  const openStream = jest.fn().mockImplementation(async () => ({
    columns: ['id'],
    rows: Readable.from(rows),
    destroy,
  }));
  (MySQLAdapter.create as jest.Mock).mockResolvedValue({
    openStream,
    close: jest.fn().mockResolvedValue(undefined),
  });
  (GeminiLLM as unknown as jest.Mock).mockImplementation(() => ({}));
  (FileEnrichmentStore as unknown as jest.Mock).mockImplementation(() => ({
    initialise: jest.fn().mockResolvedValue(undefined),
  }));
  (SchemaEnricher as unknown as jest.Mock).mockImplementation(() => ({
    getEnrichedTables: jest.fn().mockResolvedValue([{ tableName: 'orders' }]),
  }));
  return { openStream, destroy };
}

describe('NLSQLClient.openRowStream', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws if called before initialise()', async () => {
    const client = new NLSQLClient(config);
    await expect(client.openRowStream('SELECT 1')).rejects.toThrow('initialise()');
  });

  it('streams all rows for valid SQL, without appending a LIMIT', async () => {
    const { openStream } = setup([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const client = new NLSQLClient(config);
    await client.initialise();

    const sql = 'SELECT orders.id FROM orders';
    const stream = await client.openRowStream(sql);

    expect(openStream).toHaveBeenCalledWith(sql, { timeoutMs: 60_000 });
    const got: unknown[] = [];
    for await (const r of stream.rows) got.push(r);
    expect(got).toHaveLength(3);
  });

  it('uses config.export.timeoutMs, and an explicit timeoutMs overrides it', async () => {
    const { openStream } = setup();
    const client = new NLSQLClient({ ...config, export: { timeoutMs: 30_000 } });
    await client.initialise();

    await client.openRowStream('SELECT orders.id FROM orders');
    expect(openStream).toHaveBeenLastCalledWith(expect.any(String), { timeoutMs: 30_000 });
    await client.openRowStream('SELECT orders.id FROM orders', { timeoutMs: 5_000 });
    expect(openStream).toHaveBeenLastCalledWith(expect.any(String), { timeoutMs: 5_000 });
  });

  it.each([
    ['a write statement', 'DELETE FROM orders', 'forbidden'],
    ['a table that is not enriched', 'SELECT x.id FROM secrets x', 'forbidden'],
    ['stacked statements', 'SELECT 1; DROP TABLE orders', 'forbidden'],
    ['garbage', 'not sql at all (((', 'syntax'],
  ])('throws SqlRejectedError for %s before any connection is taken', async (_n, sql, kind) => {
    const { openStream } = setup();
    const client = new NLSQLClient(config);
    await client.initialise();

    const err = await client.openRowStream(sql).catch((e) => e);
    expect(err).toBeInstanceOf(SqlRejectedError);
    expect(err.kind).toBe(kind);
    expect(typeof err.reason).toBe('string');
    expect(openStream).not.toHaveBeenCalled();
  });
});
