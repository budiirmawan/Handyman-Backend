import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export type DatabaseConfig = {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  ssl: boolean;
};

export type SecurityConfig = {
  corsOrigins: string[];
  jsonBodyLimit: string;
  loginRateLimitWindowMinutes: number;
  loginRateLimitMaxAttempts: number;
};

export type SessionConfig = {
  ttlMinutes: number;
  ttlMs: number;
  tokenBytes: number;
  lastUsedUpdateIntervalMs: number;
};

export type InvitationConfig = {
  ttlHours: number;
  ttlMs: number;
};

export type StorageConfig = {
  driver: 'local';
  dir: string;
};

export type EmailConfig = {
  provider: string;
};

export type WhatsAppConfig = {
  provider: string;
};

/**
 * CR-BE-PUSH-01 PART 02 — mobile push delivery provider discriminator.
 *
 * ONLY the non-secret provider name lives here. FCM service-account
 * credentials are read inside `FcmPushAdapter`'s construction boundary
 * (`readFcmPushConfig`) and never enter `AppConfig` (governance §12.2).
 */
export type PushConfig = {
  provider: string;
};

/**
 * CR-BE-STAB-01 PART 04 — due operational job scheduler configuration.
 *
 * `enabled` gates whether the in-process scheduler runs `processDueOperationalJobs()`
 * on a cadence. It is ALWAYS forced to `false` in the `test` environment,
 * regardless of any explicit SCHEDULER_ENABLED value, so tests never run a
 * background timer.
 *
 * `intervalMs` is the conservative polling cadence between dispatcher runs.
 */
export type SchedulerConfig = {
  enabled: boolean;
  intervalMs: number;
};

export type AppConfig = {
  environment: NodeEnv;
  port: number;
  apiPrefix: string;
  logLevel: LogLevel;
  isDevelopment: boolean;
  isTest: boolean;
  isProduction: boolean;
  database: DatabaseConfig;
  security: SecurityConfig;
  session: SessionConfig;
  invitation: InvitationConfig;
  storage: StorageConfig;
  email: EmailConfig;
  whatsapp: WhatsAppConfig;
  push: PushConfig;
  scheduler: SchedulerConfig;
};

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

const DEFAULTS = {
  environment: 'development' as NodeEnv,
  port: 3000,
  apiPrefix: '/api/v1',
  logLevel: 'info' as LogLevel,
  database: {
    host: 'localhost',
    port: 5432,
    name: 'asentra',
    user: 'postgres',
    ssl: false,
  },
  security: {
    corsOrigins: ['http://localhost:3000', 'http://localhost:5173'],
    jsonBodyLimit: '1mb',
    loginRateLimitWindowMinutes: 15,
    loginRateLimitMaxAttempts: 10,
  },
  session: {
    ttlMinutes: 480,
    tokenBytes: 32,
    lastUsedUpdateIntervalMs: 300_000,
  },
  invitation: {
    ttlHours: 72,
  },
  storage: {
    driver: 'local' as const,
    dir: '.data/evidence',
  },
  email: {
    provider: 'noop',
  },
  whatsapp: {
    provider: 'noop',
  },
  push: {
    provider: 'noop',
  },
  scheduler: {
    // Conservative defaults: disabled by default in development, 60s cadence.
    // The effective default `enabled` also depends on the environment (see
    // readScheduler): production defaults to enabled, test is always disabled.
    enabled: false,
    intervalMs: 60_000,
  },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const normalized = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;
    const separator = normalized.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = normalized.slice(0, separator).trim();
    if (key === '') {
      continue;
    }

    parsed[key] = unquote(normalized.slice(separator + 1).trim());
  }

  return parsed;
}

export function applyParsedEnv(
  parsed: Record<string, string>,
  target: NodeJS.ProcessEnv,
): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

export function loadDotEnv(
  filePath: string = resolve(process.cwd(), '.env'),
  target: NodeJS.ProcessEnv = process.env,
): void {
  const nodeEnv = target.NODE_ENV ?? process.env.NODE_ENV;
  if (nodeEnv === 'production') {
    return;
  }

  if (!existsSync(filePath)) {
    return;
  }

  const contents = readFileSync(filePath, 'utf8');
  applyParsedEnv(parseEnvFile(contents), target);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    loadDotEnv();
  }

  return Object.freeze(parseConfig(env));
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const environment = readNodeEnv(env.NODE_ENV);
  const port = readPort(env.PORT);
  const apiPrefix = readApiPrefix(env.API_PREFIX);
  const logLevel = readLogLevel(env.LOG_LEVEL);

  return {
    environment,
    port,
    apiPrefix,
    logLevel,
    isDevelopment: environment === 'development',
    isTest: environment === 'test',
    isProduction: environment === 'production',
    database: readDatabase(env, environment),
    security: readSecurity(env, environment),
    session: readSession(env),
    invitation: readInvitation(env),
    storage: readStorage(env),
    email: readEmail(env),
    whatsapp: readWhatsApp(env),
    push: readPush(env),
    scheduler: readScheduler(env, environment),
  };
}

