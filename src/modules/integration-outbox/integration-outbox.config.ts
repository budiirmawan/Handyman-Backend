/**
 * CR-BE-INTEG-01 PART 01 — integration webhook feature gate.
 *
 * Dark-by-default (governance §2.3 / §12): `INTEGRATION_WEBHOOKS_ENABLED`
 * defaults to `false`, so with the flag unset the enqueue seam is a cheap
 * no-op inside every business transaction and no outbox row is ever created.
 *
 * Module-local read (the whatsapp-callback config precedent): the key never
 * enters `env.ts` / `AppConfig`. Read per enqueue call so tests and operators
 * can flip it without process reconstruction; no secret material lives here.
 */
export function readIntegrationOutboxConfig(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
} {
  const raw = env.INTEGRATION_WEBHOOKS_ENABLED?.trim().toLowerCase() ?? '';
  return { enabled: ['true', '1', 'yes', 'on'].includes(raw) };
}
