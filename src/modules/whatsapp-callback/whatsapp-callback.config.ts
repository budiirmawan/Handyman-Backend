import { ConfigError } from '../../config';

/**
 * CR-BE-NOTIFY-PROV-01 PART 07 — callback configuration boundary.
 *
 * Read at router construction ONLY — never by `env.ts`/`AppConfig` (the
 * governance §8 secret boundary applies to callback credentials exactly as
 * it does to send credentials). `WHATSAPP_META_APP_SECRET` never leaves
 * this module except as an HMAC key; error messages name fields only.
 *
 * Keys:
 *   WHATSAPP_WEBHOOK_ENABLED            — default false (conservative),
 *   WHATSAPP_META_APP_SECRET            — required when enabled,
 *   WHATSAPP_META_WEBHOOK_VERIFY_TOKEN  — required when enabled.
 */
export function readWhatsAppCallbackConfig(
  env: NodeJS.ProcessEnv = process.env,
): {
  enabled: boolean;
  appSecret: string | null;
  verifyToken: string | null;
} {
  const enabledRaw = env.WHATSAPP_WEBHOOK_ENABLED?.trim().toLowerCase() ?? '';
  const enabled = ['true', '1', 'yes', 'on'].includes(enabledRaw);

  const appSecret = env.WHATSAPP_META_APP_SECRET?.trim() || null;
  const verifyToken = env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN?.trim() || null;

  if (enabled) {
    if (!appSecret) {
      throw new ConfigError(
        'Invalid configuration: WHATSAPP_META_APP_SECRET is required when WHATSAPP_WEBHOOK_ENABLED=true.',
      );
    }
    if (!verifyToken) {
      throw new ConfigError(
        'Invalid configuration: WHATSAPP_META_WEBHOOK_VERIFY_TOKEN is required when WHATSAPP_WEBHOOK_ENABLED=true.',
      );
    }
  }

  return { enabled, appSecret, verifyToken };
}
