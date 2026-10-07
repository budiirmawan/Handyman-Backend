import type { PoolClient } from 'pg';
import type { Migration } from './index';

/**
 * CR-HM-15 PART 04 — CHARGEABLE ADDITIONAL-WORK SEPARATION (FROZEN
 * `CR-HM-15_START_GOVERNANCE.md` §4/§5/§6/§7/§8 row 04, blocker B8).
 *
 * A chargeable scope proposal is a SEPARATE record family. It is NEVER
 * the free warranty rework:
 *
 *   • the free `handyman_service_warranty_reworks` row is never mutated
 *     into a chargeable state, and is never re-pointed or re-used here;
 *   • a chargeable referral can only be created while the claim's free
 *     rework is absent or still REWORK_DRAFT (never accepted, never
 *     executed) — a free rework that was accepted or executed can never
 *     be converted into chargeable work;
 *   • once a chargeable referral exists for a claim, the free rework of
 *     that claim can never leave REWORK_DRAFT (mutually exclusive paths);
 *   • the warranty HEAD is not touched at all: this PART emits a
 *     separation fact + a payment trigger fact for CR-HM-13 and never
 *     writes a money state. The frozen head vocabulary has no chargeable
 *     value, and financial execution stays downstream.
 *
 * Statuses (chargeable record only, separate vocabulary):
 *   CHARGEABLE_PROPOSED --ACCEPT--> CHARGEABLE_AUTHORIZED
 *   CHARGEABLE_PROPOSED --REJECT--> CHARGEABLE_REJECTED
 * Both outcomes are final. Acceptance emits the CR-HM-13 payment trigger
 * fact; no amount, price, currency, ledger, payment or settlement is
 * recorded here.
 */
