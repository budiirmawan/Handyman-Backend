import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-MANUAL-QUOTATION-01 — PART 01: Operations triage over the existing
 * Unlisted Service Intake (0486) + the manual-quotation-ready projection.
 *
 * Additive minimum (reverting `down`; nothing else touched):
 *
 *   handyman_unlisted_intake_triage_decisions   APPEND-ONLY Operations triage
 *     decision facts (decision, server-derived status projection,
 *     justification, actor, timestamp, Client/Building/Tenant snapshot,
 *     idempotency key + payload hash). UPDATE/DELETE are blocked by trigger.
 *     Deliberately carries NO foreign key onto
 *     `handyman_unlisted_service_intake_cases`: the intake table is the
 *     audited subject and 0486 must keep its own reversible `down()`. The
 *     scope binding is instead enforced by an insert guard trigger that
 *     re-reads the authoritative intake row (client/building/tenant parity
 *     is a hard 23514, exactly the 0486 precedent).
 *
 *   handyman_unlisted_intake_triage_state       1:1 projection anchor: the
 *     ONE effective decision per case (PRIMARY KEY on intake_case_id) plus its
 *     timestamp. No column is ADDED to the 0486 table — that table is recreated
 *     by its own reversible `down()` (exercised by the PART 01 suite), so any
 *     0487 column would silently disappear there; 0487 therefore only widens
 *     the `status` CHECK on it and adds an UPDATE guard.
 *
 *   handyman_unlisted_service_intake_cases      widened lifecycle projection:
 *     the `status` CHECK gains the five triage outcomes and the new projection
 *     trigger refuses any status change that is not authorized by the case's own
 *     state row and the immutable decision it anchors (whose `status_after`
 *     must equal the status being written) — so an unauthorized, duplicated or
 *     reversed transition is structurally impossible, not merely
 *     service-discouraged. Every intake field, the customer complaint, the visit
 *     preference and the internal notes stay exactly as 0486 froze them.
 *
 * No service_catalog row is ever created here: MATCH_EXISTING_CATALOG_SERVICE
 * only anchors an ALREADY-EXISTING, ACTIVE, same-Client catalog service, and
 * the manual-quotation branch stores a REQUIREMENT (summary/quantity/UOM),
 * never a price. Quotation creation and customer approval stay in
 * `handyman-quotations`.
 */
