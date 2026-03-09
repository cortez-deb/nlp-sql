/**
 * src/index.ts
 *
 * This is the public API of the nlsql library.
 *
 * When someone installs nlsql and writes:
 *   import { NLSQLClient } from 'nlsql';
 *
 * This file determines what they can import. Only things exported here
 * are part of the public API. Internal implementation details (like
 * MySQLAdapter, GeminiLLM, etc.) are not exported — they are private.
 *
 * If you are a user of this library, start with NLSQLClient.
 * If you are extending this library (e.g. adding a new LLM provider),
 * you can also import BaseLLM and implement it.
 */

// ── Main Client (start here) ──────────────────────────────────────────────────
export { NLSQLClient } from './core/NLSQLClient';
export type { NLSQLClientConfig } from './core/NLSQLClient';

// ── Enrichment types ──────────────────────────────────────────────────────────
export type { EnrichmentSummary, EnrichmentProgress } from './core/SchemaEnricher';

// ── Extension point: implement a new LLM provider ─────────────────────────────
export { BaseLLM } from './llm/BaseLLM';

// ── All shared types and interfaces ───────────────────────────────────────────
export type {
  // Configuration
  MySQLConnectionConfig,
  LLMConfig,
  LLMProvider,

  // Schema types
  RawTable,
  RawColumn,
  ForeignKeyInfo,
  EnrichedTable,
  EnrichedColumn,

  // Query types
  QueryResult,
  QueryOptions,
  FewShotExample,
  EnrichmentOptions,

  // Validation
  ValidationResult,
} from './types';