export const migration0422CreateHandymanChargeableAdditionalWorks: Migration = {
  id: '0422_create_handyman_chargeable_additional_works',
  async up(client: PoolClient): Promise<void> {
    // ---- Chargeable additional-work record (SEPARATE family) -----
    await client.query(`
      CREATE TABLE handyman_chargeable_additional_works (
        id                        UUID PRIMARY KEY,
        client_id                 UUID NOT NULL
          REFERENCES clients (id),
        warranty_id               UUID NOT NULL,
        claim_id                  UUID NOT NULL,
        execution_scope_id        UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        bast_id                   UUID NOT NULL
          REFERENCES handyman_bast_documents (id),
        status                    TEXT NOT NULL DEFAULT 'CHARGEABLE_PROPOSED',
        scope_note                TEXT NOT NULL DEFAULT '',
        proposed_by_user_id       UUID NOT NULL
          REFERENCES users (id),
        proposed_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at                TIMESTAMPTZ,
        decided_by_user_id        UUID
          REFERENCES users (id),
        payment_trigger_emitted_at TIMESTAMPTZ,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_chargeable_additional_work_claim_client_fk
          FOREIGN KEY (claim_id, client_id)
            REFERENCES handyman_service_warranty_claims (id, client_id),
        CONSTRAINT handyman_chargeable_additional_work_claim_warranty_fk
          FOREIGN KEY (claim_id, warranty_id)
            REFERENCES handyman_service_warranty_claims (id, warranty_id),
        CONSTRAINT handyman_chargeable_additional_work_claim_scope_fk
          FOREIGN KEY (claim_id, execution_scope_id)
            REFERENCES handyman_service_warranty_claims
              (id, execution_scope_id),
        CONSTRAINT handyman_chargeable_additional_work_claim_bast_fk
          FOREIGN KEY (claim_id, bast_id)
            REFERENCES handyman_service_warranty_claims (id, bast_id),
        CONSTRAINT handyman_chargeable_additional_work_warranty_client_fk
          FOREIGN KEY (warranty_id, client_id)
            REFERENCES handyman_service_warranties (id, client_id),
        CONSTRAINT handyman_chargeable_additional_work_warranty_bast_fk
          FOREIGN KEY (warranty_id, bast_id)
            REFERENCES handyman_service_warranties (id, bast_id),
        CONSTRAINT handyman_chargeable_additional_work_status_check
          CHECK (status IN (
            'CHARGEABLE_PROPOSED', 'CHARGEABLE_AUTHORIZED',
            'CHARGEABLE_REJECTED')),
        CONSTRAINT handyman_chargeable_additional_work_scope_note_check
          CHECK (char_length(scope_note) <= 2000),
        -- The authored status can never contradict its own facts, and the
        -- payment trigger fact exists IF AND ONLY IF the customer
        -- authorized the chargeable scope.
        CONSTRAINT handyman_chargeable_additional_work_state_check
          CHECK (
            (status = 'CHARGEABLE_PROPOSED'
              AND decided_at IS NULL AND decided_by_user_id IS NULL
              AND payment_trigger_emitted_at IS NULL)
            OR (status = 'CHARGEABLE_AUTHORIZED'
              AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
              AND payment_trigger_emitted_at IS NOT NULL)
            OR (status = 'CHARGEABLE_REJECTED'
              AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
              AND payment_trigger_emitted_at IS NULL)),
        CONSTRAINT handyman_chargeable_additional_work_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_chargeable_additional_work_id_claim_unique
          UNIQUE (id, claim_id),
        CONSTRAINT handyman_chargeable_additional_work_id_scope_unique
          UNIQUE (id, execution_scope_id),
        CONSTRAINT handyman_chargeable_additional_work_id_bast_unique
          UNIQUE (id, bast_id),
        CONSTRAINT handyman_chargeable_additional_work_id_warranty_unique
          UNIQUE (id, warranty_id),
        -- ONE separated chargeable referral per claim (fail-closed).
        CONSTRAINT handyman_chargeable_additional_work_claim_unique
          UNIQUE (claim_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_chargeable_additional_works_warranty_idx
        ON handyman_chargeable_additional_works
          (warranty_id, created_at, id)
    `);
    await client.query(`
      CREATE INDEX handyman_chargeable_additional_works_scope_idx
        ON handyman_chargeable_additional_works
          (execution_scope_id, status, created_at)
    `);

    // ---- Chargeable additional-work event stream (append-only) ---
    await client.query(`
      CREATE TABLE handyman_chargeable_additional_work_events (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        work_id            UUID NOT NULL,
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

        CONSTRAINT handyman_chargeable_additional_work_event_work_client_fk
          FOREIGN KEY (work_id, client_id)
            REFERENCES handyman_chargeable_additional_works (id, client_id),
        CONSTRAINT handyman_chargeable_additional_work_event_work_claim_fk
          FOREIGN KEY (work_id, claim_id)
            REFERENCES handyman_chargeable_additional_works (id, claim_id),
        CONSTRAINT handyman_chargeable_additional_work_event_work_warranty_fk
          FOREIGN KEY (work_id, warranty_id)
            REFERENCES handyman_chargeable_additional_works
              (id, warranty_id),
        CONSTRAINT handyman_chargeable_additional_work_event_work_scope_fk
          FOREIGN KEY (work_id, execution_scope_id)
            REFERENCES handyman_chargeable_additional_works
              (id, execution_scope_id),
        CONSTRAINT handyman_chargeable_additional_work_event_work_bast_fk
          FOREIGN KEY (work_id, bast_id)
            REFERENCES handyman_chargeable_additional_works (id, bast_id),
        CONSTRAINT handyman_chargeable_additional_work_event_type_check
          CHECK (event_type IN (
            'PROPOSE', 'ACCEPT', 'REJECT', 'PAYMENT_TRIGGER')),
        CONSTRAINT handyman_chargeable_additional_work_event_key_check
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX
        handyman_chargeable_additional_work_events_idem_idx
        ON handyman_chargeable_additional_work_events
          (work_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_chargeable_additional_work_events_work_idx
        ON handyman_chargeable_additional_work_events
          (work_id, occurred_at, id)
    `);

    // ---- Entry gate + frozen identity + separated ladder ---------
    // A chargeable referral enters as CHARGEABLE_PROPOSED for an APPROVED
    // or REJECTED claim whose warranty head agrees, and ONLY while the
    // free warranty rework is absent or still REWORK_DRAFT. Identity is
    // frozen forever, both outcomes are final, and DELETE is refused.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_chargeable_additional_work_guard_mutation()
      RETURNS trigger AS $$
      DECLARE
        parent_claim_status     TEXT;
        parent_warranty_status  TEXT;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman chargeable additional work is never deleted: warranty, claim and rework history is preserved.';
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF NEW.status IS DISTINCT FROM 'CHARGEABLE_PROPOSED'
             OR NEW.decided_at IS NOT NULL
             OR NEW.decided_by_user_id IS NOT NULL
             OR NEW.payment_trigger_emitted_at IS NOT NULL
          THEN
            RAISE EXCEPTION
              'Handyman chargeable additional work enters as CHARGEABLE_PROPOSED: only the state-gated chargeable path may authorize or reject it.';
          END IF;
          SELECT status INTO parent_claim_status
            FROM handyman_service_warranty_claims
            WHERE id = NEW.claim_id;
          IF parent_claim_status IS NULL
             OR parent_claim_status NOT IN (
               'CLAIM_APPROVED', 'CLAIM_REJECTED')
          THEN
            RAISE EXCEPTION
              'Handyman chargeable additional work requires an APPROVED or REJECTED warranty claim.';
          END IF;
          SELECT status INTO parent_warranty_status
            FROM handyman_service_warranties
            WHERE id = NEW.warranty_id;
          IF parent_warranty_status IS DISTINCT FROM parent_claim_status
          THEN
            RAISE EXCEPTION
              'Handyman chargeable additional work requires the matching warranty head state.';
          END IF;
          IF EXISTS (
            SELECT 1 FROM handyman_service_warranty_reworks
            WHERE claim_id = NEW.claim_id AND status <> 'REWORK_DRAFT'
          ) THEN
            RAISE EXCEPTION
              'Handyman chargeable additional work is SEPARATE from free warranty rework: a free rework that was accepted or executed can never become chargeable.';
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
           OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION
            'Handyman chargeable additional work identity facts are immutable once proposed.';
        END IF;
        IF OLD.payment_trigger_emitted_at IS NOT NULL
           AND NEW.payment_trigger_emitted_at
             IS DISTINCT FROM OLD.payment_trigger_emitted_at
        THEN
          RAISE EXCEPTION
            'The CR-HM-13 payment trigger fact of a chargeable additional-work separation is immutable.';
        END IF;
        IF OLD.status = 'CHARGEABLE_PROPOSED' THEN
          IF NEW.status NOT IN (
            'CHARGEABLE_PROPOSED', 'CHARGEABLE_AUTHORIZED',
            'CHARGEABLE_REJECTED')
          THEN
            RAISE EXCEPTION
              'Illegal Handyman chargeable additional-work transition (frozen state machine).';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.decided_at IS DISTINCT FROM OLD.decided_at
           OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
           OR NEW.status IS DISTINCT FROM OLD.status
        THEN
          RAISE EXCEPTION
            'The customer decision on a chargeable additional-work referral is final (one authoritative transition per referral).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_chargeable_additional_work_guard
        BEFORE INSERT OR UPDATE OR DELETE
        ON handyman_chargeable_additional_works
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_chargeable_additional_work_guard_mutation();
    `);

    // ---- Free rework can never be converted into chargeable work -
    // The chargeable path and the free path are mutually exclusive per
    // claim: once a chargeable referral exists, the free rework of that
    // claim can never be authorized or executed (it stays REWORK_DRAFT,
    // unaccepted). This trigger never mutates the rework row.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_chargeable_additional_work_blocks_free_rework()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'REWORK_DRAFT'
           AND NEW.status IS DISTINCT FROM 'REWORK_DRAFT'
           AND EXISTS (
             SELECT 1 FROM handyman_chargeable_additional_works
             WHERE claim_id = NEW.claim_id
           )
        THEN
          RAISE EXCEPTION
            'Free Handyman service warranty rework and chargeable additional work are SEPARATE (B8): once chargeable additional work exists, the free rework can never be accepted or executed.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_chargeable_additional_work_free_rework_firewall
        BEFORE UPDATE ON handyman_service_warranty_reworks
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_chargeable_additional_work_blocks_free_rework();
    `);

    // ---- Events are append-only ----------------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_chargeable_additional_work_event_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman chargeable additional-work events are append-only: never updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_chargeable_additional_work_events_no_write
        BEFORE UPDATE OR DELETE
        ON handyman_chargeable_additional_work_events
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_chargeable_additional_work_event_no_write();
    `);

    // ---- Every referral and decision is event-backed -------------
    // Deferred to COMMIT so each event may be written right after its
    // status change inside one transaction, while a referral or decision
    // without its event remains structurally impossible.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_chargeable_additional_work_require_event()
      RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM handyman_chargeable_additional_work_events
          WHERE work_id = NEW.id AND event_type = 'PROPOSE'
        ) THEN
          RAISE EXCEPTION
            'Handyman chargeable additional work requires lifecycle evidence: a referral can never exist without its PROPOSE event.';
        END IF;
        IF NEW.status = 'CHARGEABLE_PROPOSED' THEN
          RETURN NULL;
        END IF;
        IF NEW.status = 'CHARGEABLE_AUTHORIZED' THEN
          IF NOT EXISTS (
            SELECT 1 FROM handyman_chargeable_additional_work_events
            WHERE work_id = NEW.id AND event_type = 'ACCEPT'
          ) THEN
            RAISE EXCEPTION
              'Handyman chargeable additional work requires authorization evidence: a referral can never be authorized without its ACCEPT event.';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM handyman_chargeable_additional_work_events
            WHERE work_id = NEW.id AND event_type = 'PAYMENT_TRIGGER'
          ) THEN
            RAISE EXCEPTION
              'Handyman chargeable additional work authorization always emits its CR-HM-13 payment trigger fact.';
          END IF;
          RETURN NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM handyman_chargeable_additional_work_events
          WHERE work_id = NEW.id AND event_type = 'REJECT'
        ) THEN
          RAISE EXCEPTION
            'Handyman chargeable additional work requires rejection evidence: a referral can never be rejected without its REJECT event.';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE CONSTRAINT TRIGGER
        handyman_chargeable_additional_work_event_required
        AFTER INSERT OR UPDATE ON handyman_chargeable_additional_works
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_chargeable_additional_work_require_event();
    `);

    // ---- Money firewall (structural) -----------------------------
    // This family carries NO amount, price, currency, ledger, payment or
    // settlement column at all: authorization emits a TRIGGER FACT only,
    // and CR-HM-13 owns every amount.
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS
        handyman_chargeable_additional_work_free_rework_firewall
        ON handyman_service_warranty_reworks
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_chargeable_additional_work_blocks_free_rework()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS
        handyman_chargeable_additional_work_event_required
        ON handyman_chargeable_additional_works
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS
        handyman_chargeable_additional_work_events_no_write
        ON handyman_chargeable_additional_work_events
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_chargeable_additional_work_guard
        ON handyman_chargeable_additional_works
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_chargeable_additional_work_guard_mutation()
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_chargeable_additional_work_event_no_write()
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_chargeable_additional_work_require_event()
    `);
    await client.query(`
      DROP TABLE IF EXISTS handyman_chargeable_additional_work_events
    `);
    await client.query(`
      DROP TABLE IF EXISTS handyman_chargeable_additional_works
    `);
  },
};
