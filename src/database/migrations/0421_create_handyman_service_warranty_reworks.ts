import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-15 PART 03 — FREE WARRANTY REWORK LIFECYCLE ONLY (FROZEN
 * governance `CR-HM-15_START_GOVERNANCE.md` §4/§5/§6/§7/§8, §8 row 03).
 *
 * TWO tables, both inside CR-HM-15's warranty boundary:
 *
 * 1. `handyman_service_warranty_reworks` — the free rework record:
 *      REWORK_DRAFT --ACCEPT--> REWORK_AUTHORIZED --START-->
 *      REWORK_IN_PROGRESS --COMPLETE--> REWORK_COMPLETE --VERIFY-->
 *      REWORK_VERIFIED
 *    Free rework exists ONLY for an APPROVED claim, and at most ONE free
 *    rework exists per claim (UNIQUE claim_id). There is NO chargeable
 *    state here: chargeable additional work is a SEPARATE PART (PART 04)
 *    and the two can never be collapsed into one record (§7 / B8).
 *
 * 2. `handyman_service_warranty_rework_events` — append-only lifecycle
 *    evidence with single-use idempotency
 *    (`UNIQUE (rework_id, event_type, idempotency_key)`).
 *
 * Binding law: the rework binds to the APPROVED CLAIM (FKs on
 * `(claim_id, client_id)`, `(claim_id, warranty_id)`,
 * `(claim_id, execution_scope_id)`, `(claim_id, bast_id)` — the claim's
 * own unique anchors), and through it to the SERVICE WARRANTY and its
 * ORIGINAL execution scope / BAST (`(warranty_id, client_id)`,
 * `(warranty_id, bast_id)`). Client, scope and BAST are read FROM the
 * claim row: a caller never supplies identity, and a cross-claim /
 * cross-scope / cross-warranty rework is structurally impossible.
 *
 * Head law (§5): the warranty head remains the single authoritative
 * warranty status, and the rework path moves it only within the frozen
 * vocabulary —
 *      CLAIM_APPROVED --START--> REWORK_IN_PROGRESS --COMPLETE-->
 *      REWORK_COMPLETE
 * (proposal and authorization leave the head at CLAIM_APPROVED; the
 * verification pass closes the CLAIM on the rework record and does not
 * invent a head state the frozen vocabulary does not have). Both
 * directions are enforced: a head can never claim REWORK_* without the
 * matching rework fact, and a rework in execution can never exist
 * without the matching head fact.
 *
 * READ-ONLY reuse of CR-HM-10 authority (§6 seam 2): verification binds
 * an evidence record of the SAME client and ORIGINAL execution scope, and
 * may consume a QC run of that scope that already PASSED — both are
 * read-only references; this migration never writes
 * `handyman_evidence_records`, `handyman_qc_runs` or any other CR-HM-10
 * table, and no ownership transfers.
 *
 * History law (§4/§7): the rework identity facts are frozen forever, the
 * ONLY lawful mutations are the bounded transitions above, DELETE is
 * refused, and the ORIGINAL BAST, the warranty start boundary and the
 * whole service history are never written here.
 *
 * ZERO chargeable additional-work financial execution (PART 04), ZERO
 * pricing/payment/settlement/ledger/entitlement, ZERO FM asset warranty,
 * ZERO SaaS, ZERO HTTP/OpenAPI.
 */
