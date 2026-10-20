import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-MASTER-TENANT-BATCH-01 — Tenant/PIC batch import and verification.
 *
 * BOUNDED, ADDITIVE ONLY. Nothing here duplicates an existing master:
 *
 *  1. `tenant_companies.verification_status` / `tenant_pics.verification_status`
 *     — a clear, explicit verification state for temporary registrations
 *     (batch-imported or hand-entered) without touching the lifecycle
 *     `status` column. Existing rows default to `VERIFIED`, so every existing
 *     caller and every Customer Care flow keeps byte-identical behavior.
 *     Unverified data must never receive approval authority or billing
 *     authority (enforced in the request-party designation services).
 *
 *  2. `tenant_import_batches` / `tenant_import_rows` — the durable audit trail
 *     of a batch import (upload → validate → confirm → commit, with abort as
 *     the rollback of a staged batch). Rows record per-row outcomes and errors
 *     and reference the party master they created or reused; they NEVER carry
 *     a second copy of party data as a master. Idempotency:
 *       - batch level: optional `idempotency_key` unique per Client,
 *       - row level: `row_key` (deterministic party identity) unique per
 *         batch, resolved against `tenant_companies` at commit so a re-import
 *         reuses the existing party instead of duplicating it.
 *
 *  3. Audit vocabulary extension — six additive event types for the import
 *     lifecycle and the verification action. No existing event type is
 *     removed or renamed (0452/0453/0454 idiom).
 *
 * Client/Building isolation stays the existing BE-02/BE-14 rule: a batch is
 * scoped to one Client and every row's Unit references are checked against
 * the actor's ACTIVE Building assignments at validation and again at commit.
 */

const PREVIOUS_AUDIT_EVENT_TYPES = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGOUT',
  'INVITATION_CREATED',
  'INVITATION_ACCEPTED',
  'INVITATION_REVOKED',
  'ACCOUNT_DEACTIVATED',
  'ACCOUNT_REACTIVATED',
  'ACCOUNT_SUSPENDED',
  'OWNER_BOOTSTRAPPED',
  'PASSWORD_RESET',
  'PASSWORD_CHANGED',
  'ROLE_ASSIGNED',
  'ROLE_REVOKED',
  'BUILDING_ASSIGNED',
  'BUILDING_REVOKED',
  'CLIENT_CREATED',
  'CLIENT_UPDATED',
] as const;

const TENANT_IMPORT_AUDIT_EVENT_TYPES = [
  ...PREVIOUS_AUDIT_EVENT_TYPES,
  'TENANT_IMPORT_UPLOADED',
  'TENANT_IMPORT_VALIDATED',
  'TENANT_IMPORT_CONFIRMED',
  'TENANT_IMPORT_COMMITTED',
  'TENANT_IMPORT_ABORTED',
  'TENANT_VERIFICATION_UPDATED',
] as const;

function eventTypeCheck(values: readonly string[]): string {
  return `CHECK (event_type IN (${values
    .map((value) => `'${value}'`)
    .join(', ')}))`;
}