function readNodeEnv(raw: string | undefined): NodeEnv {
  const value = raw === undefined || raw.trim() === '' ? DEFAULTS.environment : raw.trim();

  if (!isNodeEnv(value)) {
    throw new ConfigError(
      `Invalid configuration: NODE_ENV must be one of: ${NODE_ENVS.join(', ')} (received ${JSON.stringify(raw)})`,
    );
  }

  return value;
}

function readPort(raw: string | undefined): number {
  return readPortValue('PORT', raw, DEFAULTS.port);
}

function readApiPrefix(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULTS.apiPrefix;
  }

  const value = raw.trim();
  if (value === '' || !value.startsWith('/') || /\s/.test(value)) {
    throw new ConfigError(
      `Invalid configuration: API_PREFIX must be a non-empty path starting with / (received ${JSON.stringify(raw)})`,
    );
  }

  const normalized = value.replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

function readDatabase(
  env: NodeJS.ProcessEnv,
  environment: NodeEnv,
): DatabaseConfig {
  const defaultName =
    environment === 'test' ? 'asentra_test' : DEFAULTS.database.name;

  return {
    host: readRequiredText('DB_HOST', env.DB_HOST, DEFAULTS.database.host),
    port: readPortValue('DB_PORT', env.DB_PORT, DEFAULTS.database.port),
    name: readRequiredText('DB_NAME', env.DB_NAME, defaultName),
    user: readRequiredText('DB_USER', env.DB_USER, DEFAULTS.database.user),
    password: env.DB_PASSWORD ?? '',
    ssl: readBoolean('DB_SSL', env.DB_SSL, DEFAULTS.database.ssl),
  };
}

function readRequiredText(
  name: string,
  raw: string | undefined,
  fallback: string,
): string {
  if (raw === undefined) {
    return fallback;
  }

  const value = raw.trim();
  if (value === '') {
    throw new ConfigError(`Invalid configuration: ${name} must not be empty`);
  }

  return value;
}

function readPortValue(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  const value = raw === undefined || raw.trim() === '' ? String(fallback) : raw.trim();

  if (!/^\d+$/.test(value)) {
    throw new ConfigError(
      `Invalid configuration: ${name} must be an integer between 1 and 65535 (received ${JSON.stringify(raw)})`,
    );
  }

  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) {
    throw new ConfigError(
      `Invalid configuration: ${name} must be an integer between 1 and 65535 (received ${JSON.stringify(raw)})`,
    );
  }

  return port;
}

function readBoolean(
  name: string,
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') {
    return true;
  }

  if (value === 'false' || value === '0') {
    return false;
  }

  throw new ConfigError(
    `Invalid configuration: ${name} must be true or false (received ${JSON.stringify(raw)})`,
  );
}

function readStorage(env: NodeJS.ProcessEnv): StorageConfig {  const driver = env.EVIDENCE_STORAGE_DRIVER?.trim() || DEFAULTS.storage.driver;
  if (driver !== 'local') {
    throw new ConfigError(
      `Invalid configuration: EVIDENCE_STORAGE_DRIVER must be 'local' (received ${JSON.stringify(env.EVIDENCE_STORAGE_DRIVER)})`,
    );
  }

  return {
    driver: 'local',
    dir: env.EVIDENCE_STORAGE_DIR?.trim() || DEFAULTS.storage.dir,
  };
}

function readEmail(env: NodeJS.ProcessEnv): EmailConfig {
  // Adapter-ready: only the provider discriminator is configured here. The
  // actual adapter implementation is selected at runtime by the email
  // delivery module (which validates the provider and, for now, only ships
  // the credential-less 'noop' adapter). Credentials are NEVER read into
  // config or logged.
  const provider = env.EMAIL_PROVIDER?.trim() || DEFAULTS.email.provider;
  return { provider };
}

function readWhatsApp(env: NodeJS.ProcessEnv): WhatsAppConfig {
  // Adapter-ready: only the provider discriminator is configured here. The
  // actual adapter implementation is selected at runtime by the WhatsApp
  // delivery module (which validates the provider and, for now, only ships
  // the credential-less 'noop' adapter). Credentials/tokens are NEVER read
  // into config or logged.
  const provider = env.WHATSAPP_PROVIDER?.trim() || DEFAULTS.whatsapp.provider;
  return { provider };
}

function readPush(env: NodeJS.ProcessEnv): PushConfig {
  // CR-BE-PUSH-01 PART 02 — adapter-ready: only the provider discriminator is
  // configured here. The actual adapter implementation is selected at runtime
  // by the push delivery module (which validates the provider and ships the
  // credential-less 'noop'/'capture' adapters plus the real 'fcm' adapter).
  // FCM service-account credentials are NEVER read into config or logged.
  const provider = env.PUSH_PROVIDER?.trim() || DEFAULTS.push.provider;
  return { provider };
}