export const migration0487HandymanUnlistedIntakeOperationsTriage: Migration = {
  id: '0487_handyman_unlisted_intake_operations_triage',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_unlisted_service_intake_cases
        DROP CONSTRAINT IF EXISTS
        handyman_unlisted_service_intake_cases_status_check;

      ALTER TABLE handyman_unlisted_service_intake_cases
        ADD CONSTRAINT handyman_unlisted_service_intake_cases_status_check
        CHECK (status IN (
          'PENDING_TRIAGE',
          'AWAITING_INFORMATION',
          'TRIAGED_CATALOG_MATCHED',
          'TRIAGED_CLIENT_CUSTOM_SERVICE',
          'TRIAGED_MANUAL_QUOTATION_READY',
          'REJECTED_UNSUPPORTED'
        ));

      CREATE TABLE handyman_unlisted_intake_triage_decisions (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
        building_id UUID NOT NULL REFERENCES buildings (id) ON DELETE RESTRICT,
        tenant_company_id UUID NOT NULL
          REFERENCES tenant_companies (id) ON DELETE RESTRICT,
        intake_case_id UUID NOT NULL,
        decision TEXT NOT NULL
          CHECK (decision IN (
            'MATCH_EXISTING_CATALOG_SERVICE',
            'CREATE_CLIENT_CUSTOM_SERVICE',
            'ONE_TIME_MANUAL_QUOTATION_REQUIRED',
            'REQUEST_MORE_INFORMATION_OR_INSPECTION',
            'REJECT_UNSUPPORTED'
          )),
        status_after TEXT NOT NULL
          CHECK (status_after IN (
            'AWAITING_INFORMATION',
            'TRIAGED_CATALOG_MATCHED',
            'TRIAGED_CLIENT_CUSTOM_SERVICE',
            'TRIAGED_MANUAL_QUOTATION_READY',
            'REJECTED_UNSUPPORTED'
          )),
        justification TEXT NOT NULL
          CHECK (
            char_length(btrim(justification)) BETWEEN 10 AND 2000
          ),
        clarification_request TEXT NULL
          CHECK (
            clarification_request IS NULL
            OR char_length(btrim(clarification_request)) BETWEEN 1 AND 1000
          ),
        catalog_service_id UUID NULL
          REFERENCES service_catalog (id) ON DELETE RESTRICT,
        custom_service_name TEXT NULL
          CHECK (
            custom_service_name IS NULL
            OR char_length(btrim(custom_service_name)) BETWEEN 1 AND 250
          ),
        custom_service_notes TEXT NULL
          CHECK (
            custom_service_notes IS NULL
            OR char_length(btrim(custom_service_notes)) BETWEEN 1 AND 1000
          ),
        manual_quote_summary TEXT NULL
          CHECK (
            manual_quote_summary IS NULL
            OR char_length(btrim(manual_quote_summary)) BETWEEN 1 AND 1000
          ),
        manual_quote_quantity NUMERIC(18, 4) NULL
          CHECK (manual_quote_quantity IS NULL OR manual_quote_quantity > 0),
        manual_quote_uom_id UUID NULL
          REFERENCES units_of_measure (id) ON DELETE RESTRICT,
        triaged_by_user_id UUID NOT NULL
          REFERENCES users (id) ON DELETE RESTRICT,
        triaged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        idempotency_key TEXT NOT NULL
          CHECK (
            char_length(btrim(idempotency_key)) BETWEEN 1 AND 200
            AND idempotency_key = btrim(idempotency_key)
          ),
        payload_hash TEXT NOT NULL
          CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_unlisted_intake_triage_case_key_unique
          UNIQUE (intake_case_id, idempotency_key),
        -- Scope-FK precedent (0313/0319/0321): lets the intake table prove
        -- Client/Building scope structurally against THIS row.
        CONSTRAINT handyman_unlisted_intake_triage_scope_pair_unique
          UNIQUE (id, client_id, building_id),
        -- One decision, one projection: the status it authorizes is part of
        -- the immutable fact, never a caller-supplied field.
        CONSTRAINT handyman_unlisted_intake_triage_projection_check
          CHECK (
            (decision = 'MATCH_EXISTING_CATALOG_SERVICE'
              AND status_after = 'TRIAGED_CATALOG_MATCHED')
            OR (decision = 'CREATE_CLIENT_CUSTOM_SERVICE'
              AND status_after = 'TRIAGED_CLIENT_CUSTOM_SERVICE')
            OR (decision = 'ONE_TIME_MANUAL_QUOTATION_REQUIRED'
              AND status_after = 'TRIAGED_MANUAL_QUOTATION_READY')
            OR (decision = 'REQUEST_MORE_INFORMATION_OR_INSPECTION'
              AND status_after = 'AWAITING_INFORMATION')
            OR (decision = 'REJECT_UNSUPPORTED'
              AND status_after = 'REJECTED_UNSUPPORTED')
          ),
        -- Exactly one decision payload shape per branch; the catalog branch
        -- is the ONLY one allowed to name a service_catalog entry, and the
        -- manual branch never carries an amount (no fictional price).
        CONSTRAINT handyman_unlisted_intake_triage_shape_check
          CHECK (
            (decision = 'MATCH_EXISTING_CATALOG_SERVICE'
              AND catalog_service_id IS NOT NULL
              AND custom_service_name IS NULL
              AND manual_quote_summary IS NULL
              AND clarification_request IS NULL)
            OR (decision = 'CREATE_CLIENT_CUSTOM_SERVICE'
              AND catalog_service_id IS NULL
              AND custom_service_name IS NOT NULL
              AND manual_quote_summary IS NULL
              AND clarification_request IS NULL)
            OR (decision = 'ONE_TIME_MANUAL_QUOTATION_REQUIRED'
              AND catalog_service_id IS NULL
              AND custom_service_name IS NULL
              AND manual_quote_summary IS NOT NULL
              AND manual_quote_quantity IS NOT NULL
              AND manual_quote_uom_id IS NOT NULL
              AND clarification_request IS NULL)
            OR (decision = 'REQUEST_MORE_INFORMATION_OR_INSPECTION'
              AND catalog_service_id IS NULL
              AND custom_service_name IS NULL
              AND manual_quote_summary IS NULL
              AND clarification_request IS NOT NULL)
            OR (decision = 'REJECT_UNSUPPORTED'
              AND catalog_service_id IS NULL
              AND custom_service_name IS NULL
              AND manual_quote_summary IS NULL
              AND clarification_request IS NULL)
          )
      );

      CREATE INDEX handyman_unlisted_intake_triage_case_idx
        ON handyman_unlisted_intake_triage_decisions
          (intake_case_id, triaged_at DESC, id DESC);

      CREATE INDEX handyman_unlisted_intake_triage_scope_idx
        ON handyman_unlisted_intake_triage_decisions
          (client_id, building_id, decision, triaged_at DESC);

      CREATE OR REPLACE FUNCTION handyman_unlisted_intake_guard_triage_insert()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_case_client_id UUID;
        v_case_building_id UUID;
        v_case_tenant_company_id UUID;
        v_case_status TEXT;
        v_state_exists BOOLEAN;
        v_catalog_client_id UUID;
        v_catalog_status TEXT;
        v_uom_status TEXT;
      BEGIN
        SELECT c.client_id, c.building_id, c.tenant_company_id, c.status
          INTO v_case_client_id, v_case_building_id, v_case_tenant_company_id,
               v_case_status
          FROM handyman_unlisted_service_intake_cases c
         WHERE c.id = NEW.intake_case_id;

        IF v_case_client_id IS NULL THEN
          RAISE EXCEPTION
            'handyman_unlisted_intake_triage_decisions.intake_case_id must reference an existing unlisted service intake case'
            USING ERRCODE = '23503';
        END IF;

        IF NEW.client_id <> v_case_client_id
           OR NEW.building_id <> v_case_building_id
           OR NEW.tenant_company_id <> v_case_tenant_company_id THEN
          RAISE EXCEPTION
            'handyman_unlisted_intake_triage_decisions scope must match the authoritative unlisted service intake case'
            USING ERRCODE = '23514';
        END IF;

        -- A triage decision is only ever recorded on an untriaged (or
        -- clarification-pending) case, exactly ONE effective decision exists
        -- per case, and at most ONE clarification round may precede it.
        SELECT EXISTS (
          SELECT 1
            FROM handyman_unlisted_intake_triage_state st
           WHERE st.intake_case_id = NEW.intake_case_id
        ) INTO v_state_exists;

        IF v_case_status NOT IN ('PENDING_TRIAGE', 'AWAITING_INFORMATION')
           OR v_state_exists THEN
          RAISE EXCEPTION
            'handyman_unlisted_service_intake_cases is already triaged; triage decisions are recorded once per case'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.decision = 'REQUEST_MORE_INFORMATION_OR_INSPECTION' THEN
          IF EXISTS (
            SELECT 1
              FROM handyman_unlisted_intake_triage_decisions p
             WHERE p.intake_case_id = NEW.intake_case_id
          ) THEN
            RAISE EXCEPTION
              'An unlisted service intake case may request information or inspection only once before it is classified'
              USING ERRCODE = '23514';
          END IF;
        ELSIF EXISTS (
          SELECT 1
            FROM handyman_unlisted_intake_triage_decisions p
           WHERE p.intake_case_id = NEW.intake_case_id
             AND p.decision <> 'REQUEST_MORE_INFORMATION_OR_INSPECTION'
        ) THEN
          RAISE EXCEPTION
            'An unlisted service intake case already carries its one effective Operations triage decision'
            USING ERRCODE = '23514';
        END IF;

        -- Customer-facing Tenant PIC accounts never author Operations triage.
        IF EXISTS (
          SELECT 1
            FROM tenant_pics tp
           WHERE tp.user_id = NEW.triaged_by_user_id
        ) THEN
          RAISE EXCEPTION
            'Customer-facing Tenant PIC accounts cannot record Operations triage decisions'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.catalog_service_id IS NOT NULL THEN
          SELECT sc.client_id, sc.status
            INTO v_catalog_client_id, v_catalog_status
            FROM service_catalog sc
           WHERE sc.id = NEW.catalog_service_id;

          IF v_catalog_client_id IS NULL OR v_catalog_client_id <> NEW.client_id THEN
            RAISE EXCEPTION
              'handyman_unlisted_intake_triage_decisions.catalog_service_id must be a service_catalog entry of the same Client'
              USING ERRCODE = '23514';
          END IF;
          IF v_catalog_status <> 'ACTIVE' THEN
            RAISE EXCEPTION
              'handyman_unlisted_intake_triage_decisions.catalog_service_id must reference an ACTIVE service_catalog entry'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        IF NEW.manual_quote_uom_id IS NOT NULL THEN
          SELECT u.status INTO v_uom_status
            FROM units_of_measure u
           WHERE u.id = NEW.manual_quote_uom_id;

          IF v_uom_status IS NULL OR v_uom_status <> 'ACTIVE' THEN
            RAISE EXCEPTION
              'handyman_unlisted_intake_triage_decisions.manual_quote_uom_id must reference an ACTIVE unit of measure'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_handyman_unlisted_intake_guard_triage_insert
      BEFORE INSERT ON handyman_unlisted_intake_triage_decisions
      FOR EACH ROW
      EXECUTE FUNCTION handyman_unlisted_intake_guard_triage_insert();

      CREATE OR REPLACE FUNCTION handyman_unlisted_intake_guard_triage_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION
          'handyman_unlisted_intake_triage_decisions are immutable authoritative facts'
          USING ERRCODE = '23514';
      END;
      $$;

      CREATE TRIGGER trg_handyman_unlisted_intake_guard_triage_mutation
      BEFORE UPDATE OR DELETE ON handyman_unlisted_intake_triage_decisions
      FOR EACH ROW
      EXECUTE FUNCTION handyman_unlisted_intake_guard_triage_mutation();

      CREATE TABLE handyman_unlisted_intake_triage_state (
        intake_case_id UUID PRIMARY KEY,
        triage_decision_id UUID NOT NULL
          REFERENCES handyman_unlisted_intake_triage_decisions (id)
          ON DELETE RESTRICT,
        triaged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        -- One decision can never anchor two cases.
        CONSTRAINT handyman_unlisted_intake_triage_state_decision_unique
          UNIQUE (triage_decision_id)
      );

      CREATE INDEX handyman_unlisted_intake_triage_state_triaged_idx
        ON handyman_unlisted_intake_triage_state (triaged_at DESC, intake_case_id DESC);

      -- Manual-quotation readiness queue (PART 02 consumes exactly this).
      CREATE INDEX handyman_unlisted_intake_manual_quote_ready_idx
        ON handyman_unlisted_service_intake_cases (client_id, building_id, id)
        WHERE status = 'TRIAGED_MANUAL_QUOTATION_READY';

      CREATE OR REPLACE FUNCTION handyman_unlisted_intake_guard_triage_state()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_case_client_id UUID;
        v_case_building_id UUID;
        v_decision_case_id UUID;
        v_decision_client_id UUID;
        v_decision_building_id UUID;
        v_decision_effective BOOLEAN;
      BEGIN
        -- The anchor itself is immutable; only columns a later PART adds may
        -- move (e.g. the PART 02 conversion reference).
        IF TG_OP = 'UPDATE'
           AND (
             NEW.intake_case_id <> OLD.intake_case_id
             OR NEW.triage_decision_id <> OLD.triage_decision_id
             OR NEW.triaged_at <> OLD.triaged_at
             OR NEW.created_at <> OLD.created_at
           ) THEN
          RAISE EXCEPTION
            'handyman_unlisted_intake_triage_state is an immutable projection anchor'
            USING ERRCODE = '23514';
        END IF;

        SELECT c.client_id, c.building_id
          INTO v_case_client_id, v_case_building_id
          FROM handyman_unlisted_service_intake_cases c
         WHERE c.id = NEW.intake_case_id;

        IF v_case_client_id IS NULL THEN
          RAISE EXCEPTION
            'handyman_unlisted_intake_triage_state.intake_case_id must reference an existing unlisted service intake case'
            USING ERRCODE = '23503';
        END IF;

        SELECT d.intake_case_id, d.client_id, d.building_id,
               (d.decision <> 'REQUEST_MORE_INFORMATION_OR_INSPECTION')
          INTO v_decision_case_id, v_decision_client_id, v_decision_building_id,
               v_decision_effective
          FROM handyman_unlisted_intake_triage_decisions d
         WHERE d.id = NEW.triage_decision_id;

        IF v_decision_case_id IS NULL OR NOT v_decision_effective
           OR v_decision_case_id <> NEW.intake_case_id
           OR v_decision_client_id <> v_case_client_id
           OR v_decision_building_id <> v_case_building_id THEN
          RAISE EXCEPTION
            'handyman_unlisted_intake_triage_state must anchor the effective Operations triage decision of this case'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_handyman_unlisted_intake_guard_triage_state
      BEFORE INSERT OR UPDATE ON handyman_unlisted_intake_triage_state
      FOR EACH ROW
      EXECUTE FUNCTION handyman_unlisted_intake_guard_triage_state();

      CREATE TRIGGER trg_handyman_unlisted_intake_guard_triage_state_delete
      BEFORE DELETE ON handyman_unlisted_intake_triage_state
      FOR EACH ROW
      EXECUTE FUNCTION handyman_unlisted_intake_guard_triage_mutation();

      CREATE OR REPLACE FUNCTION handyman_unlisted_intake_guard_projection()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.status = OLD.status THEN
          RETURN NEW;
        END IF;

        IF OLD.status NOT IN ('PENDING_TRIAGE', 'AWAITING_INFORMATION') THEN
          RAISE EXCEPTION
            'handyman_unlisted_service_intake_cases status is terminal after Operations triage; no further transition is permitted'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.status = 'PENDING_TRIAGE' THEN
          RAISE EXCEPTION
            'handyman_unlisted_service_intake_cases can never return to PENDING_TRIAGE'
            USING ERRCODE = '23514';
        END IF;

        -- The projection must be authorized by THIS case's own immutable
        -- triage facts, written first in the same transaction.
        IF NOT EXISTS (
          SELECT 1
            FROM handyman_unlisted_intake_triage_decisions d
           WHERE d.intake_case_id = NEW.id
             AND d.client_id = NEW.client_id
             AND d.building_id = NEW.building_id
             AND d.status_after = NEW.status
             AND (
               (NEW.status = 'AWAITING_INFORMATION')
               OR (
                 d.decision <> 'REQUEST_MORE_INFORMATION_OR_INSPECTION'
                 AND EXISTS (
                   SELECT 1
                     FROM handyman_unlisted_intake_triage_state st
                    WHERE st.intake_case_id = NEW.id
                      AND st.triage_decision_id = d.id
                 )
               )
             )
        ) THEN
          RAISE EXCEPTION
            'No immutable Operations triage decision authorizes this unlisted service intake status transition'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_handyman_unlisted_intake_guard_projection
      BEFORE UPDATE ON handyman_unlisted_service_intake_cases
      FOR EACH ROW
      EXECUTE FUNCTION handyman_unlisted_intake_guard_projection();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_unlisted_intake_triage_decisions)
           OR EXISTS (SELECT 1 FROM handyman_unlisted_intake_triage_state)
           OR EXISTS (
             SELECT 1
               FROM handyman_unlisted_service_intake_cases
              WHERE status <> 'PENDING_TRIAGE'
           ) THEN
          RAISE EXCEPTION
            'Cannot roll back Operations triage while triage decisions or triaged intake cases exist'
            USING ERRCODE = '23514';
        END IF;
      END $$;

      DROP TRIGGER IF EXISTS trg_handyman_unlisted_intake_guard_projection
        ON handyman_unlisted_service_intake_cases;
      DROP FUNCTION IF EXISTS handyman_unlisted_intake_guard_projection();

      DROP TRIGGER IF EXISTS trg_handyman_unlisted_intake_guard_triage_state_delete
        ON handyman_unlisted_intake_triage_state;
      DROP TRIGGER IF EXISTS trg_handyman_unlisted_intake_guard_triage_state
        ON handyman_unlisted_intake_triage_state;
      DROP FUNCTION IF EXISTS handyman_unlisted_intake_guard_triage_state();

      DROP TABLE IF EXISTS handyman_unlisted_intake_triage_state;
      DROP TABLE IF EXISTS handyman_unlisted_intake_triage_decisions;

      ALTER TABLE handyman_unlisted_service_intake_cases
        DROP CONSTRAINT IF EXISTS
        handyman_unlisted_service_intake_cases_status_check;

      ALTER TABLE handyman_unlisted_service_intake_cases
        ADD CONSTRAINT handyman_unlisted_service_intake_cases_status_check
        CHECK (status IN ('PENDING_TRIAGE'));
    `);
  },
};
