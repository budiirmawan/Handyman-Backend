import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-12 PART 01 — Handyman commercial agreement aggregate +
 * immutable effective versions (FROZEN `CR-HM-12_START_GOVERNANCE.md`
 * §5: aggregate, versioning, binding, uniqueness; §3 FK discipline).
 *
 * Three additive tables; reverting `down`; nothing else touched:
 *
 *   handyman_commercial_agreements           ONE agreement root per
 *     client (realm `clients`): UNIQUE(client_id) is the §5 aggregate
 *     law. Identity is immutable; DELETE is blocked. No code/name
 *     column is invented — the client IS the aggregate anchor.
 *
 *   handyman_commercial_agreement_versions   immutable VERSION rows:
 *     monotonic version_number (UNIQUE pair), bounded status
 *     vocabulary DRAFT | ACTIVE | SUPERSEDED, window columns
 *     effective_from / effective_to with status-consistency CHECKs,
 *     and a partial UNIQUE index enforcing AT MOST ONE ACTIVE
 *     version per agreement (fail-closed bounded conflict — §5
 *     uniqueness; supersession, not first-wins). A plpgsql overlap
 *     guard forbids any two effective windows covering one instant,
 *     so "at most one ACTIVE version per agreement per as-of" also
 *     holds for historical (SUPERSEDED) rows. Identity/version facts
 *     are UPDATE-blocked; DELETE is blocked; only the lifecycle
 *     projection (status, window, updated_at) is legal to write —
 *     the §5 supersession-creates-a-new-version law.
 *
 *   handyman_commercial_agreement_events     append-only event stream
 *     (PREPARE | ACTIVATE | SUPERSEDE) with per-agreement idempotency
 *     uniqueness (0402/0404 family). UPDATE/DELETE blocked.
 *
 * ZERO pricing columns, ZERO fee/rate/amount/currency columns, ZERO
 * ledger/payment/BM-fee vocabulary (PART 01 forbids pricing math and
 * fee rules — §10). ZERO SaaS `platform_*` and FM financial FKs: the
 * tenant FK graph reaches only clients, users, and these three
 * Handyman tables (§3).
 */
