/**
 * export/config.ts
 *
 * Loads and validates ExportConfig from environment variables.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ExportConfig } from './types';

function positiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`[nlsql] ${name} must be a positive integer (got "${raw}")`);
  }
  return Number(raw);
}

function validateBaseUrl(raw: string | undefined): string {
  if (!raw || raw.trim() === '') {
    throw new Error('[nlsql] EXPORT_BASE_URL is required (e.g. https://files.example.com/downloads)');
  }

  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`[nlsql] EXPORT_BASE_URL is not a valid URL`);
  }

  const isLocalDev =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !isLocalDev) {
    throw new Error(
      '[nlsql] EXPORT_BASE_URL must use https:// (http:// is only allowed for localhost / 127.0.0.1)'
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('[nlsql] EXPORT_BASE_URL must not contain credentials, a query string or a fragment');
  }

  return trimmed.replace(/\/+$/, '');
}

function validateRootDir(rootDir: string): void {
  if (!path.isAbsolute(rootDir)) {
    throw new Error(`[nlsql] EXPORT_ROOT_DIR must be an absolute path (got "${rootDir}")`);
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(rootDir);
  } catch {
    throw new Error(`[nlsql] EXPORT_ROOT_DIR "${rootDir}" does not exist`);
  }
  if (!st.isDirectory()) {
    throw new Error(`[nlsql] EXPORT_ROOT_DIR "${rootDir}" is not a directory`);
  }
  try {
    fs.accessSync(rootDir, fs.constants.W_OK);
  } catch {
    throw new Error(`[nlsql] EXPORT_ROOT_DIR "${rootDir}" is not writable by this process`);
  }
}

export function loadExportConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ExportConfig {
  const rootDir = env['EXPORT_ROOT_DIR']?.trim() || '/var/www/downloads';
  validateRootDir(rootDir);

  const baseUrl = validateBaseUrl(env['EXPORT_BASE_URL']);

  const config: ExportConfig = { rootDir, baseUrl };

  const ttlHours = positiveInt(env, 'EXPORT_TTL_HOURS');
  if (ttlHours !== undefined) config.ttlHours = ttlHours;

  const maxRows = positiveInt(env, 'EXPORT_MAX_ROWS');
  if (maxRows !== undefined) config.maxRows = maxRows;

  const maxMb = positiveInt(env, 'EXPORT_MAX_MB');
  if (maxMb !== undefined) config.maxBytes = maxMb * 1024 * 1024;

  const timeoutMs = positiveInt(env, 'EXPORT_TIMEOUT_MS');
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;

  return config;
}
