/**
 * storage/schemaHash.ts
 */

import crypto from 'crypto';
import type { RawTable } from '../types';

export const ENRICHMENT_FORMAT_VERSION = 2;

export function hashRawTable(rawTable: RawTable): string {
  const schemaSignature = {
    version: ENRICHMENT_FORMAT_VERSION,
    tableName: rawTable.tableName,
    columns: [...rawTable.columns]
      .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
      .map((c) => ({
        name: c.columnName,
        type: c.dataType,
        columnType: c.columnType,
        nullable: c.isNullable,
        key: c.columnKey,
      })),
    foreignKeys: rawTable.foreignKeys
      .map((fk) => `${fk.columnName}->${fk.referencedTable}.${fk.referencedColumn}`)
      .sort(),
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(schemaSignature))
    .digest('hex');
}