function readScheduler(
  env: NodeJS.ProcessEnv,
  environment: NodeEnv,
): SchedulerConfig {
  // CR-BE-STAB-01 PART 04 — the scheduler MUST be disabled in the test
  // environment regardless of any explicit SCHEDULER_ENABLED, so tests never
  // start a background timer. Otherwise the default `enabled` is conservative:
  // on by default only in production (so reminders/escalations auto-run), off
  // in development, and always overridable via SCHEDULER_ENABLED.
  const enabled =
    environment === 'test'
      ? false
      : readBoolean(
          'SCHEDULER_ENABLED',
          env.SCHEDULER_ENABLED,
          environment === 'production',
        );

  const intervalMs = readPositiveInt(
    'SCHEDULER_INTERVAL_MS',
    env.SCHEDULER_INTERVAL_MS,
    DEFAULTS.scheduler.intervalMs,
    1_000,
  );

  return { enabled, intervalMs };
}

function readSecurity(
  env: NodeJS.ProcessEnv,
  environment: NodeEnv,
): SecurityConfig {
  return {
    corsOrigins: readCorsOrigins(env.CORS_ORIGINS, environment),
    jsonBodyLimit: readJsonBodyLimit(env.JSON_BODY_LIMIT),
    loginRateLimitWindowMinutes: readPositiveInt(
      'AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES',
      env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES,
      DEFAULTS.security.loginRateLimitWindowMinutes,
      1,
    ),
    loginRateLimitMaxAttempts: readPositiveInt(
      'AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS',
      env.AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
      DEFAULTS.security.loginRateLimitMaxAttempts,
      1,
    ),
  };
}

function readSession(env: NodeJS.ProcessEnv): SessionConfig {
  const ttlMinutes = readPositiveInt(
    'SESSION_TTL_MINUTES',
    env.SESSION_TTL_MINUTES,
    DEFAULTS.session.ttlMinutes,
    1,
  );
  const tokenBytes = readPositiveInt(
    'SESSION_TOKEN_BYTES',
    env.SESSION_TOKEN_BYTES,
    DEFAULTS.session.tokenBytes,
    16,
  );
  const lastUsedUpdateIntervalMs = readPositiveInt(
    'SESSION_LAST_USED_THROTTLE_MS',
    env.SESSION_LAST_USED_THROTTLE_MS,
    DEFAULTS.session.lastUsedUpdateIntervalMs,
    0,
  );

  return {
    ttlMinutes,
    ttlMs: ttlMinutes * 60_000,
    tokenBytes,
    lastUsedUpdateIntervalMs,
  };
}

function readInvitation(env: NodeJS.ProcessEnv): InvitationConfig {
  const ttlHours = readPositiveInt(
    'INVITATION_TTL_HOURS',
    env.INVITATION_TTL_HOURS,
    DEFAULTS.invitation.ttlHours,
    1,
  );

  return {
    ttlHours,
    ttlMs: ttlHours * 3_600_000,
  };
}

function readPositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  const value =
    raw === undefined || raw.trim() === '' ? String(fallback) : raw.trim();

  if (!/^\d+$/.test(value)) {
    throw new ConfigError(
      `Invalid configuration: ${name} must be an integer (received ${JSON.stringify(raw)})`,
    );
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < min) {
    throw new ConfigError(
      `Invalid configuration: ${name} must be at least ${min} (received ${JSON.stringify(raw)})`,
    );
  }

  return parsed;
}

function readCorsOrigins(raw: string | undefined, environment: NodeEnv): string[] {
  if (raw === undefined || raw.trim() === '') {
    return environment === 'production' ? [] : [...DEFAULTS.security.corsOrigins];
  }

  const origins = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (origins.length === 0) {
    throw new ConfigError(
      'Invalid configuration: CORS_ORIGINS must list at least one origin or be omitted',
    );
  }

  const normalized: string[] = [];

  for (const origin of origins) {
    if (!isHttpOrigin(origin)) {
      throw new ConfigError(
        `Invalid configuration: CORS_ORIGINS entries must be http(s) origins (received ${JSON.stringify(origin)})`,
      );
    }

    normalized.push(new URL(origin).origin);
  }

  return normalized;
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      (value === url.origin || value === `${url.origin}/`)
    );
  } catch {
    return false;
  }
}

function readJsonBodyLimit(raw: string | undefined): string {
  const value =
    raw === undefined || raw.trim() === ''
      ? DEFAULTS.security.jsonBodyLimit
      : raw.trim().toLowerCase();

  if (!/^\d+(b|kb|mb)$/.test(value)) {
    throw new ConfigError(
      `Invalid configuration: JSON_BODY_LIMIT must look like 1mb or 512kb (received ${JSON.stringify(raw)})`,
    );
  }

  return value;
}

function readLogLevel(raw: string | undefined): LogLevel {
  const value = raw === undefined || raw.trim() === '' ? DEFAULTS.logLevel : raw.trim();

  if (!isLogLevel(value)) {
    throw new ConfigError(
      `Invalid configuration: LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')} (received ${JSON.stringify(raw)})`,
    );
  }

  return value;
}

function isNodeEnv(value: string): value is NodeEnv {
  return (NODE_ENVS as readonly string[]).includes(value);
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }

  return value;
}

let cachedConfig: AppConfig | undefined;

export function getAppConfig(): AppConfig {
  cachedConfig ??= loadConfig();
  return cachedConfig;
}

export function resetAppConfigCache(): void {
  cachedConfig = undefined;
}
