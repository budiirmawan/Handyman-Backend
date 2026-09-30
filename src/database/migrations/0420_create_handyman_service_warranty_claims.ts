import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-15 PART 02 — WARRANTY CLAIM INTAKE ONLY (FROZEN governance
 * `CR-HM-15_START_GOVERNANCE.md` §4/§5/§6/§7/§8, §8 row 02).
 *
 * TWO tables, both inside CR-HM-15's warranty boundary:
 *
 * 1. `handyman_service_warranty_claims` — the claim record. A claim is
 *    opened as `CLAIM_DRAFT`, becomes `CLAIM_SUBMITTED` only through the
 *    state-gated submit path, and then reaches exactly ONE decision
 *    (`CLAIM_APPROVED` / `CLAIM_REJECTED` / `CLAIM_WITHDRAWN`). The
 *    claimant is the recorded authenticated submitter — never a
 *    caller-supplied identity (§4).
 *
 * 2. `handyman_service_warranty_claim_events` — append-only lifecycle
 *    evidence with single-use idempotency
 *    (`UNIQUE (claim_id, event_type, idempotency_key)`).
 *
 * Binding law (the user-visible requirement that a claim binds to an
 * EXISTING service warranty and its ORIGINAL scope):
 *   - `(warranty_id, client_id)` and `(warranty_id, bast_id)` are
 *     FK-bound to the parent warranty's own anchors, and the event rows
 *     are FK-bound to the claim's own client / warranty / scope / BAST —
 *     cross-scope and cross-warranty binding is structurally impossible;
 *   - the claim may only be opened while the parent warranty is ACTIVE,
 *     and at most ONE non-terminal claim (DRAFT/SUBMITTED) may exist per
 *     warranty;
 *   - bound evidence must belong to the SAME client and ORIGINAL
 *     execution scope as the claim.
 *
 * Warranty state law (§5): the warranty head is the single authoritative
 * status. A deferred constraint trigger refuses at COMMIT any head that
 * claims CLAIM_OPEN / CLAIM_APPROVED / CLAIM_REJECTED without the
 * matching claim fact — an authored status can never contradict the
 * claim record, and a raw-SQL status forgery is structurally impossible.
 *
 * Immutability law (§4/§5/§7): claim identity facts (client, warranty,
 * scope, BAST, opener, note, created_at) are frozen forever; the ONLY
 * lawful mutations are the bounded lifecycle transitions above; DELETE is
 * refused for the claim row and UPDATE/DELETE for every event. The
 * original BAST, session, QC, evidence and quotation history is READ-ONLY
 * here: nothing in this migration writes those tables.
 *
 * ZERO rework execution (PART 03), ZERO chargeable additional-work
 * separation (PART 04), ZERO pricing/payment/settlement/ledger/
 * entitlement, ZERO FM asset warranty, ZERO SaaS, ZERO HTTP/OpenAPI.
 */
