import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-15 PART 01 — Service warranty FOUNDATION ONLY (FROZEN
 * governance `CR-HM-15_START_GOVERNANCE.md` §3/§4/§5/§5.1/§6/§7/§8,
 * §8 row 01).
 *
 * THREE tables: the authoritative service-warranty head (exactly ONE
 * per CR-HM-06 Execution Scope), its frozen coverage rows (workmanship
 * + material, never collapsed into one undifferentiated coverage), and
 * the append-only warranty event stream.
 *
 * ZERO claim intake (PART 02), ZERO rework (PART 03), ZERO chargeable
 * additional-work separation (PART 04), ZERO pricing/payment/ledger/
 * settlement, ZERO entitlement, ZERO HTTP/OpenAPI. ZERO FM/SaaS
 * coupling: no FK, no read, no write — `asset_warranties` (FM) is never
 * a Handyman service warranty.
 *
 * Invariants (DB-enforced):
 *   1. Warranty start ELIGIBILITY is the ACCEPTED BAST and nothing
 *      else: the anchor trigger requires the referenced BAST row to be
 *      `ACCEPTED` with a recorded acceptance instant. Session COMPLETE
 *      / CHECK_OUT / quotation approval / QC PASS / FM warranty status
 *      are structurally incapable of starting a warranty here;
 *   2. The warranty start boundary IS the acceptance instant:
 *      `starts_at = bast_accepted_at` (CHECK + trigger), so no caller
 *      can author a start time;
 *   3. Exactly ONE warranty per execution scope and per BAST (UNIQUE);
 *   4. Status vocabulary is the full FROZEN set. PART 01 writes ONLY
 *      `ACTIVE` (start) and `EXPIRED` (explicit expiry fact); the
 *      claim/rework values stay reserved for PART 02+ exactly as
 *      CR-HM-11 PART 01 reserved ACCEPT/REJECT;
 *   5. BOTH coverages (WORKMANSHIP + MATERIAL) are required: a deferred
 *      constraint trigger refuses at COMMIT any warranty that is not
 *      accompanied by exactly its two coverage rows;
 *   6. The head is a guarded status projection: identity (client /
 *      scope / BAST / acceptance instant / start boundary / starter)
 *      is immutable and the row can NEVER be deleted — the original
 *      BAST and service history are never touched or rewritten;
 *   7. Coverages and events are append-only (no UPDATE, no DELETE);
 *   8. Event stream is bounded to START / EXPIRE with single-use
 *      idempotency per warranty+type and parent consistency.
 */
