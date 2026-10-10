/**
 * validation/SQLValidator.ts
 *
 * Safe SQL Validator using node-sql-parser (AST-based).
 */

import { Parser } from 'node-sql-parser';
import type { ValidationResult } from '../types';

export interface ValidateOptions {
  allowedTables?: string[];
  allowedDatabase?: string;
}

const DENIED_FUNCTIONS = new Set([
  'SLEEP',
  'BENCHMARK',
  'LOAD_FILE',
  'GET_LOCK',
  'RELEASE_LOCK',
  'RELEASE_ALL_LOCKS',
  'IS_FREE_LOCK',
  'IS_USED_LOCK',
  'MASTER_POS_WAIT',
  'SOURCE_POS_WAIT',
  'UUID_SHORT',
  'SYS_EXEC',
  'SYS_EVAL',
  'UPDATEXML',
  'EXTRACTVALUE',
]);

const FORBIDDEN_SCHEMAS = new Set([
  'information_schema',
  'mysql',
  'performance_schema',
  'sys',
]);

export class SQLValidator {
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
  }

  validate(sql: string, opts?: ValidateOptions): ValidationResult {
    // 1. Empty / whitespace check
    if (!sql || sql.trim().length === 0) {
      return { isValid: false, reason: 'SQL query is empty.', kind: 'empty' };
    }

    const trimmed = sql.trim();

    // 2. UNABLE_TO_ANSWER sentinel check
    if (trimmed.startsWith('-- UNABLE_TO_ANSWER')) {
      const parts = trimmed.split(':');
      const reason = parts.slice(1).join(':').trim();
      return {
        isValid: false,
        reason: reason || 'Unable to answer query',
        kind: 'unable',
      };
    }

    // 3. Executable / optimizer comments check (/*! or /*+)
    if (/\/\*[\!\+]/.test(trimmed)) {
      return {
        isValid: false,
        reason: 'Executable/optimizer comments not allowed.',
        kind: 'forbidden',
      };
    }

    // 4. Parse SQL to AST
    let ast: any;
    try {
      ast = this.parser.parse(sql, { database: 'MySQL' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isValid: false,
        reason: msg,
        kind: 'syntax',
      };
    }

    // 5. Single statement check
    const rawAst = ast?.ast ?? ast;
    let astNode: any;
    if (Array.isArray(rawAst)) {
      if (rawAst.length !== 1) {
        return {
          isValid: false,
          reason: 'Single statement only.',
          kind: 'forbidden',
        };
      }
      astNode = rawAst[0];
    } else {
      astNode = rawAst;
    }

    // 6. Statement type must be select
    if (!astNode || astNode.type !== 'select') {
      return {
        isValid: false,
        reason: `Only SELECT statements are allowed. Got: ${astNode?.type?.toUpperCase() ?? 'UNKNOWN'}`,
        kind: 'forbidden',
      };
    }

    // 7. Recursive AST walk for forbidden features
    const walkError = this.walkAST(astNode);
    if (walkError) {
      return {
        isValid: false,
        reason: walkError,
        kind: 'forbidden',
      };
    }

    // 8. Table checks via tableList
    let tableList: string[] = [];
    try {
      tableList = this.parser.tableList(sql, { database: 'MySQL' }) || [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isValid: false,
        reason: msg,
        kind: 'syntax',
      };
    }

    const cteNames = new Set<string>();
    if (astNode.with && Array.isArray(astNode.with)) {
      for (const cte of astNode.with) {
        if (cte && cte.name && typeof cte.name.value === 'string') {
          cteNames.add(cte.name.value.toLowerCase());
        }
      }
    }

    const allowedTablesSet = opts?.allowedTables
      ? new Set(opts.allowedTables.map((t) => t.toLowerCase()))
      : null;

    const allowedDbLower = opts?.allowedDatabase?.toLowerCase();

    for (const entry of tableList) {
      // Entry format: "select::<db|null>::<table>"
      const parts = entry.split('::');
      const dbPart = parts.length >= 3 ? parts[1] : null;
      const tablePart = parts.length >= 3 ? parts[2] : parts[parts.length - 1];

      if (!tablePart) continue;

      const tableLower = tablePart.toLowerCase();
      const dbLower = dbPart && dbPart !== 'null' ? dbPart.toLowerCase() : null;

      // 8a. If db present and != allowedDatabase
      if (dbLower && allowedDbLower && dbLower !== allowedDbLower) {
        return {
          isValid: false,
          reason: `Access to database schema "${dbPart}" is not allowed.`,
          kind: 'forbidden',
        };
      }

      // 8b. Reject forbidden schemas
      if (
        (dbLower && FORBIDDEN_SCHEMAS.has(dbLower)) ||
        FORBIDDEN_SCHEMAS.has(tableLower)
      ) {
        return {
          isValid: false,
          reason: `Access to system schema "${dbPart || tablePart}" is forbidden.`,
          kind: 'forbidden',
        };
      }

      // 8c. Reject table starting with nlsql_
      if (tableLower.startsWith('nlsql_')) {
        return {
          isValid: false,
          reason: `Access to internal table "${tablePart}" is forbidden.`,
          kind: 'forbidden',
        };
      }

      // 8d. If allowedTables given: must be in allowedTables or CTE
      if (allowedTablesSet) {
        if (!cteNames.has(tableLower) && !allowedTablesSet.has(tableLower)) {
          return {
            isValid: false,
            reason: `Table "${tablePart}" is not in the allowed tables list.`,
            kind: 'forbidden',
          };
        }
      }
    }

    // 9. Top level limit check
    const hasTopLevelLimit = Boolean(astNode.limit);

    // 10. Success!
    return {
      isValid: true,
      reason: null,
      hasTopLevelLimit,
    };
  }

  private walkAST(node: any): string | null {
    if (!node || typeof node !== 'object') return null;

    // Check INTO clause
    if (
      node.into &&
      (node.into.keyword ||
        node.into.type === 'into' ||
        node.into.expr ||
        node.into.position)
    ) {
      return 'INTO clause is not allowed.';
    }

    // Check locking_read
    if (node.locking_read) {
      return `Locking read clause "${node.locking_read}" is not allowed.`;
    }

    // Check variables
    if (
      node.type === 'var' ||
      node.prefix === '@' ||
      node.prefix === '@@' ||
      node.type === 'assign'
    ) {
      return 'User or system variables are not allowed.';
    }

    // Check denied functions
    if (node.type === 'function' || node.type === 'aggr_func') {
      const funcName = this.extractFunctionName(node);
      if (funcName && DENIED_FUNCTIONS.has(funcName.toUpperCase())) {
        return `Function "${funcName.toUpperCase()}" is forbidden.`;
      }
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const err = this.walkAST(item);
        if (err) return err;
      }
    } else {
      for (const key of Object.keys(node)) {
        const err = this.walkAST(node[key]);
        if (err) return err;
      }
    }

    return null;
  }

  private extractFunctionName(node: any): string | null {
    if (typeof node.name === 'string') {
      return node.name;
    }
    if (node.name && typeof node.name === 'object') {
      if (Array.isArray(node.name.name) && node.name.name.length > 0) {
        return node.name.name[0]?.value ?? null;
      }
      if (typeof node.name.name === 'string') {
        return node.name.name;
      }
      if (typeof node.name.value === 'string') {
        return node.name.value;
      }
    }
    return null;
  }
}
