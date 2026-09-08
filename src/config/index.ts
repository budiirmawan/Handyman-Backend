import { getAppConfig, type AppConfig } from './env';

export {
  ConfigError,
  getAppConfig,
  loadConfig,
  loadDotEnv,
  parseConfig,
  parseEnvFile,
  resetAppConfigCache,
} from './env';

export type {
  AppConfig,
  DatabaseConfig,
  EmailConfig,
  InvitationConfig,
  LogLevel,
  NodeEnv,
  PushConfig,
  SchedulerConfig,
  SecurityConfig,
  SessionConfig,
  StorageConfig,
  WhatsAppConfig,
} from './env';

/**
 * Validated process configuration.
 * Values are resolved lazily on first property access so the server
 * entrypoint can report configuration errors without an import-time crash.
 */
export const appConfig: AppConfig = Object.freeze({
  get environment() {
    return getAppConfig().environment;
  },
  get port() {
    return getAppConfig().port;
  },
  get apiPrefix() {
    return getAppConfig().apiPrefix;
  },
  get logLevel() {
    return getAppConfig().logLevel;
  },
  get isDevelopment() {
    return getAppConfig().isDevelopment;
  },
  get isTest() {
    return getAppConfig().isTest;
  },
  get isProduction() {
    return getAppConfig().isProduction;
  },
  get database() {
    return getAppConfig().database;
  },
  get security() {
    return getAppConfig().security;
  },
  get session() {
    return getAppConfig().session;
  },
  get invitation() {
    return getAppConfig().invitation;
  },
  get storage() {
    return getAppConfig().storage;
  },
  get email() {
    return getAppConfig().email;
  },
  get whatsapp() {
    return getAppConfig().whatsapp;
  },
  get push() {
    return getAppConfig().push;
  },
  get scheduler() {
    return getAppConfig().scheduler;
  },
});
