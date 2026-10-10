import pino from 'pino';

export function createLogger(logLevel = 'info') {
  const isDev = process.env.NODE_ENV === 'development';

  const redactPaths = [
    'req.headers["x-openwa-signature"]',
    'req.headers.authorization',
    'headers["x-openwa-signature"]',
    'headers.authorization',
    'OPENWA_API_KEY',
    'WEBHOOK_HMAC_SECRET',
    'DB_PASSWORD',
    'GEMINI_API_KEY',
    'EXPORT_SIGNING_KEY',
    'password',
    'apiKey',
    'secret',
  ];

  if (isDev) {
    return pino({
      level: logLevel,
      redact: {
        paths: redactPaths,
        censor: '[REDACTED]',
      },
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
        },
      },
    });
  }

  return pino({
    level: logLevel,
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },
  });
}