export const migration0457TenantBatchImport: Migration = {
  id: '0457_tenant_batch_import',

  async up(client: PoolClient): Promise<void> {
    // ---- 1. Verification state on the existing party/PIC masters --------
    await client.query(`
      ALTER TABLE tenant_companies
        ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'VERIFIED',
        ADD CONSTRAINT tenant_companies_verification_status_check
          CHECK (verification_status IN ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED'))
    `);
    await client.query(`
      ALTER TABLE tenant_pics
        ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'VERIFIED',
        ADD CONSTRAINT tenant_pics_verification_status_check
          CHECK (verification_status IN ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED'))
    `);
    await client.query(`
      CREATE INDEX tenant_companies_verification_status_idx
        ON tenant_companies (client_id, verification_status)
    `);

    // ---- 2. Batch import header + rows ---------------------------------
    await client.query(`
      CREATE TABLE tenant_import_batches (
        id                  UUID PRIMARY KEY,
        client_id           UUID NOT NULL REFERENCES clients (id),
        idempotency_key     TEXT,
        source_name         TEXT NOT NULL,
        source_checksum     TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'UPLOADED',
        total_rows          INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
        valid_rows          INTEGER NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
        invalid_rows        INTEGER NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
        committed_rows      INTEGER NOT NULL DEFAULT 0 CHECK (committed_rows >= 0),
        skipped_rows        INTEGER NOT NULL DEFAULT 0 CHECK (skipped_rows >= 0),
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        validated_at        TIMESTAMPTZ,
        confirmed_at        TIMESTAMPTZ,
        committed_at        TIMESTAMPTZ,
        aborted_at          TIMESTAMPTZ,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_import_batches_status_check
          CHECK (status IN ('UPLOADED', 'VALIDATED', 'CONFIRMED', 'COMMITTED', 'ABORTED'))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX tenant_import_batches_idempotency_unique
        ON tenant_import_batches (client_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX tenant_import_batches_client_idx
        ON tenant_import_batches (client_id, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE tenant_import_rows (
        id                UUID PRIMARY KEY,
        batch_id          UUID NOT NULL REFERENCES tenant_import_batches (id) ON DELETE CASCADE,
        client_id         UUID NOT NULL REFERENCES clients (id),
        row_number        INTEGER NOT NULL CHECK (row_number >= 1),
        row_key           TEXT NOT NULL,
        payload           JSONB NOT NULL,
        status            TEXT NOT NULL DEFAULT 'PENDING',
        error_code        TEXT,
        error_message     TEXT,
        outcome           JSONB NOT NULL DEFAULT '{}'::jsonb,
        tenant_company_id UUID REFERENCES tenant_companies (id),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_import_rows_status_check
          CHECK (status IN ('PENDING', 'VALID', 'INVALID', 'COMMITTED', 'SKIPPED_EXISTS', 'FAILED')),
        CONSTRAINT tenant_import_rows_batch_row_unique UNIQUE (batch_id, row_number),
        CONSTRAINT tenant_import_rows_batch_key_unique UNIQUE (batch_id, row_key)
      )
    `);
    await client.query(`
      CREATE INDEX tenant_import_rows_batch_status_idx
        ON tenant_import_rows (batch_id, status)
    `);

    // ---- 3. Audit vocabulary extension ---------------------------------
    await client.query(
      'ALTER TABLE authentication_audit_events DROP CONSTRAINT authentication_audit_events_event_type_check',
    );
    await client.query(`
      ALTER TABLE authentication_audit_events
        ADD CONSTRAINT authentication_audit_events_event_type_check
        ${eventTypeCheck(TENANT_IMPORT_AUDIT_EVENT_TYPES)}
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Audit history is append-only: rows are never deleted. Narrowing the
    // CHECK first fails loudly if TENANT_* events already exist (0452/0453/
    // 0454 idiom).
    await client.query(
      'ALTER TABLE authentication_audit_events DROP CONSTRAINT authentication_audit_events_event_type_check',
    );
    await client.query(`
      ALTER TABLE authentication_audit_events
        ADD CONSTRAINT authentication_audit_events_event_type_check
        ${eventTypeCheck(PREVIOUS_AUDIT_EVENT_TYPES)}
    `);
    await client.query('DROP TABLE IF EXISTS tenant_import_rows');
    await client.query('DROP TABLE IF EXISTS tenant_import_batches');
    await client.query(
      'ALTER TABLE tenant_pics DROP CONSTRAINT IF EXISTS tenant_pics_verification_status_check',
    );
    await client.query(
      'ALTER TABLE tenant_pics DROP COLUMN IF EXISTS verification_status',
    );
    await client.query(
      'DROP INDEX IF EXISTS tenant_companies_verification_status_idx',
    );
    await client.query(
      'ALTER TABLE tenant_companies DROP CONSTRAINT IF EXISTS tenant_companies_verification_status_check',
    );
    await client.query(
      'ALTER TABLE tenant_companies DROP COLUMN IF EXISTS verification_status',
    );
  },
};