export const migration0421CreateHandymanServiceWarrantyReworks: Migration = {
  id: '0421_create_handyman_service_warranty_reworks',
  async up(client: PoolClient): Promise<void> {
    // ---- REWORK record (free warranty rework only) ---------------
    await client.query(`
      CREATE TABLE handyman_service_warranty_reworks (
        id                            UUID PRIMARY KEY,
        client_id                     UUID NOT NULL
          REFERENCES clients (id),
        warranty_id                   UUID NOT NULL,
        claim_id                      UUID NOT NULL,
        execution_scope_id            UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        bast_id                       UUID NOT NULL
          REFERENCES handyman_bast_documents (id),
        status                        TEXT NOT NULL DEFAULT 'REWORK_DRAFT',
        scope_note                    TEXT NOT NULL DEFAULT '',
        proposed_by_user_id           UUID NOT NULL
          REFERENCES users (id),
        proposed_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        authorized_at                 TIMESTAMPTZ,
        authorized_by_user_id         UUID
          REFERENCES users (id),
        started_at                    TIMESTAMPTZ,
        completed_at                  TIMESTAMPTZ,
        completion_note               TEXT,
        verified_at                   TIMESTAMPTZ,
        verified_by_user_id           UUID
          REFERENCES users (id),
        verification_evidence_record_id UUID
          REFERENCES handyman_evidence_records (id),
        verification_qc_run_id        UUID
          REFERENCES handyman_qc_runs (id),
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_warranty_rework_claim_client_fk
          FOREIGN KEY (claim_id, client_id)
            REFERENCES handyman_service_warranty_claims (id, client_id),
        CONSTRAINT handyman_service_warranty_rework_claim_warranty_fk
          FOREIGN KEY (claim_id, warranty_id)
            REFERENCES handyman_service_warranty_claims (id, warranty_id),
        CONSTRAINT handyman_service_warranty_rework_claim_scope_fk
          FOREIGN KEY (claim_id, execution_scope_id)
            REFERENCES handyman_service_warranty_claims
              (id, execution_scope_id),
        CONSTRAINT handyman_service_warranty_rework_claim_bast_fk
          FOREIGN KEY (claim_id, bast_id)
            REFERENCES handyman_service_warranty_claims (id, bast_id),
        CONSTRAINT handyman_service_warranty_rework_warranty_client_fk
          FOREIGN KEY (warranty_id, client_id)
            REFERENCES handyman_service_warranties (id, client_id),
        CONSTRAINT handyman_service_warranty_rework_warranty_bast_fk
          FOREIGN KEY (warranty_id, bast_id)
            REFERENCES handyman_service_warranties (id, bast_id),
        CONSTRAINT handyman_service_warranty_rework_status_check
          CHECK (status IN (
            'REWORK_DRAFT', 'REWORK_AUTHORIZED', 'REWORK_IN_PROGRESS',
            'REWORK_COMPLETE', 'REWORK_VERIFIED')),
        CONSTRAINT handyman_service_warranty_rework_scope_note_check
          CHECK (char_length(scope_note) <= 2000),
        CONSTRAINT handyman_service_warranty_rework_completion_note_check
          CHECK (completion_note IS NULL
            OR (status IN ('REWORK_COMPLETE', 'REWORK_VERIFIED')
              AND char_length(btrim(completion_note)) BETWEEN 1 AND 2000)),
        -- The authored status can never contradict its own facts.
        CONSTRAINT handyman_service_warranty_rework_state_check
          CHECK (
            (status = 'REWORK_DRAFT'
              AND authorized_at IS NULL AND authorized_by_user_id IS NULL
              AND started_at IS NULL AND completed_at IS NULL
              AND verified_at IS NULL AND verified_by_user_id IS NULL
              AND verification_evidence_record_id IS NULL
              AND verification_qc_run_id IS NULL)
            OR (status = 'REWORK_AUTHORIZED'
              AND authorized_at IS NOT NULL
              AND authorized_by_user_id IS NOT NULL
              AND started_at IS NULL AND completed_at IS NULL
              AND verified_at IS NULL AND verified_by_user_id IS NULL
              AND verification_evidence_record_id IS NULL
              AND verification_qc_run_id IS NULL)
            OR (status = 'REWORK_IN_PROGRESS'
              AND authorized_at IS NOT NULL
              AND authorized_by_user_id IS NOT NULL
              AND started_at IS NOT NULL AND completed_at IS NULL
              AND verified_at IS NULL AND verified_by_user_id IS NULL
              AND verification_evidence_record_id IS NULL
              AND verification_qc_run_id IS NULL)
            OR (status = 'REWORK_COMPLETE'
              AND authorized_at IS NOT NULL
              AND authorized_by_user_id IS NOT NULL
              AND started_at IS NOT NULL AND completed_at IS NOT NULL
              AND verified_at IS NULL AND verified_by_user_id IS NULL
              AND verification_evidence_record_id IS NULL
              AND verification_qc_run_id IS NULL)
            OR (status = 'REWORK_VERIFIED'
              AND authorized_at IS NOT NULL
              AND authorized_by_user_id IS NOT NULL
              AND started_at IS NOT NULL AND completed_at IS NOT NULL
              AND verified_at IS NOT NULL
              AND verified_by_user_id IS NOT NULL
              AND verification_evidence_record_id IS NOT NULL)),
        CONSTRAINT handyman_service_warranty_rework_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_warranty_rework_id_claim_unique
          UNIQUE (id, claim_id),
        CONSTRAINT handyman_service_warranty_rework_id_scope_unique
          UNIQUE (id, execution_scope_id),
        CONSTRAINT handyman_service_warranty_rework_id_bast_unique
          UNIQUE (id, bast_id),
        CONSTRAINT handyman_service_warranty_rework_id_warranty_unique
          UNIQUE (id, warranty_id),
        -- ONE free rework per approved claim (fail-closed).
        CONSTRAINT handyman_service_warranty_rework_claim_unique
          UNIQUE (claim_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_service_warranty_reworks_warranty_idx
        ON handyman_service_warranty_reworks
          (warranty_id, created_at, id)
    `);
    await client.query(`
      CREATE INDEX handyman_service_warranty_reworks_scope_idx
        ON handyman_service_warranty_reworks
          (execution_scope_id, status, created_at)
    `);

    // ---- REWORK event stream (append-only) -----------------------
    await client.query(`
      CREATE TABLE handyman_service_warranty_rework_events (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        rework_id          UUID NOT NULL,
        claim_id           UUID NOT NULL,
        warranty_id        UUID NOT NULL,
        execution_scope_id UUID NOT NULL,
        bast_id            UUID NOT NULL,
        event_type         TEXT NOT NULL,
        idempotency_key    TEXT NOT NULL,
        actor_user_id      UUID NOT NULL
          REFERENCES users (id),
        occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_warranty_rework_event_rework_client_fk
          FOREIGN KEY (rework_id, client_id)
            REFERENCES handyman_service_warranty_reworks (id, client_id),
        CONSTRAINT handyman_service_warranty_rework_event_rework_claim_fk
          FOREIGN KEY (rework_id, claim_id)
            REFERENCES handyman_service_warranty_reworks (id, claim_id),
        CONSTRAINT handyman_service_warranty_rework_event_rework_bast_fk
          FOREIGN KEY (rework_id, bast_id)
            REFERENCES handyman_service_warranty_reworks (id, bast_id),
        CONSTRAINT handyman_service_warranty_rework_event_rework_scope_fk
          FOREIGN KEY (rework_id, execution_scope_id)
            REFERENCES handyman_service_warranty_reworks
              (id, execution_scope_id),
        CONSTRAINT handyman_service_warranty_rework_event_rework_warranty_fk
          FOREIGN KEY (rework_id, warranty_id)
            REFERENCES handyman_service_warranty_reworks (id, warranty_id),
        CONSTRAINT handyman_service_warranty_rework_event_type_check
          CHECK (event_type IN (
            'PROPOSE', 'ACCEPT', 'START', 'COMPLETE', 'VERIFY')),
        CONSTRAINT handyman_service_warranty_rework_event_key_check
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_service_warranty_rework_events_idem_idx
        ON handyman_service_warranty_rework_events
          (rework_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_service_warranty_rework_events_rework_idx
        ON handyman_service_warranty_rework_events
          (rework_id, occurred_at, id)
    `);

    // ---- Rework entry gate + frozen identity + bounded ladder ----
    // A rework is PROPOSED as REWORK_DRAFT for an APPROVED claim on an
    // approved warranty or not at all. Identity is frozen forever, the
    // ladder only moves forward, terminal states never move, and DELETE
    // is refused.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_rework_guard_mutation()
      RETURNS trigger AS $$
      DECLARE
        parent_claim_status     TEXT;
        parent_warranty_status  TEXT;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman service warranty reworks are never deleted: warranty history is preserved.';
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF NEW.status IS DISTINCT FROM 'REWORK_DRAFT'
             OR NEW.authorized_at IS NOT NULL
             OR NEW.authorized_by_user_id IS NOT NULL
             OR NEW.started_at IS NOT NULL
             OR NEW.completed_at IS NOT NULL
             OR NEW.completion_note IS NOT NULL
             OR NEW.verified_at IS NOT NULL
             OR NEW.verified_by_user_id IS NOT NULL
             OR NEW.verification_evidence_record_id IS NOT NULL
             OR NEW.verification_qc_run_id IS NOT NULL
          THEN
            RAISE EXCEPTION
              'Handyman service warranty reworks enter as REWORK_DRAFT: only the state-gated rework path may authorize, execute, complete or verify them.';
          END IF;
          SELECT status INTO parent_claim_status
            FROM handyman_service_warranty_claims
            WHERE id = NEW.claim_id;
          IF parent_claim_status IS DISTINCT FROM 'CLAIM_APPROVED' THEN
            RAISE EXCEPTION
              'Free Handyman service warranty rework exists ONLY for an APPROVED claim.';
          END IF;
          SELECT status INTO parent_warranty_status
            FROM handyman_service_warranties
            WHERE id = NEW.warranty_id;
          IF parent_warranty_status IS DISTINCT FROM 'CLAIM_APPROVED' THEN
            RAISE EXCEPTION
              'Free Handyman service warranty rework requires the warranty head to be CLAIM_APPROVED.';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM OLD.client_id
           OR NEW.warranty_id IS DISTINCT FROM OLD.warranty_id
           OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
           OR NEW.execution_scope_id IS DISTINCT FROM OLD.execution_scope_id
           OR NEW.bast_id IS DISTINCT FROM OLD.bast_id
           OR NEW.proposed_by_user_id IS DISTINCT FROM OLD.proposed_by_user_id
           OR NEW.scope_note IS DISTINCT FROM OLD.scope_note
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION
            'Handyman service warranty rework identity facts are immutable once proposed.';
        END IF;
        IF OLD.status = 'REWORK_DRAFT' THEN
          IF NEW.status NOT IN ('REWORK_DRAFT', 'REWORK_AUTHORIZED') THEN
            RAISE EXCEPTION
              'Illegal Handyman service warranty rework transition (frozen state machine).';
          END IF;
          RETURN NEW;
        END IF;
        IF OLD.status = 'REWORK_AUTHORIZED' THEN
          IF NEW.status NOT IN ('REWORK_AUTHORIZED', 'REWORK_IN_PROGRESS')
          THEN
            RAISE EXCEPTION
              'Illegal Handyman service warranty rework transition (frozen state machine).';
          END IF;
          RETURN NEW;
        END IF;
        IF OLD.status = 'REWORK_IN_PROGRESS' THEN
          IF NEW.status NOT IN ('REWORK_IN_PROGRESS', 'REWORK_COMPLETE') THEN
            RAISE EXCEPTION
              'Illegal Handyman service warranty rework transition (frozen state machine).';
          END IF;
          RETURN NEW;
        END IF;
        IF OLD.status = 'REWORK_COMPLETE' THEN
          IF NEW.status NOT IN ('REWORK_COMPLETE', 'REWORK_VERIFIED') THEN
            RAISE EXCEPTION
              'Illegal Handyman service warranty rework transition (frozen state machine).';
          END IF;
          RETURN NEW;
        END IF;
        RAISE EXCEPTION
          'Handyman service warranty rework is already verified: the free rework is closed (one authoritative transition per rework).';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_service_warranty_rework_guard
        BEFORE INSERT OR UPDATE OR DELETE
        ON handyman_service_warranty_reworks
        FOR EACH ROW
        EXECUTE FUNCTION handyman_service_warranty_rework_guard_mutation();
    `);

    // ---- READ-ONLY CR-HM-10 reuse at verification ----------------
    // The verification evidence must be the claim's OWN evidence: same
    // client and ORIGINAL execution scope. A consumed QC run must belong
    // to that same scope and must already have PASSED. Nothing is written
    // to the CR-HM-10 tables; these are read-only references.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_rework_verification_guard()
      RETURNS trigger AS $$
      DECLARE
        evidence_client UUID;
        evidence_scope  UUID;
        qc_client       UUID;
        qc_scope        UUID;
        qc_status       TEXT;
      BEGIN
        IF NEW.verification_evidence_record_id IS NOT NULL THEN
          SELECT client_id, execution_scope_id
            INTO evidence_client, evidence_scope
            FROM handyman_evidence_records
            WHERE id = NEW.verification_evidence_record_id;
          IF evidence_client IS NULL THEN
            RETURN NEW;
          END IF;
          IF NEW.client_id IS DISTINCT FROM evidence_client
             OR NEW.execution_scope_id IS DISTINCT FROM evidence_scope THEN
            RAISE EXCEPTION
              'Handyman service warranty rework verification evidence must belong to the same client and ORIGINAL execution scope as the rework.';
          END IF;
        END IF;
        IF NEW.verification_qc_run_id IS NOT NULL THEN
          SELECT client_id, execution_scope_id, status
            INTO qc_client, qc_scope, qc_status
            FROM handyman_qc_runs
            WHERE id = NEW.verification_qc_run_id;
          IF qc_client IS NULL THEN
            RETURN NEW;
          END IF;
          IF NEW.client_id IS DISTINCT FROM qc_client
             OR NEW.execution_scope_id IS DISTINCT FROM qc_scope THEN
            RAISE EXCEPTION
              'Handyman service warranty rework verification QC run must belong to the same client and ORIGINAL execution scope as the rework.';
          END IF;
          IF qc_status IS DISTINCT FROM 'PASSED' THEN
            RAISE EXCEPTION
              'Handyman service warranty rework verification may only consume a PASSED QC run (QC authority is read-only here).';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_service_warranty_rework_verification_check
        BEFORE INSERT OR UPDATE ON handyman_service_warranty_reworks
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_service_warranty_rework_verification_guard();
    `);

    // ---- Head mirror law (both directions) -----------------------
    // A warranty head can never claim a rework state without the matching
    // rework fact …
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_rework_head_mirror_required()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'REWORK_IN_PROGRESS' THEN
          IF NOT EXISTS (
            SELECT 1 FROM handyman_service_warranty_reworks
            WHERE warranty_id = NEW.id AND status = 'REWORK_IN_PROGRESS'
          ) THEN
            RAISE EXCEPTION
              'Handyman service warranty status cannot contradict its rework facts: REWORK_IN_PROGRESS requires a rework in progress.';
          END IF;
          RETURN NULL;
        END IF;
        IF NEW.status = 'REWORK_COMPLETE' THEN
          IF NOT EXISTS (
            SELECT 1 FROM handyman_service_warranty_reworks
            WHERE warranty_id = NEW.id
              AND status IN ('REWORK_COMPLETE', 'REWORK_VERIFIED')
          ) THEN
            RAISE EXCEPTION
              'Handyman service warranty status cannot contradict its rework facts: REWORK_COMPLETE requires a completed free rework.';
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE CONSTRAINT TRIGGER
        handyman_service_warranty_rework_head_mirror
        AFTER INSERT OR UPDATE ON handyman_service_warranties
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_service_warranty_rework_head_mirror_required();
    `);
    // … and a rework in execution can never exist without the matching
    // head fact.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_rework_requires_head_state()
      RETURNS trigger AS $$
      DECLARE
        parent_status TEXT;
      BEGIN
        IF NEW.status NOT IN (
          'REWORK_IN_PROGRESS', 'REWORK_COMPLETE', 'REWORK_VERIFIED'
        ) THEN
          RETURN NULL;
        END IF;
        SELECT status INTO parent_status
          FROM handyman_service_warranties
          WHERE id = NEW.warranty_id;
        IF parent_status IS NULL THEN
          RETURN NULL;
        END IF;
        IF parent_status NOT IN ('REWORK_IN_PROGRESS', 'REWORK_COMPLETE')
        THEN
          RAISE EXCEPTION
            'Handyman service warranty rework execution requires the matching warranty head state.';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE CONSTRAINT TRIGGER handyman_service_warranty_rework_head_required
        AFTER INSERT OR UPDATE ON handyman_service_warranty_reworks
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_service_warranty_rework_requires_head_state();
    `);

    // ---- Events are append-only ----------------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_rework_event_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman service warranty rework events are append-only: never updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_service_warranty_rework_events_no_write
        BEFORE UPDATE OR DELETE ON handyman_service_warranty_rework_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_service_warranty_rework_event_no_write();
    `);

    // ---- Every rework and every transition is event-backed -------
    // Deferred to COMMIT so each event may be written right after its
    // transition inside one transaction. A rework can never become
    // durable without PROPOSE evidence, and no authorized/started/
    // completed/verified rework can become durable without its matching
    // lifecycle event — a raw SQL workflow that skips the governed path
    // is structurally impossible.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_rework_require_event()
      RETURNS trigger AS $$
      DECLARE
        expected TEXT;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM handyman_service_warranty_rework_events
          WHERE rework_id = NEW.id AND event_type = 'PROPOSE'
        ) THEN
          RAISE EXCEPTION
            'Handyman service warranty reworks require lifecycle evidence: a rework can never exist without its PROPOSE event.';
        END IF;
        IF NEW.status = 'REWORK_DRAFT' THEN
          RETURN NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM handyman_service_warranty_rework_events
          WHERE rework_id = NEW.id AND event_type = 'ACCEPT'
        ) THEN
          RAISE EXCEPTION
            'Handyman service warranty reworks require authorization evidence: a rework can never be authorized without its ACCEPT event.';
        END IF;
        IF NEW.status = 'REWORK_AUTHORIZED' THEN
          RETURN NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM handyman_service_warranty_rework_events
          WHERE rework_id = NEW.id AND event_type = 'START'
        ) THEN
          RAISE EXCEPTION
            'Handyman service warranty reworks require execution evidence: a rework can never start without its START event.';
        END IF;
        IF NEW.status = 'REWORK_IN_PROGRESS' THEN
          RETURN NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM handyman_service_warranty_rework_events
          WHERE rework_id = NEW.id AND event_type = 'COMPLETE'
        ) THEN
          RAISE EXCEPTION
            'Handyman service warranty reworks require completion evidence: a rework can never complete without its COMPLETE event.';
        END IF;
        IF NEW.status = 'REWORK_COMPLETE' THEN
          RETURN NULL;
        END IF;
        expected := 'VERIFY';
        IF NOT EXISTS (
          SELECT 1 FROM handyman_service_warranty_rework_events
          WHERE rework_id = NEW.id AND event_type = expected
        ) THEN
          RAISE EXCEPTION
            'Handyman service warranty reworks require verification evidence: a rework can never be verified without its VERIFY event.';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE CONSTRAINT TRIGGER handyman_service_warranty_rework_event_required
        AFTER INSERT OR UPDATE ON handyman_service_warranty_reworks
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION handyman_service_warranty_rework_require_event();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS
        handyman_service_warranty_rework_head_mirror
        ON handyman_service_warranties
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS
        handyman_service_warranty_rework_head_required
        ON handyman_service_warranty_reworks
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS
        handyman_service_warranty_rework_event_required
        ON handyman_service_warranty_reworks
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS
        handyman_service_warranty_rework_verification_check
        ON handyman_service_warranty_reworks
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_service_warranty_rework_guard
        ON handyman_service_warranty_reworks
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_service_warranty_rework_events_no_write
        ON handyman_service_warranty_rework_events
    `);
    for (const fn of [
      'handyman_service_warranty_rework_head_mirror_required',
      'handyman_service_warranty_rework_requires_head_state',
      'handyman_service_warranty_rework_require_event',
      'handyman_service_warranty_rework_event_no_write',
      'handyman_service_warranty_rework_verification_guard',
      'handyman_service_warranty_rework_guard_mutation',
    ]) {
      await client.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    await client.query(
      `DROP TABLE IF EXISTS handyman_service_warranty_rework_events`,
    );
    await client.query(
      `DROP TABLE IF EXISTS handyman_service_warranty_reworks`,
    );
  },
};