export const migration0420CreateHandymanServiceWarrantyClaims: Migration = {
  id: '0420_create_handyman_service_warranty_claims',
  async up(client: PoolClient): Promise<void> {
    // ---- CLAIM record --------------------------------------------
    await client.query(`
      CREATE TABLE handyman_service_warranty_claims (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        warranty_id        UUID NOT NULL,
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        bast_id            UUID NOT NULL
          REFERENCES handyman_bast_documents (id),
        status             TEXT NOT NULL DEFAULT 'CLAIM_DRAFT',
        claim_note         TEXT NOT NULL DEFAULT '',
        evidence_record_id UUID
          REFERENCES handyman_evidence_records (id),
        opened_by_user_id  UUID NOT NULL
          REFERENCES users (id),
        submitted_at       TIMESTAMPTZ,
        claimant_user_id   UUID
          REFERENCES users (id),
        decided_at         TIMESTAMPTZ,
        decided_by_user_id UUID
          REFERENCES users (id),
        decision_note      TEXT,
        withdrawn_at       TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_warranty_claim_warranty_client_fk
          FOREIGN KEY (warranty_id, client_id)
            REFERENCES handyman_service_warranties (id, client_id),
        CONSTRAINT handyman_service_warranty_claim_warranty_bast_fk
          FOREIGN KEY (warranty_id, bast_id)
            REFERENCES handyman_service_warranties (id, bast_id),
        CONSTRAINT handyman_service_warranty_claim_status_check
          CHECK (status IN (
            'CLAIM_DRAFT', 'CLAIM_SUBMITTED', 'CLAIM_APPROVED',
            'CLAIM_REJECTED', 'CLAIM_WITHDRAWN')),
        CONSTRAINT handyman_service_warranty_claim_note_check
          CHECK (char_length(claim_note) <= 2000),
        CONSTRAINT handyman_service_warranty_claim_submit_check
          CHECK (
            (status = 'CLAIM_DRAFT'
              AND submitted_at IS NULL
              AND claimant_user_id IS NULL)
            OR (status <> 'CLAIM_DRAFT'
              AND submitted_at IS NOT NULL
              AND claimant_user_id IS NOT NULL)),
        CONSTRAINT handyman_service_warranty_claim_decision_check
          CHECK (
            (status IN ('CLAIM_APPROVED', 'CLAIM_REJECTED')
              AND decided_at IS NOT NULL
              AND decided_by_user_id IS NOT NULL)
            OR (status NOT IN ('CLAIM_APPROVED', 'CLAIM_REJECTED')
              AND decided_at IS NULL
              AND decided_by_user_id IS NULL)),
        CONSTRAINT handyman_service_warranty_claim_decision_note_check
          CHECK (
            decision_note IS NULL
            OR (status IN ('CLAIM_APPROVED', 'CLAIM_REJECTED')
              AND char_length(btrim(decision_note)) BETWEEN 1 AND 2000)),
        CONSTRAINT handyman_service_warranty_claim_withdrawn_check
          CHECK (
            (status = 'CLAIM_WITHDRAWN' AND withdrawn_at IS NOT NULL)
            OR (status <> 'CLAIM_WITHDRAWN' AND withdrawn_at IS NULL)),
        CONSTRAINT handyman_service_warranty_claim_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_warranty_claim_id_warranty_unique
          UNIQUE (id, warranty_id),
        CONSTRAINT handyman_service_warranty_claim_id_scope_unique
          UNIQUE (id, execution_scope_id),
        CONSTRAINT handyman_service_warranty_claim_id_bast_unique
          UNIQUE (id, bast_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_service_warranty_claims_warranty_idx
        ON handyman_service_warranty_claims
          (warranty_id, created_at, id)
    `);
    await client.query(`
      CREATE INDEX handyman_service_warranty_claims_client_idx
        ON handyman_service_warranty_claims (client_id, status, created_at)
    `);
    // At most ONE non-terminal claim per warranty (fail-closed).
    await client.query(`
      CREATE UNIQUE INDEX handyman_service_warranty_claims_open_idx
        ON handyman_service_warranty_claims (warranty_id)
        WHERE status IN ('CLAIM_DRAFT', 'CLAIM_SUBMITTED')
    `);

    // ---- CLAIM event stream (append-only) ------------------------
    await client.query(`
      CREATE TABLE handyman_service_warranty_claim_events (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
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

        CONSTRAINT handyman_service_warranty_claim_event_claim_client_fk
          FOREIGN KEY (claim_id, client_id)
            REFERENCES handyman_service_warranty_claims (id, client_id),
        CONSTRAINT handyman_service_warranty_claim_event_claim_bast_fk
          FOREIGN KEY (claim_id, bast_id)
            REFERENCES handyman_service_warranty_claims (id, bast_id),
        CONSTRAINT handyman_service_warranty_claim_event_claim_scope_fk
          FOREIGN KEY (claim_id, execution_scope_id)
            REFERENCES handyman_service_warranty_claims (id, execution_scope_id),
        CONSTRAINT handyman_service_warranty_claim_event_claim_warranty_fk
          FOREIGN KEY (claim_id, warranty_id)
            REFERENCES handyman_service_warranty_claims (id, warranty_id),
        CONSTRAINT handyman_service_warranty_claim_event_type_check
          CHECK (event_type IN (
            'OPEN', 'SUBMIT', 'APPROVE', 'REJECT', 'WITHDRAW')),
        CONSTRAINT handyman_service_warranty_claim_event_key_check
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_service_warranty_claim_events_idem_idx
        ON handyman_service_warranty_claim_events
          (claim_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_service_warranty_claim_events_claim_idx
        ON handyman_service_warranty_claim_events
          (claim_id, occurred_at, id)
    `);

    // ---- Claim entry state + frozen identity facts ---------------
    // A claim is OPENED as CLAIM_DRAFT or not at all; its identity facts
    // are frozen forever; its ONLY lawful mutations are the bounded
    // lifecycle transitions (one authoritative transition per claim).
    // DELETE is refused: warranty history is preserved.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_claim_guard_mutation()
      RETURNS trigger AS $$
      DECLARE
        parent_status TEXT;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman service warranty claims are never deleted: warranty history is preserved.';
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF NEW.status IS DISTINCT FROM 'CLAIM_DRAFT'
             OR NEW.submitted_at IS NOT NULL
             OR NEW.claimant_user_id IS NOT NULL
             OR NEW.decided_at IS NOT NULL
             OR NEW.decided_by_user_id IS NOT NULL
             OR NEW.decision_note IS NOT NULL
             OR NEW.withdrawn_at IS NOT NULL
          THEN
            RAISE EXCEPTION
              'Handyman service warranty claims enter as CLAIM_DRAFT: only the state-gated claim path may submit or decide them.';
          END IF;
          SELECT status INTO parent_status
            FROM handyman_service_warranties
            WHERE id = NEW.warranty_id;
          IF parent_status IS DISTINCT FROM 'ACTIVE' THEN
            RAISE EXCEPTION
              'Handyman service warranty claims may only be opened on an ACTIVE warranty.';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM OLD.client_id
           OR NEW.warranty_id IS DISTINCT FROM OLD.warranty_id
           OR NEW.execution_scope_id IS DISTINCT FROM OLD.execution_scope_id
           OR NEW.bast_id IS DISTINCT FROM OLD.bast_id
           OR NEW.opened_by_user_id IS DISTINCT FROM OLD.opened_by_user_id
           OR NEW.claim_note IS DISTINCT FROM OLD.claim_note
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION
            'Handyman service warranty claim identity facts are immutable once opened.';
        END IF;
        -- Evidence may only be bound while the claim is still a DRAFT.
        IF OLD.status <> 'CLAIM_DRAFT'
           AND NEW.evidence_record_id IS DISTINCT FROM OLD.evidence_record_id
        THEN
          RAISE EXCEPTION
            'Handyman service warranty claim evidence is frozen once the claim is submitted.';
        END IF;
        IF OLD.status = 'CLAIM_DRAFT' THEN
          IF NEW.status NOT IN ('CLAIM_DRAFT', 'CLAIM_SUBMITTED') THEN
            RAISE EXCEPTION
              'Illegal Handyman service warranty claim transition (frozen state machine).';
          END IF;
          RETURN NEW;
        END IF;
        IF OLD.status <> 'CLAIM_SUBMITTED' THEN
          RAISE EXCEPTION
            'Handyman service warranty claim is already terminal: a second decision is forbidden (one authoritative transition per claim).';
        END IF;
        IF NEW.status NOT IN (
          'CLAIM_APPROVED', 'CLAIM_REJECTED', 'CLAIM_WITHDRAWN'
        ) THEN
          RAISE EXCEPTION
            'Illegal Handyman service warranty claim transition (frozen state machine).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_service_warranty_claim_guard
        BEFORE INSERT OR UPDATE OR DELETE
        ON handyman_service_warranty_claims
        FOR EACH ROW
        EXECUTE FUNCTION handyman_service_warranty_claim_guard_mutation();
    `);

    // ---- Bound claim evidence must be the claim's own scope -------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_claim_evidence_guard()
      RETURNS trigger AS $$
      DECLARE
        evidence_client UUID;
        evidence_scope  UUID;
      BEGIN
        IF NEW.evidence_record_id IS NULL THEN
          RETURN NEW;
        END IF;
        SELECT client_id, execution_scope_id
          INTO evidence_client, evidence_scope
          FROM handyman_evidence_records
          WHERE id = NEW.evidence_record_id;
        IF evidence_client IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM evidence_client
           OR NEW.execution_scope_id IS DISTINCT FROM evidence_scope THEN
          RAISE EXCEPTION
            'Handyman service warranty claim evidence must belong to the same client and ORIGINAL execution scope as the claim.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_service_warranty_claim_evidence_check
        BEFORE INSERT OR UPDATE ON handyman_service_warranty_claims
        FOR EACH ROW
        EXECUTE FUNCTION handyman_service_warranty_claim_evidence_guard();
    `);

    // ---- Events are append-only ----------------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_claim_event_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman service warranty claim events are append-only: never updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_service_warranty_claim_events_no_write
        BEFORE UPDATE OR DELETE ON handyman_service_warranty_claim_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_service_warranty_claim_event_no_write();
    `);

    // ---- Every claim and every decision is event-backed ----------
    // Deferred to COMMIT so the event may be written right after the
    // claim inside one transaction. A claim can never become durable
    // without its OPEN evidence, and a submitted/decided claim can never
    // become durable without its matching lifecycle event — a raw SQL
    // workflow that skips the governed path is structurally impossible.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_claim_require_event()
      RETURNS trigger AS $$
      DECLARE
        expected TEXT;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM handyman_service_warranty_claim_events
          WHERE claim_id = NEW.id AND event_type = 'OPEN'
        ) THEN
          RAISE EXCEPTION
            'Handyman service warranty claims require intake evidence: a claim can never be opened without its OPEN event.';
        END IF;
        IF NEW.status = 'CLAIM_DRAFT' THEN
          RETURN NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM handyman_service_warranty_claim_events
          WHERE claim_id = NEW.id AND event_type = 'SUBMIT'
        ) THEN
          RAISE EXCEPTION
            'Handyman service warranty claims require submission evidence: a claim can never be submitted without its SUBMIT event.';
        END IF;
        IF NEW.status = 'CLAIM_SUBMITTED' THEN
          RETURN NULL;
        END IF;
        expected := CASE NEW.status
          WHEN 'CLAIM_APPROVED' THEN 'APPROVE'
          WHEN 'CLAIM_REJECTED' THEN 'REJECT'
          ELSE 'WITHDRAW'
        END;
        IF NOT EXISTS (
          SELECT 1 FROM handyman_service_warranty_claim_events
          WHERE claim_id = NEW.id AND event_type = expected
        ) THEN
          RAISE EXCEPTION
            'Handyman service warranty claim decisions require lifecycle evidence: a claim can never be decided without its matching decision event.';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE CONSTRAINT TRIGGER handyman_service_warranty_claim_event_required
        AFTER INSERT OR UPDATE ON handyman_service_warranty_claims
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION handyman_service_warranty_claim_require_event();
    `);

    // ---- The warranty head can never contradict its claim facts --
    // The authority for the claim-path head statuses (CLAIM_OPEN /
    // CLAIM_APPROVED / CLAIM_REJECTED) is the CLAIM record (§5): a head
    // that claims a claim state without the matching claim fact can never
    // become durable, whatever writer touches it.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_service_warranty_claim_head_mirror_required()
      RETURNS trigger AS $$
      DECLARE
        expected_claim TEXT;
      BEGIN
        IF NEW.status = 'CLAIM_OPEN' THEN
          expected_claim := 'CLAIM_SUBMITTED';
        ELSIF NEW.status = 'CLAIM_APPROVED' THEN
          expected_claim := 'CLAIM_APPROVED';
        ELSIF NEW.status = 'CLAIM_REJECTED' THEN
          expected_claim := 'CLAIM_REJECTED';
        ELSE
          RETURN NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM handyman_service_warranty_claims
          WHERE warranty_id = NEW.id AND status = expected_claim
        ) THEN
          RAISE EXCEPTION
            'Handyman service warranty status cannot contradict its claim facts: the claim-path statuses require the matching claim record.';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE CONSTRAINT TRIGGER handyman_service_warranty_claim_head_mirror
        AFTER INSERT OR UPDATE ON handyman_service_warranties
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_service_warranty_claim_head_mirror_required();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_service_warranty_claim_head_mirror
        ON handyman_service_warranties
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_service_warranty_claim_event_required
        ON handyman_service_warranty_claims
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_service_warranty_claim_evidence_check
        ON handyman_service_warranty_claims
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_service_warranty_claim_guard
        ON handyman_service_warranty_claims
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_service_warranty_claim_events_no_write
        ON handyman_service_warranty_claim_events
    `);
    await client.query(
      `DROP FUNCTION IF EXISTS
        handyman_service_warranty_claim_head_mirror_required()`,
    );
    await client.query(
      `DROP FUNCTION IF EXISTS
        handyman_service_warranty_claim_require_event()`,
    );
    await client.query(
      `DROP FUNCTION IF EXISTS
        handyman_service_warranty_claim_event_no_write()`,
    );
    await client.query(
      `DROP FUNCTION IF EXISTS
        handyman_service_warranty_claim_evidence_guard()`,
    );
    await client.query(
      `DROP FUNCTION IF EXISTS
        handyman_service_warranty_claim_guard_mutation()`,
    );
    await client.query(
      `DROP TABLE IF EXISTS handyman_service_warranty_claim_events`,
    );
    await client.query(
      `DROP TABLE IF EXISTS handyman_service_warranty_claims`,
    );
  },
};
