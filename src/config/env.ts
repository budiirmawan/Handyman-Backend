import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * CR-HM-DB-OPT-01 PART 02 — process-level connection pool settings.
 *
 * Defaults are the historical hard-coded values (max 10, 5s acquisition,
 * 30s idle) so existing deployments observe zero behavior change until an
 * operator opts in via environment variables. Statement timeouts default to
 * DISABLED (0): long maintenance DDL (e.g. CREATE INDEX CONCURRENTLY during
 * migrations) must never be aborted by an application-side timeout, and
 * enabling a statement timeout in production is an explicit operator
 * decision documented in the DBA runbook.
 */
export type DatabasePoolSettings = {
  max: number;
  min: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  /** 0 disables the server-side statement_timeout for pooled sessions. */
  statementTimeoutMs: number;
  /** 0 disables idle_in_transaction_session_timeout for pooled sessions. */
  idleInTransactionSessionTimeoutMs: number;
};

export type DatabaseConfig = {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  ssl: boolean;
  pool: DatabasePoolSettings;
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
    pool: {
      max: 10,
      min: 0,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 0,
      idleInTransactionSessionTimeoutMs: 0,
    },
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

  // CR-HM-DB-OPT-01 PART 02 — Railway injects a PRIVATE DATABASE_URL for
  // same-environment Postgres traffic. It is accepted as the connection base;
  // any explicitly-set DB_* variable still wins field-by-field so existing
  // deployments (and tests) keep full control. Never fall back to
  // DATABASE_PUBLIC_URL: application runtime must stay on the private
  // endpoint (DBA runbook §"Railway networking").
  const fromUrl = readDatabaseUrl(env.DATABASE_URL);

  return {
    host: readRequiredText(
      'DB_HOST',
      env.DB_HOST,
      fromUrl?.host ?? DEFAULTS.database.host,
    ),
    port: readPortValue(
      'DB_PORT',
      env.DB_PORT,
      fromUrl?.port ?? DEFAULTS.database.port,
    ),
    name: readRequiredText(
      'DB_NAME',
      env.DB_NAME,
      fromUrl?.name ?? defaultName,
    ),
    user: readRequiredText(
      'DB_USER',
      env.DB_USER,
      fromUrl?.user ?? DEFAULTS.database.user,
    ),
    password: env.DB_PASSWORD ?? fromUrl?.password ?? '',
    ssl: readBoolean('DB_SSL', env.DB_SSL, fromUrl?.ssl ?? DEFAULTS.database.ssl),
    pool: readDatabasePool(env),
  };
}

type DatabaseUrlParts = {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  ssl: boolean;
};

/**
 * Parses a postgres:// or postgresql:// connection URI (RFC "authority" form,
 * as produced by Railway). Returns null when unset. A malformed URI is a
 * configuration error, never a silent fallback: the process must not boot with
 * a connection it did not intend.
 */
function readDatabaseUrl(raw: string | undefined): DatabaseUrlParts | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(
      'Invalid configuration: DATABASE_URL must be a valid postgres:// or postgresql:// URI',
    );
  }

  const protocol = parsed.protocol.replace(/:$/, '');
  if (protocol !== 'postgres' && protocol !== 'postgresql') {
    throw new ConfigError(
      `Invalid configuration: DATABASE_URL must use the postgres:// or postgresql:// scheme (received ${JSON.stringify(protocol)})`,
    );
  }

  const host = parsed.hostname;
  if (host === '') {
    throw new ConfigError(
      'Invalid configuration: DATABASE_URL must include a host',
    );
  }

  // Path is "/dbname"; an empty path is not a usable default here because the
  // URL was explicitly supplied — require the database name on the URL.
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name === '') {
    throw new ConfigError(
      'Invalid configuration: DATABASE_URL must include a database name in its path',
    );
  }

  const port =
    parsed.port === ''
      ? DEFAULTS.database.port
      : Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `Invalid configuration: DATABASE_URL port must be an integer between 1 and 65535 (received ${JSON.stringify(parsed.port)})`,
    );
  }

  return {
    host,
    port,
    name,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl: readUrlSslMode(parsed.searchParams.get('sslmode')),
  };
}

/**
 * Maps the libpq sslmode query parameter onto the boolean SSL flag the pg
 * driver is configured with. Unknown values fail closed toward SSL enabled,
 * but an explicitly unrecognized value is rejected so typos never silently
 * downgrade transport security.
 */
function readUrlSslMode(raw: string | null): boolean {
  if (raw === null || raw.trim() === '') {
    return DEFAULTS.database.ssl;
  }

  const value = raw.trim().toLowerCase();
  if (value === 'disable' || value === 'allow') {
    return false;
  }
  if (value === 'require' || value === 'prefer' || value === 'verify-ca' || value === 'verify-full') {
    return true;
  }

  throw new ConfigError(
    `Invalid configuration: DATABASE_URL sslmode must be one of disable, allow, prefer, require, verify-ca, verify-full (received ${JSON.stringify(raw)})`,
  );
}

function readDatabasePool(env: NodeJS.ProcessEnv): DatabasePoolSettings {
  const max = readBoundedInt(
    'DB_POOL_MAX',
    env.DB_POOL_MAX,
    DEFAULTS.database.pool.max,
    1,
    100,
  );
  const min = readBoundedInt(
    'DB_POOL_MIN',
    env.DB_POOL_MIN,
    DEFAULTS.database.pool.min,
    0,
    100,
  );
  if (min > max) {
    throw new ConfigError(
      `Invalid configuration: DB_POOL_MIN (${min}) must not exceed DB_POOL_MAX (${max})`,
    );
  }

  return {
    max,
    min,
    connectionTimeoutMs: readBoundedInt(
      'DB_CONNECTION_TIMEOUT_MS',
      env.DB_CONNECTION_TIMEOUT_MS,
      DEFAULTS.database.pool.connectionTimeoutMs,
      100,
      120_000,
    ),
    idleTimeoutMs: readBoundedInt(
      'DB_IDLE_TIMEOUT_MS',
      env.DB_IDLE_TIMEOUT_MS,
      DEFAULTS.database.pool.idleTimeoutMs,
      1_000,
      600_000,
    ),
    statementTimeoutMs: readBoundedInt(
      'DB_STATEMENT_TIMEOUT_MS',
      env.DB_STATEMENT_TIMEOUT_MS,
      DEFAULTS.database.pool.statementTimeoutMs,
      0,
      3_600_000,
    ),
    idleInTransactionSessionTimeoutMs: readBoundedInt(
      'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS',
      env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      DEFAULTS.database.pool.idleInTransactionSessionTimeoutMs,
      0,
      3_600_000,
    ),
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

/** Inclusive [min, max] integer reader used for pool sizing and timeouts. */
function readBoundedInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value =
    raw === undefined || raw.trim() === '' ? String(fallback) : raw.trim();

  if (!/^\d+$/.test(value)) {
    throw new ConfigError(
      `Invalid configuration: ${name} must be an integer between ${min} and ${max} (received ${JSON.stringify(raw)})`,
    );
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < min || parsed > max) {
    throw new ConfigError(
      `Invalid configuration: ${name} must be an integer between ${min} and ${max} (received ${JSON.stringify(raw)})`,
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