export const migration0419CreateHandymanServiceWarranty: Migration = {
  id: '0419_create_handyman_service_warranty',
  async up(client: PoolClient): Promise<void> {
    // ---- WARRANTY head (one per Execution Scope) ------------------
    await client.query(`
      CREATE TABLE handyman_service_warranties (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        bast_id            UUID NOT NULL
          REFERENCES handyman_bast_documents (id),
        bast_accepted_at   TIMESTAMPTZ NOT NULL,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        starts_at          TIMESTAMPTZ NOT NULL,
        expired_at         TIMESTAMPTZ,
        started_by_user_id UUID NOT NULL
          REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_warranty_status_check
          CHECK (status IN (
            'INELIGIBLE', 'ACTIVE', 'CLAIM_OPEN', 'CLAIM_APPROVED',
            'CLAIM_REJECTED', 'REWORK_IN_PROGRESS', 'REWORK_COMPLETE',
            'EXPIRED')),
        CONSTRAINT handyman_service_warranty_start_boundary_check
          CHECK (starts_at = bast_accepted_at),
        CONSTRAINT handyman_service_warranty_expired_at_check
          CHECK (
            (status = 'EXPIRED' AND expired_at IS NOT NULL)
            OR (status <> 'EXPIRED' AND expired_at IS NULL)),
        CONSTRAINT handyman_service_warranty_scope_unique
          UNIQUE (execution_scope_id),
        CONSTRAINT handyman_service_warranty_bast_unique
          UNIQUE (bast_id),
        CONSTRAINT handyman_service_warranty_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_warranty_id_bast_unique
          UNIQUE (id, bast_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_service_warranties_client_idx
        ON handyman_service_warranties (client_id, status, created_at)
    `);

    // ---- COVERAGES (workmanship + material, never collapsed) -------
    await client.query(`
      CREATE TABLE handyman_service_warranty_coverages (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        warranty_id        UUID NOT NULL,
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        coverage_type      TEXT NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_warranty_coverage_warranty_fk
          FOREIGN KEY (warranty_id, client_id)
            REFERENCES handyman_service_warranties (id, client_id),
        CONSTRAINT handyman_service_warranty_coverage_type_check
          CHECK (coverage_type IN ('WORKMANSHIP', 'MATERIAL')),
        CONSTRAINT handyman_service_warranty_coverage_unique
          UNIQUE (warranty_id, coverage_type)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_service_warranty_coverages_type_idx
        ON handyman_service_warranty_coverages
          (execution_scope_id, coverage_type)
    `);

    // ---- EVENTS (START / EXPIRE, append-only) ---------------------
    await client.query(`
      CREATE TABLE handyman_service_warranty_events (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        warranty_id        UUID NOT NULL,
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        bast_id            UUID NOT NULL
          REFERENCES handyman_bast_documents (id),
        event_type         TEXT NOT NULL,
        idempotency_key    TEXT NOT NULL,
        actor_user_id      UUID NOT NULL
          REFERENCES users (id),
        occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_warranty_event_warranty_fk
          FOREIGN KEY (warranty_id, client_id)
            REFERENCES handyman_service_warranties (id, client_id),
        CONSTRAINT handyman_service_warranty_event_bast_fk
          FOREIGN KEY (warranty_id, bast_id)
            REFERENCES handyman_service_warranties (id, bast_id),
        CONSTRAINT handyman_service_warranty_event_type_check
          CHECK (event_type IN ('START', 'EXPIRE')),
        CONSTRAINT handyman_service_warranty_event_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_service_warranty_events_idem_idx
        ON handyman_service_warranty_events
          (warranty_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_service_warranty_events_warranty_idx
        ON handyman_service_warranty_events (warranty_id, occurred_at)
    `);

    // ---- Eligibility law: only an ACCEPTED BAST starts warranty ----
    // COMPLETE / CHECK_OUT / quotation approval / QC PASS / FM warranty
    // status can never anchor a Handyman service warranty; the start
    // boundary must equal the recorded acceptance instant. Enforced on
    // INSERT: once created, the head's identity (BAST anchor and start
    // boundary included) is immutable by the identity guard below.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_bast_anchor_guard()
      RETURNS trigger AS $$
      DECLARE
        bast_status   TEXT;
        bast_client   UUID;
        bast_scope    UUID;
        bast_accepted TIMESTAMPTZ;
      BEGIN
        SELECT status, client_id, execution_scope_id, accepted_at
          INTO bast_status, bast_client, bast_scope, bast_accepted
          FROM handyman_bast_documents
          WHERE id = NEW.bast_id;
        IF bast_status IS NULL THEN
          RETURN NEW;
        END IF;
        IF bast_status <> 'ACCEPTED' THEN
          RAISE EXCEPTION
            'Handyman service warranty requires an ACCEPTED BAST; session COMPLETE, CHECK_OUT, quotation approval and QC PASS never start warranty.';
        END IF;
        IF bast_accepted IS NULL THEN
          RAISE EXCEPTION
            'Handyman service warranty requires the recorded BAST acceptance instant.';
        END IF;
        IF NEW.client_id IS DISTINCT FROM bast_client
           OR NEW.execution_scope_id IS DISTINCT FROM bast_scope
           OR NEW.bast_accepted_at IS DISTINCT FROM bast_accepted
           OR NEW.starts_at IS DISTINCT FROM bast_accepted THEN
          RAISE EXCEPTION
            'Handyman service warranty start boundary must be the accepted BAST instant for its own client and execution scope.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_service_warranty_bast_anchor_check
        BEFORE INSERT ON handyman_service_warranties
        FOR EACH ROW
        EXECUTE FUNCTION handyman_service_warranty_bast_anchor_guard();
    `);

    // ---- Both coverages are mandatory (deferred to COMMIT) ---------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_require_coverages()
      RETURNS trigger AS $$
      DECLARE
        coverage_count INT;
      BEGIN
        SELECT count(*) INTO coverage_count
          FROM handyman_service_warranty_coverages
          WHERE warranty_id = NEW.id;
        IF coverage_count <> 2 THEN
          RAISE EXCEPTION
            'Handyman service warranty requires BOTH workmanship and material coverage.';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE CONSTRAINT TRIGGER handyman_service_warranty_coverage_required
        AFTER INSERT ON handyman_service_warranties
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION handyman_service_warranty_require_coverages();
    `);

    // ---- Coverage / event parent consistency ----------------------
    // The event's BAST anchor is FK-bound to the parent warranty's own
    // BAST anchor, so an event can never point at another BAST.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_parent_consistency()
      RETURNS trigger AS $$
      DECLARE
        parent_client UUID;
        parent_scope  UUID;
      BEGIN
        SELECT client_id, execution_scope_id
          INTO parent_client, parent_scope
          FROM handyman_service_warranties
          WHERE id = NEW.warranty_id;
        IF parent_client IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM parent_client
           OR NEW.execution_scope_id IS DISTINCT FROM parent_scope THEN
          RAISE EXCEPTION
            'Handyman service warranty child row must match parent warranty client and execution scope.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of [
      'handyman_service_warranty_coverages',
      'handyman_service_warranty_events',
    ]) {
      await client.query(`
        CREATE TRIGGER ${table}_parent_check
          BEFORE INSERT OR UPDATE ON ${table}
          FOR EACH ROW
          EXECUTE FUNCTION handyman_service_warranty_parent_consistency();
      `);
    }

    // ---- Head identity guard (no delete, no identity rewrite) ------
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_service_warranty_head_guard()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman service warranty cannot be deleted; the accepted BAST and service history are preserved.';
        END IF;
        IF NEW.client_id IS DISTINCT FROM OLD.client_id
           OR NEW.execution_scope_id IS DISTINCT FROM OLD.execution_scope_id
           OR NEW.bast_id IS DISTINCT FROM OLD.bast_id
           OR NEW.bast_accepted_at IS DISTINCT FROM OLD.bast_accepted_at
           OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
           OR NEW.started_by_user_id IS DISTINCT FROM OLD.started_by_user_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION
            'Handyman service warranty identity (client/scope/BAST/start boundary) is immutable.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_service_warranty_identity_guard
        BEFORE UPDATE OR DELETE ON handyman_service_warranties
        FOR EACH ROW
        EXECUTE FUNCTION handyman_service_warranty_head_guard();
    `);

    // ---- Append-only coverages + events ---------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_service_warranty_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman service warranty % rows are append-only.',
          TG_TABLE_NAME;
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of [
      'handyman_service_warranty_coverages',
      'handyman_service_warranty_events',
    ]) {
      await client.query(`
        CREATE TRIGGER ${table}_no_write
          BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW
          EXECUTE FUNCTION handyman_service_warranty_no_write();
      `);
    }
  },

  async down(client: PoolClient): Promise<void> {
    for (const table of [
      'handyman_service_warranty_coverages',
      'handyman_service_warranty_events',
      'handyman_service_warranties',
    ]) {
      await client.query(`DROP TRIGGER IF EXISTS ${table}_no_write ON ${table}`);
      await client.query(
        `DROP TRIGGER IF EXISTS ${table}_parent_check ON ${table}`,
      );
    }
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_service_warranty_identity_guard
        ON handyman_service_warranties
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_service_warranty_bast_anchor_check
        ON handyman_service_warranties
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_service_warranty_coverage_required
        ON handyman_service_warranties
    `);
    await client.query(
      `DROP FUNCTION IF EXISTS handyman_service_warranty_no_write()`,
    );
    await client.query(
      `DROP FUNCTION IF EXISTS handyman_service_warranty_parent_consistency()`,
    );
    await client.query(
      `DROP FUNCTION IF EXISTS handyman_service_warranty_head_guard()`,
    );
    await client.query(
      `DROP FUNCTION IF EXISTS
        handyman_service_warranty_require_coverages()`,
    );
    await client.query(
      `DROP FUNCTION IF EXISTS
        handyman_service_warranty_bast_anchor_guard()`,
    );
    await client.query(
      `DROP TABLE IF EXISTS handyman_service_warranty_coverages`,
    );
    await client.query(
      `DROP TABLE IF EXISTS handyman_service_warranty_events`,
    );
    await client.query(`DROP TABLE IF EXISTS handyman_service_warranties`);
  },
};
