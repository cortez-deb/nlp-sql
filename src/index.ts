/**
 * src/index.ts
 *
 * Public API of the nlsql library.
 */

// ── Main Client ──────────────────────────────────────────────────────────────
export { NLSQLClient } from './core/NLSQLClient';
export type { NLSQLClientConfig } from './core/NLSQLClient';
export { SqlRejectedError } from './core/errors';
export type { RowStream } from './db/MySQLAdapter';

// ── CSV export (Phase 2) ─────────────────────────────────────────────────────
export {
  CsvExportService,
  loadExportConfigFromEnv,
  detectExportIntent,
  cleanupExpired,
  startCleanupTimer,
} from './export';
export type { ExportConfig, ExportRequest, ExportResult } from './export';

// ── Enrichment ──────────────────────────────────────────────────────────────
export type { EnrichmentSummary, EnrichmentProgress } from './core/SchemaEnricher';
export type { IEnrichmentStore } from './storage/IEnrichmentStore';
export { FileEnrichmentStore } from './storage/FileEnrichmentStore';
export { MySQLEnrichmentStore, EnrichmentStore } from './storage/EnrichmentStore';

// ── LLM provider classes & contracts ──────────────────────────────────────────
export { BaseLLM } from './llm/BaseLLM';
export type { GenerateSQLInput, SummarizeInput } from './llm/BaseLLM';
export { GeminiLLM } from './llm/GeminiLLM';

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
  ConversationTurn,

  // Validation
  ValidationResult,
} from './types';
