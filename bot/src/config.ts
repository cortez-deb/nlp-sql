import { z } from 'zod';

// Ensure TZ is set before anything else
if (!process.env.TZ) {
  process.env.TZ = 'Africa/Nairobi';
}

const booleanFromString = (def = false) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === '') return def;
      if (typeof val === 'boolean') return val;
      return val === '1' || val.toLowerCase() === 'true';
    });

const numberFromString = (def: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === '') return def;
      const num = Number(val);
      return Number.isNaN(num) ? def : num;
    });

const rawConfigSchema = z
  .object({
    PORT: numberFromString(3000),
    HOST: z.string().default('127.0.0.1'),
    OPENWA_FLAVOR: z.enum(['openwa-gateway', 'wa-automate'], {
      required_error: 'OPENWA_FLAVOR is required',
    }),
    WEBHOOK_PATH_TOKEN: z
      .string({ required_error: 'WEBHOOK_PATH_TOKEN is required' })
      .min(24, 'WEBHOOK_PATH_TOKEN must be at least 24 characters'),
    WEBHOOK_HMAC_SECRET: z.string().optional(),
    WEBHOOK_PUBLIC_URL: z.string().optional(),
    OPENWA_SESSION_ID: z.string().optional(),
    TYPING_INDICATOR: booleanFromString(false),
    OPENWA_BASE_URL: z
      .string({ required_error: 'OPENWA_BASE_URL is required' })
      .min(1, 'OPENWA_BASE_URL is required')
      .transform((val) => val.replace(/\/+$/, '')),
    OPENWA_API_KEY: z
      .string({ required_error: 'OPENWA_API_KEY is required' })
      .min(1, 'OPENWA_API_KEY is required'),
    OPENWA_API_KEY_HEADER: z.string().optional(),
    OPENWA_SEND_TEXT_PATH: z.string().optional(),
    ALLOWED_SENDERS: z
      .string({ required_error: 'ALLOWED_SENDERS is required' })
      .min(1, 'ALLOWED_SENDERS is required'),
    DB_HOST: z.string({ required_error: 'DB_HOST is required' }).min(1),
    DB_PORT: numberFromString(3306),
    DB_USER: z.string({ required_error: 'DB_USER is required' }).min(1),
    DB_PASSWORD: z.string({ required_error: 'DB_PASSWORD is required' }),
    DB_NAME: z.string({ required_error: 'DB_NAME is required' }).min(1),
    DB_SSL: booleanFromString(false),
    DB_SSL_CA: z.string().optional(),
    GEMINI_API_KEY: z
      .string({ required_error: 'GEMINI_API_KEY is required' })
      .min(1),
    GEMINI_MODEL: z
      .string({ required_error: 'GEMINI_MODEL is required' })
      .min(1),
    ENRICHMENT_PATH: z.string().default('./.nlsql/enrichment.json'),

    // Export options (Phase 2)
    EXPORT_BASE_URL: z.string().optional(),
    EXPORT_DOWNLOAD_DIR: z.string().default('/var/www/downloads'),
    EXPORT_RETENTION_HOURS: numberFromString(24),
    EXPORT_MAX_ROWS: numberFromString(100000),
    EXPORT_SIGNING_KEY: z.string().optional(),

    TZ: z.string().default('Africa/Nairobi'),
    LOCALE: z.string().default('en-US'),
    MAX_MESSAGE_AGE_SEC: numberFromString(120),
    RATE_LIMIT_PER_MIN: numberFromString(10),
    DAILY_QUERY_LIMIT: numberFromString(200),
    CAPTURE_MODE: booleanFromString(false),
    LOG_LEVEL: z.string().default('info'),
  })
  .superRefine((data, ctx) => {
    if (data.OPENWA_FLAVOR === 'openwa-gateway') {
      if (!data.WEBHOOK_HMAC_SECRET || data.WEBHOOK_HMAC_SECRET.length < 16) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_HMAC_SECRET'],
          message:
            'WEBHOOK_HMAC_SECRET must be at least 16 characters for openwa-gateway',
        });
      }
      if (!data.OPENWA_SESSION_ID || data.OPENWA_SESSION_ID.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OPENWA_SESSION_ID'],
          message: 'OPENWA_SESSION_ID is required for openwa-gateway',
        });
      }
    }
  });

export type BotConfig = z.infer<typeof rawConfigSchema> & {
  apiKeyHeader: string;
  sendTextPath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const result = rawConfigSchema.safeParse(env);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    console.error(`[nlsql-bot] Configuration validation failed:\n${errorDetails}`);
    process.exit(1);
  }

  const data = result.data;

  // Determine defaults based on flavor
  const apiKeyHeader =
    data.OPENWA_API_KEY_HEADER ??
    (data.OPENWA_FLAVOR === 'openwa-gateway' ? 'X-API-Key' : 'api_key');

  const sendTextPath =
    data.OPENWA_SEND_TEXT_PATH ??
    (data.OPENWA_FLAVOR === 'openwa-gateway'
      ? '/api/sessions/{sessionId}/messages/send-text'
      : '/sendText');

  return {
    ...data,
    apiKeyHeader,
    sendTextPath,
  };
}
