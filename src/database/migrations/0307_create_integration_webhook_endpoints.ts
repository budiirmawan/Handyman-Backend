import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-INTEG-01 PART 02 — Webhook endpoint registry.
 *
 * Client-scoped (optionally Building-narrowed) outbound webhook endpoint
 * configuration (governance §3):
 *
 *   - `url`            — HTTPS receiver URL (SSRF-validated at write time),
 *   - `event_types`    — subscribed BE-07 event-type codes (non-empty,
 *     recursion-blocked families rejected at write time),
 *   - `status`         — ACTIVE / INACTIVE (INACTIVE is the retirement path;
 *     no hard delete exists, so historical deliveries always keep a valid FK),
 *   - `signing_secret` — server-generated HMAC key. WRITE-ONLY: returned
 *     exactly once at create/rotate and never selected by any normal read
 *     projection (repository discipline),
 *   - `timeout_ms`     — bounded per-endpoint receiver timeout.
 *
 * No delivery ledger, fan-out, HTTP sending, or retry concern lives here
 * (PART 03+).
 */
export const migration0307CreateIntegrationWebhookEndpoints: Migration = {
  id: '0307_create_integration_webhook_endpoints',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE integration_webhook_endpoints (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL REFERENCES clients (id),
        building_id       UUID REFERENCES buildings (id),
        name              TEXT NOT NULL,
        url               TEXT NOT NULL,
        event_types       TEXT[] NOT NULL,
        status            TEXT NOT NULL DEFAULT 'ACTIVE',
        signing_secret    TEXT NOT NULL,
        secret_rotated_at TIMESTAMPTZ,
        timeout_ms        INTEGER NOT NULL DEFAULT 10000,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT integration_webhook_endpoints_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT integration_webhook_endpoints_timeout_check
          CHECK (timeout_ms BETWEEN 1000 AND 30000),
        CONSTRAINT integration_webhook_endpoints_event_types_check
          CHECK (array_length(event_types, 1) >= 1)
      )
    `);

    await client.query(`
      CREATE INDEX integration_webhook_endpoints_client_idx
        ON integration_webhook_endpoints (client_id, status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS integration_webhook_endpoints');
  },
};
