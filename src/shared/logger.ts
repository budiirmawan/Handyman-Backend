import { getAppConfig, type LogLevel } from '../config';

export type LogFields = {
  requestId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  errorName?: string;
  errorMessage?: string;
  stack?: string;
  code?: string;
  environment?: string;
  port?: number;
  apiPrefix?: string;
  host?: string;
  database?: string;
  signal?: string;
  userId?: string;
  sessionId?: string;
  operation?: string;
  result?: string;
  requiredPermission?: string;
  invitationId?: string;
  actorUserId?: string;
  targetUserId?: string;
  action?: string;
  eventType?: string;
  buildingId?: string;
  intervalMs?: number;
  assetId?: string;
  // BE-25N — mobile observability fields
  mobileDeviceId?: string;
  mobilePlatform?: string;
  mobileAppVersion?: string;
  batchId?: string;
  operationCount?: number;
  successCount?: number;
  failedCount?: number;
  replayedCount?: number;
  operationId?: string;
  resourceType?: string;
  resourceId?: string;
  errorCode?: string;
};

type LogRecord = LogFields & {
  level: LogLevel;
  timestamp: string;
  message: string;
};

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const REDACT_KEY = /password|authorization|cookie|token|secret|api[-_]?key/i;

export function log(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
): void {
  if (LEVEL_RANK[level] > LEVEL_RANK[currentLevel()]) {
    return;
  }

  const record: LogRecord = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...sanitizeFields(fields),
  };

  process.stderr.write(`${formatRecord(record)}\n`);
}

export const logger = {
  error(message: string, fields?: LogFields): void {
    log('error', message, fields);
  },
  warn(message: string, fields?: LogFields): void {
    log('warn', message, fields);
  },
  info(message: string, fields?: LogFields): void {
    log('info', message, fields);
  },
  debug(message: string, fields?: LogFields): void {
    log('debug', message, fields);
  },
};

function currentLevel(): LogLevel {
  try {
    return getAppConfig().logLevel;
  } catch {
    return 'info';
  }
}

function isProduction(): boolean {
  try {
    return getAppConfig().isProduction;
  } catch {
    return process.env.NODE_ENV === 'production';
  }
}

function sanitizeFields(fields: LogFields): LogFields {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }

    sanitized[key] = REDACT_KEY.test(key) ? '[redacted]' : value;
  }

  return sanitized;
}

function formatRecord(record: LogRecord): string {
  if (isProduction()) {
    return JSON.stringify(record);
  }

  const extras = Object.entries(record)
    .filter(([key]) => key !== 'level' && key !== 'timestamp' && key !== 'message')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');

  return extras
    ? `${record.timestamp} ${record.level} ${record.message} ${extras}`
    : `${record.timestamp} ${record.level} ${record.message}`;
}
