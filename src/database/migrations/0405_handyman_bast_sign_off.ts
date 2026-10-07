import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-11 PART 02 — customer ACCEPT/REJECT + signature bind.
 * Sign-off rows are bound to BAST events; BAST status remains the
 * sole acceptance authority (governance B7). NO warranty, ledger,
 * HTTP, or FM BAST dual-write.
 */
export const migration0405HandymanBastSignOff: Migration = {
  id: '0405_handyman_bast_sign_off',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_bast_documents
        ADD COLUMN accepted_at TIMESTAMPTZ,
        ADD COLUMN rejected_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE handyman_bast_documents
        ADD CONSTRAINT handyman_bast_accepted_at_check
          CHECK (accepted_at IS NULL OR status = 'ACCEPTED')
    `);
    await client.query(`
      ALTER TABLE handyman_bast_documents
        ADD CONSTRAINT handyman_bast_rejected_at_check
          CHECK (rejected_at IS NULL OR status = 'REJECTED')
    `);

    await client.query(`
      ALTER TABLE handyman_bast_events
        DROP CONSTRAINT handyman_bast_events_type_check
    `);
    await client.query(`
      ALTER TABLE handyman_bast_events
        ADD CONSTRAINT handyman_bast_events_type_check
          CHECK (event_type IN (
            'PREPARE', 'ISSUE', 'VOID', 'ACCEPT', 'REJECT'))
    `);

    await client.query(`
      CREATE TABLE handyman_bast_sign_offs (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        bast_id            UUID NOT NULL
          REFERENCES handyman_bast_documents (id),
        event_id           UUID NOT NULL
          REFERENCES handyman_bast_events (id),
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        decision           TEXT NOT NULL,
        signature_digest   TEXT NOT NULL DEFAULT '',
        evidence_record_id UUID
          REFERENCES handyman_evidence_records (id),
        reject_reason      TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_bast_sign_off_decision_check
          CHECK (decision IN ('ACCEPT', 'REJECT')),
        CONSTRAINT handyman_bast_sign_off_accept_signature_check
          CHECK (decision <> 'ACCEPT' OR length(signature_digest) > 0)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_bast_sign_offs_event_idx
        ON handyman_bast_sign_offs (event_id)
    `);
    await client.query(`
      CREATE INDEX handyman_bast_sign_offs_bast_idx
        ON handyman_bast_sign_offs (bast_id, created_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bast_sign_off_consistency()
      RETURNS trigger AS $$
      DECLARE
        parent_client UUID;
        parent_scope  UUID;
        parent_event_type TEXT;
        parent_bast UUID;
      BEGIN
        SELECT client_id, execution_scope_id, event_type, bast_id
          INTO parent_client, parent_scope, parent_event_type, parent_bast
          FROM handyman_bast_events
          WHERE id = NEW.event_id;
        IF parent_client IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM parent_client
           OR NEW.execution_scope_id IS DISTINCT FROM parent_scope
           OR NEW.bast_id IS DISTINCT FROM parent_bast THEN
          RAISE EXCEPTION
            'Handyman BAST sign-off must match parent event client/scope/bast.';
        END IF;
        IF NEW.decision IS DISTINCT FROM parent_event_type THEN
          RAISE EXCEPTION
            'Handyman BAST sign-off decision must match the parent event type.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bast_sign_off_parent_check
        BEFORE INSERT OR UPDATE ON handyman_bast_sign_offs
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bast_sign_off_consistency();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bast_sign_off_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman BAST sign-off rows cannot be updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bast_sign_offs_no_write
        BEFORE UPDATE OR DELETE ON handyman_bast_sign_offs
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bast_sign_off_no_write();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_bast_sign_offs_no_write
        ON handyman_bast_sign_offs;
      DROP TRIGGER IF EXISTS handyman_bast_sign_off_parent_check
        ON handyman_bast_sign_offs;
      DROP FUNCTION IF EXISTS handyman_bast_sign_off_no_write;
      DROP FUNCTION IF EXISTS handyman_bast_sign_off_consistency;
      DROP TABLE IF EXISTS handyman_bast_sign_offs;
    `);
    await client.query(`
      ALTER TABLE handyman_bast_events
        DROP CONSTRAINT IF EXISTS handyman_bast_events_type_check
    `);
    await client.query(`
      ALTER TABLE handyman_bast_events
        ADD CONSTRAINT handyman_bast_events_type_check
          CHECK (event_type IN ('PREPARE', 'ISSUE', 'VOID'))
    `);
    await client.query(`
      ALTER TABLE handyman_bast_documents
        DROP CONSTRAINT IF EXISTS handyman_bast_rejected_at_check,
        DROP CONSTRAINT IF EXISTS handyman_bast_accepted_at_check,
        DROP COLUMN IF EXISTS rejected_at,
        DROP COLUMN IF EXISTS accepted_at
    `);
  },
};
