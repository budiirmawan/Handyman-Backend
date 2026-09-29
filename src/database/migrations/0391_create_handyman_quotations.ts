import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-06 PART 01 — Handyman quotation foundation + immutable versions
 * (FROZEN Decision Freeze F1/F2/F3/F4/F5 in
 * docs/handyman/CR-HM-06_DECISION_FREEZE.md).
 *
 * Additive minimum (new bounded tables; reverting `down`; nothing else
 * touched):
 *
 *   handyman_quotations           Handyman-owned quotation ROOT bound to
 *     exactly one CR-HM-02 service request (client scope snapshotted;
 *     composite FK (request, client) preserves tenant isolation; UNIQUE
 *     request = one quotation thread per request). NO FM/vendor
 *     quotation linkage exists here.
 *
 *   handyman_quotation_versions   immutable VERSION rows: monotonic
 *     versionNumber per quotation (UNIQUE pair), bounded status
 *     vocabulary exactly DRAFT | ISSUED | APPROVED | REJECTED | EXPIRED
 *     | SUPERSEDED, nullable validUntil (PART 03 lifecycle semantics
 *     NOT implemented yet; new rows start DRAFT).
 *
 * DB protection (family of 0381/0382 triggers): DELETE is blocked on
 * both tables; UPDATE on quotation root is blocked except updated_at;
 * UPDATE on versions is blocked EXCEPT the lifecycle projection columns
 * (status, valid_until, updated_at) so PART 03 can project lifecycle
 * without ever rewriting immutable identity/version/commercial facts.
 * Commercial line facts are PART 02's concern and do not exist here.
 */
export const migration0391CreateHandymanQuotations: Migration = {
  id: '0391_create_handyman_quotations',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_quotations (
        id                  UUID PRIMARY KEY,
        client_id           UUID NOT NULL REFERENCES clients (id),
        handyman_request_id UUID NOT NULL,
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_quotations_request_unique
          UNIQUE (handyman_request_id),
        CONSTRAINT handyman_quotations_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id)
      )
    `);
    await client.query(`
      CREATE TABLE handyman_quotation_versions (
        id                 UUID PRIMARY KEY,
        quotation_id       UUID NOT NULL REFERENCES handyman_quotations (id),
        version_number     INTEGER NOT NULL,
        status             TEXT NOT NULL DEFAULT 'DRAFT',
        valid_until        TIMESTAMPTZ,
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_quotation_versions_version_check
          CHECK (version_number >= 1),
        CONSTRAINT handyman_quotation_versions_status_check
          CHECK (status IN
            ('DRAFT', 'ISSUED', 'APPROVED', 'REJECTED', 'EXPIRED',
             'SUPERSEDED')),
        CONSTRAINT handyman_quotation_versions_pair_unique
          UNIQUE (quotation_id, version_number)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_quotations_scope_idx
        ON handyman_quotations (client_id, created_at)
    `);
    await client.query(`
      CREATE INDEX handyman_quotation_versions_thread_idx
        ON handyman_quotation_versions (quotation_id, version_number)
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_quotation_root_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Handyman quotation roots are never deleted.';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.client_id IS DISTINCT FROM OLD.client_id
        OR NEW.handyman_request_id IS DISTINCT FROM OLD.handyman_request_id
        OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'Handyman quotation identity facts are immutable.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_quotation_version_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Handyman quotation versions are never deleted.';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.quotation_id IS DISTINCT FROM OLD.quotation_id
        OR NEW.version_number IS DISTINCT FROM OLD.version_number
        OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'Handyman quotation version facts are immutable.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_quotation_root_no_write
        BEFORE UPDATE OR DELETE ON handyman_quotations
        FOR EACH ROW EXECUTE FUNCTION handyman_quotation_root_block_mutation();
      CREATE TRIGGER handyman_quotation_version_no_write
        BEFORE UPDATE OR DELETE ON handyman_quotation_versions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_quotation_version_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_quotation_version_no_write
        ON handyman_quotation_versions;
      DROP TRIGGER IF EXISTS handyman_quotation_root_no_write
        ON handyman_quotations;
      DROP FUNCTION IF EXISTS handyman_quotation_version_block_mutation;
      DROP FUNCTION IF EXISTS handyman_quotation_root_block_mutation;
      DROP TABLE IF EXISTS handyman_quotation_versions;
      DROP TABLE IF EXISTS handyman_quotations;
    `);
  },
};
