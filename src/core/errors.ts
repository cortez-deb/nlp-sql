/**
 * core/errors.ts
 *
 * Error types thrown by the nlsql library.
 */

import type { ValidationResult } from '../types';

/** Thrown when SQL fails validation (never reaches the database). */
export class SqlRejectedError extends Error {
  readonly reason: string;
  readonly kind: ValidationResult['kind'];

  constructor(reason: string, kind?: ValidationResult['kind']) {
    super(`[nlsql] SQL rejected: ${reason}`);
    this.name = 'SqlRejectedError';
    this.reason = reason;
    this.kind = kind;
    Object.setPrototypeOf(this, SqlRejectedError.prototype);
  }
}