export const migration0406CreateHandymanCommercialAgreements: Migration = {
  id: '0406_create_handyman_commercial_agreements',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_commercial_agreements (
        id                  UUID PRIMARY KEY,
        client_id           UUID NOT NULL
          REFERENCES clients (id),
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_commercial_agreements_client_unique
          UNIQUE (client_id)
      )
    `);
    await client.query(`
      CREATE TABLE handyman_commercial_agreement_versions (
        id                  UUID PRIMARY KEY,
        agreement_id        UUID NOT NULL
          REFERENCES handyman_commercial_agreements (id),
        version_number      INTEGER NOT NULL,
        status              TEXT NOT NULL DEFAULT 'DRAFT',
        effective_from      TIMESTAMPTZ,
        effective_to        TIMESTAMPTZ,
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_commercial_agreement_versions_number_check
          CHECK (version_number >= 1),
        CONSTRAINT handyman_commercial_agreement_versions_status_check
          CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED')),
        CONSTRAINT handyman_commercial_agreement_versions_pair_unique
          UNIQUE (agreement_id, version_number),
        CONSTRAINT handyman_commercial_agreement_versions_draft_check
          CHECK (status <> 'DRAFT'
            OR (effective_from IS NULL AND effective_to IS NULL)),
        CONSTRAINT handyman_commercial_agreement_versions_active_check
          CHECK (status <> 'ACTIVE'
            OR (effective_from IS NOT NULL AND effective_to IS NULL)),
        CONSTRAINT handyman_commercial_agreement_versions_superseded_check
          CHECK (status <> 'SUPERSEDED'
            OR (effective_from IS NOT NULL
                AND effective_to IS NOT NULL
                AND effective_to > effective_from))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_commercial_agreement_one_active_idx
        ON handyman_commercial_agreement_versions (agreement_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX handyman_commercial_agreement_versions_window_idx
        ON handyman_commercial_agreement_versions (
          agreement_id, effective_from
        )
    `);
    await client.query(`
      CREATE TABLE handyman_commercial_agreement_events (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL
          REFERENCES clients (id),
        agreement_id      UUID NOT NULL
          REFERENCES handyman_commercial_agreements (id),
        version_id        UUID NOT NULL
          REFERENCES handyman_commercial_agreement_versions (id),
        event_type        TEXT NOT NULL,
        idempotency_key   TEXT NOT NULL,
        actor_user_id     UUID NOT NULL REFERENCES users (id),
        occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_commercial_agreement_events_type_check
          CHECK (event_type IN ('PREPARE', 'ACTIVATE', 'SUPERSEDE')),
        CONSTRAINT handyman_commercial_agreement_events_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_commercial_agreement_events_idem_unique
          UNIQUE (agreement_id, event_type, idempotency_key)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_commercial_agreement_events_agreement_idx
        ON handyman_commercial_agreement_events (agreement_id, occurred_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_commercial_agreement_event_consistency()
      RETURNS trigger AS $$
      DECLARE
        parent_client    UUID;
        parent_agreement UUID;
      BEGIN
        SELECT a.client_id, v.agreement_id
          INTO parent_client, parent_agreement
          FROM handyman_commercial_agreement_versions v
          JOIN handyman_commercial_agreements a ON a.id = v.agreement_id
          WHERE v.id = NEW.version_id;
        IF parent_client IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.agreement_id IS DISTINCT FROM parent_agreement
           OR NEW.client_id IS DISTINCT FROM parent_client THEN
          RAISE EXCEPTION
            'Handyman commercial agreement event must match its version parent (client + agreement).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_commercial_agreement_events_parent_check
        BEFORE INSERT OR UPDATE ON handyman_commercial_agreement_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_commercial_agreement_event_consistency();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_commercial_agreement_window_overlap()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.effective_from IS NOT NULL THEN
          IF EXISTS (
            SELECT 1
              FROM handyman_commercial_agreement_versions other
             WHERE other.agreement_id = NEW.agreement_id
               AND other.id <> NEW.id
               AND other.effective_from IS NOT NULL
               AND tstzrange(
                     other.effective_from,
                     COALESCE(other.effective_to, 'infinity')
                   ) && tstzrange(
                     NEW.effective_from,
                     COALESCE(NEW.effective_to, 'infinity')
                   )
          ) THEN
            RAISE EXCEPTION
              'Handyman commercial agreement effective windows must not overlap (one version per as-of instant).';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_commercial_agreement_window_overlap_trigger
        BEFORE INSERT OR UPDATE ON handyman_commercial_agreement_versions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_commercial_agreement_window_overlap();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_commercial_agreement_root_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman commercial agreements are never deleted.';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.client_id IS DISTINCT FROM OLD.client_id
        OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'Handyman commercial agreement identity is immutable.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_commercial_agreement_version_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman commercial agreement versions are never deleted.';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id
        OR NEW.version_number IS DISTINCT FROM OLD.version_number
        OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION
            'Handyman commercial agreement version facts are immutable.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_commercial_agreement_root_no_write
        BEFORE UPDATE OR DELETE ON handyman_commercial_agreements
        FOR EACH ROW
        EXECUTE FUNCTION handyman_commercial_agreement_root_block_mutation();
      CREATE TRIGGER handyman_commercial_agreement_version_no_write
        BEFORE UPDATE OR DELETE ON handyman_commercial_agreement_versions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_commercial_agreement_version_block_mutation();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_commercial_agreement_event_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman commercial agreement events cannot be updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_commercial_agreement_events_no_write
        BEFORE UPDATE OR DELETE ON handyman_commercial_agreement_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_commercial_agreement_event_no_write();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_commercial_agreement_events_no_write
        ON handyman_commercial_agreement_events;
      DROP TRIGGER IF EXISTS handyman_commercial_agreement_events_parent_check
        ON handyman_commercial_agreement_events;
      DROP TRIGGER IF EXISTS handyman_commercial_agreement_version_no_write
        ON handyman_commercial_agreement_versions;
      DROP TRIGGER IF EXISTS handyman_commercial_agreement_root_no_write
        ON handyman_commercial_agreements;
      DROP TRIGGER IF EXISTS
        handyman_commercial_agreement_window_overlap_trigger
        ON handyman_commercial_agreement_versions;
      DROP FUNCTION IF EXISTS handyman_commercial_agreement_event_no_write;
      DROP FUNCTION IF EXISTS handyman_commercial_agreement_version_block_mutation;
      DROP FUNCTION IF EXISTS handyman_commercial_agreement_root_block_mutation;
      DROP FUNCTION IF EXISTS handyman_commercial_agreement_window_overlap;
      DROP FUNCTION IF EXISTS handyman_commercial_agreement_event_consistency;
      DROP TABLE IF EXISTS handyman_commercial_agreement_events;
      DROP TABLE IF EXISTS handyman_commercial_agreement_versions;
      DROP TABLE IF EXISTS handyman_commercial_agreements;
    `);
  },
};
