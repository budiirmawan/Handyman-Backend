import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-PRO-02 PART 02 — Vendor Invitation + invitation-scoped external RFQ
 * session.
 *
 * This migration adds no Vendor Portal principal and no internal identity. An
 * invitation is a scoped Vendor response grant; its one-time token and the
 * follow-on external session are stored only as SHA-256 hashes. The tables
 * contain no quotation, comparison, award, PO, budget, or commitment data.
 */
export const migration0314CreateRfqVendorInvitationsAndSessions: Migration = {
  id: '0314_create_rfq_vendor_invitations_and_sessions',

  async up(client: PoolClient): Promise<void> {
    // Composite references prevent a future invitation from denormalising a
    // Client/Building that disagrees with the existing RFQ or Vendor master.
    await client.query(`
      ALTER TABLE rfqs
        ADD CONSTRAINT rfqs_vendor_invitation_scope_unique
          UNIQUE (id, client_id, building_id);
      ALTER TABLE vendors
        ADD CONSTRAINT vendors_rfq_invitation_scope_unique
          UNIQUE (id, client_id)
    `);

    await client.query(`
      CREATE TABLE rfq_vendor_invitations (
        id                         UUID PRIMARY KEY,
        rfq_id                     UUID NOT NULL,
        vendor_id                  UUID NOT NULL,
        client_id                  UUID NOT NULL,
        building_id                UUID NOT NULL,
        attempt_number             INTEGER NOT NULL,

        status                     TEXT NOT NULL DEFAULT 'INVITED',
        response_deadline_snapshot TIMESTAMPTZ NOT NULL,
        token_hash                 TEXT NOT NULL,
        token_expires_at           TIMESTAMPTZ NOT NULL,
        token_consumed_at          TIMESTAMPTZ,

        contact_source_type        TEXT NOT NULL DEFAULT 'VENDOR',
        contact_source_id          UUID NOT NULL,
        contact_name_snapshot      TEXT NOT NULL,
        recipient_email_snapshot   TEXT,

        viewed_at                  TIMESTAMPTZ,
        accepted_at                TIMESTAMPTZ,
        declined_at                TIMESTAMPTZ,
        no_bid_at                  TIMESTAMPTZ,
        expired_at                 TIMESTAMPTZ,
        revoked_at                 TIMESTAMPTZ,
        revoked_by_user_id         UUID REFERENCES users (id),
        response_reason            TEXT,

        idempotency_key            TEXT NOT NULL,
        idempotency_fingerprint    TEXT NOT NULL,
        created_by_user_id         UUID NOT NULL REFERENCES users (id),
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_vendor_invitations_rfq_scope_fk
          FOREIGN KEY (rfq_id, client_id, building_id)
          REFERENCES rfqs (id, client_id, building_id),
        CONSTRAINT rfq_vendor_invitations_vendor_scope_fk
          FOREIGN KEY (vendor_id, client_id)
          REFERENCES vendors (id, client_id),
        CONSTRAINT rfq_vendor_invitations_contact_vendor_fk
          FOREIGN KEY (contact_source_id, client_id)
          REFERENCES vendors (id, client_id),
        CONSTRAINT rfq_vendor_invitations_status_check
          CHECK (status IN (
            'INVITED', 'ACCEPTED', 'DECLINED', 'NO_BID',
            'EXPIRED', 'REVOKED', 'QUOTATION_SUBMITTED'
          )),
        CONSTRAINT rfq_vendor_invitations_contact_source_check
          CHECK (contact_source_type = 'VENDOR' AND contact_source_id = vendor_id),
        CONSTRAINT rfq_vendor_invitations_attempt_check
          CHECK (attempt_number >= 1),
        CONSTRAINT rfq_vendor_invitations_token_hash_check
          CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT rfq_vendor_invitations_token_expiry_check
          CHECK (token_expires_at > created_at),
        CONSTRAINT rfq_vendor_invitations_idempotency_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT rfq_vendor_invitations_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT rfq_vendor_invitations_scope_unique
          UNIQUE (id, rfq_id, vendor_id, client_id, building_id),
        CONSTRAINT rfq_vendor_invitations_revocation_check
          CHECK (
            (status <> 'REVOKED' AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
            OR (status = 'REVOKED' AND revoked_at IS NOT NULL
              AND revoked_by_user_id IS NOT NULL)
          ),
        CONSTRAINT rfq_vendor_invitations_expiry_check
          CHECK (
            (status <> 'EXPIRED' AND expired_at IS NULL)
            OR (status = 'EXPIRED' AND expired_at IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX rfq_vendor_invitations_token_hash_unique
        ON rfq_vendor_invitations (token_hash);
      CREATE UNIQUE INDEX rfq_vendor_invitations_attempt_unique
        ON rfq_vendor_invitations (rfq_id, vendor_id, attempt_number);
      CREATE UNIQUE INDEX rfq_vendor_invitations_idempotency_unique
        ON rfq_vendor_invitations (client_id, idempotency_key);
      CREATE UNIQUE INDEX rfq_vendor_invitations_active_vendor_unique
        ON rfq_vendor_invitations (rfq_id, vendor_id)
        WHERE status IN ('INVITED', 'ACCEPTED', 'QUOTATION_SUBMITTED');
      CREATE INDEX rfq_vendor_invitations_rfq_idx
        ON rfq_vendor_invitations (rfq_id, status, created_at DESC);
      CREATE INDEX rfq_vendor_invitations_vendor_idx
        ON rfq_vendor_invitations (vendor_id, status, created_at DESC);
      CREATE INDEX rfq_vendor_invitations_building_idx
        ON rfq_vendor_invitations (building_id, status, created_at DESC);
      CREATE INDEX rfq_vendor_invitations_expiry_idx
        ON rfq_vendor_invitations (token_expires_at, status)
        WHERE status IN ('INVITED', 'ACCEPTED');
    `);

    await client.query(`
      CREATE TABLE rfq_vendor_access_sessions (
        id                         UUID PRIMARY KEY,
        invitation_id              UUID NOT NULL,
        rfq_id                     UUID NOT NULL,
        vendor_id                  UUID NOT NULL,
        client_id                  UUID NOT NULL,
        building_id                UUID NOT NULL,
        session_token_hash         TEXT NOT NULL,
        status                     TEXT NOT NULL DEFAULT 'ACTIVE',
        issued_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at                 TIMESTAMPTZ NOT NULL,
        last_used_at               TIMESTAMPTZ,
        expired_at                 TIMESTAMPTZ,
        revoked_at                 TIMESTAMPTZ,
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_vendor_sessions_invitation_scope_fk
          FOREIGN KEY (invitation_id, rfq_id, vendor_id, client_id, building_id)
          REFERENCES rfq_vendor_invitations
            (id, rfq_id, vendor_id, client_id, building_id),
        CONSTRAINT rfq_vendor_sessions_token_hash_check
          CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT rfq_vendor_sessions_status_check
          CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
        CONSTRAINT rfq_vendor_sessions_expiry_check
          CHECK (expires_at > issued_at),
        CONSTRAINT rfq_vendor_sessions_lifecycle_check
          CHECK (
            (status = 'ACTIVE' AND revoked_at IS NULL AND expired_at IS NULL)
            OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND expired_at IS NULL)
            OR (status = 'EXPIRED' AND expired_at IS NOT NULL AND revoked_at IS NULL)
          ),
        CONSTRAINT rfq_vendor_sessions_invitation_unique
          UNIQUE (id, invitation_id, rfq_id, vendor_id, client_id, building_id)
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX rfq_vendor_sessions_token_hash_unique
        ON rfq_vendor_access_sessions (session_token_hash);
      CREATE UNIQUE INDEX rfq_vendor_sessions_active_invitation_unique
        ON rfq_vendor_access_sessions (invitation_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX rfq_vendor_sessions_invitation_idx
        ON rfq_vendor_access_sessions (invitation_id, status);
      CREATE INDEX rfq_vendor_sessions_vendor_idx
        ON rfq_vendor_access_sessions (vendor_id, status);
      CREATE INDEX rfq_vendor_sessions_expiry_idx
        ON rfq_vendor_access_sessions (expires_at, status)
        WHERE status = 'ACTIVE'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS rfq_vendor_access_sessions');
    await client.query('DROP TABLE IF EXISTS rfq_vendor_invitations');
    await client.query(`
      ALTER TABLE vendors
        DROP CONSTRAINT IF EXISTS vendors_rfq_invitation_scope_unique;
      ALTER TABLE rfqs
        DROP CONSTRAINT IF EXISTS rfqs_vendor_invitation_scope_unique
    `);
  },
};
