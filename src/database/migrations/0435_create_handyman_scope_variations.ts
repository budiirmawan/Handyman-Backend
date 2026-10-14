import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-FIELD-AUTHORITY-01 P0-B — Pekerjaan Tambah / Kurang (ADD / REDUCE)
 * Execution Scope Variation persistence & append-only audit stream.
 *
 * Governed lifecycle:
 *   FIELD_FINDING -> PROPOSAL -> OPERATIONS_REVIEW -> REVISED_QUOTATION ->
 *   TENANT_DECISION -> AUTHORIZED_SCOPE -> EXECUTION -> QC ->
 *   FINAL_CHARGE_ELIGIBILITY
 *
 * Preserves immutability of `handyman_execution_scopes` and original
 * `handyman_quotation_lines`, enforces tenant-decision gate before
 * `AUTHORIZED_SCOPE`, and prevents automatic invoice addition (`invoiced = FALSE`).
 */
export const migration0435CreateHandymanScopeVariations: Migration = {
  id: '0435_create_handyman_scope_variations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_scope_variations (
        id                           UUID PRIMARY KEY,
        client_id                    UUID NOT NULL REFERENCES clients (id),
        execution_scope_id           UUID NOT NULL REFERENCES handyman_execution_scopes (id),
        handyman_request_id          UUID NOT NULL,
        tenant_company_id            UUID NOT NULL REFERENCES tenant_companies (id),
        building_id                  UUID NOT NULL REFERENCES buildings (id),
        variation_type               TEXT NOT NULL
          CHECK (variation_type IN ('ADD', 'REDUCE')),
        line_type                    TEXT NOT NULL
          CHECK (line_type IN ('LABOR', 'MATERIAL')),
        target_quotation_line_id     UUID REFERENCES handyman_quotation_lines (id),
        revised_quotation_version_id UUID REFERENCES handyman_quotation_versions (id),
        qc_run_id                    UUID REFERENCES handyman_qc_runs (id),
        bast_id                      UUID REFERENCES handyman_bast_documents (id),
        title                        TEXT NOT NULL
          CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
        description                  TEXT NOT NULL
          CHECK (char_length(btrim(description)) BETWEEN 1 AND 1000),
        technical_finding            TEXT NOT NULL
          CHECK (char_length(btrim(technical_finding)) BETWEEN 1 AND 1000),
        quantity                     NUMERIC(14, 3) NOT NULL
          CHECK (quantity > 0),
        uom_id                       UUID NOT NULL REFERENCES units_of_measure (id),
        quoted_unit_amount           NUMERIC(18, 2)
          CHECK (quoted_unit_amount IS NULL OR quoted_unit_amount >= 0),
        quoted_total_delta           NUMERIC(18, 2),
        currency                     VARCHAR(3)
          CHECK (currency IS NULL OR currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD', 'EUR', 'GBP', 'JPY', 'CNY'
          )),
        status                       TEXT NOT NULL
          CHECK (status IN (
            'FIELD_FINDING',
            'PROPOSAL',
            'OPERATIONS_REVIEW',
            'REVISED_QUOTATION',
            'TENANT_DECISION',
            'AUTHORIZED_SCOPE',
            'EXECUTION',
            'QC',
            'FINAL_CHARGE_ELIGIBILITY'
          )),
        tenant_decision_outcome      TEXT
          CHECK (tenant_decision_outcome IS NULL
            OR tenant_decision_outcome IN ('APPROVED', 'REJECTED')),
        tenant_decided_by_user_id    UUID REFERENCES users (id),
        tenant_decided_at            TIMESTAMPTZ,
        qc_outcome                   TEXT
          CHECK (qc_outcome IS NULL OR qc_outcome IN ('PASSED', 'FAILED')),
        qc_verified_by_user_id       UUID REFERENCES users (id),
        qc_verified_at               TIMESTAMPTZ,
        final_charge_eligible        BOOLEAN NOT NULL DEFAULT FALSE,
        invoiced                     BOOLEAN NOT NULL DEFAULT FALSE
          CHECK (invoiced = FALSE),
        origin_actor_user_id         UUID NOT NULL REFERENCES users (id),
        origin_actor_role            TEXT NOT NULL
          CHECK (origin_actor_role IN ('PIC_PEKERJAAN', 'INSPECTOR')),
        latest_evidence_reference    TEXT NOT NULL
          CHECK (char_length(btrim(latest_evidence_reference)) BETWEEN 1 AND 500),
        create_idempotency_key       TEXT NOT NULL
          CHECK (char_length(btrim(create_idempotency_key)) BETWEEN 1 AND 128),
        version                      INTEGER NOT NULL DEFAULT 1
          CHECK (version >= 1),
        created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_scope_variations_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id),
        CONSTRAINT handyman_scope_variations_create_idem_unique
          UNIQUE (execution_scope_id, create_idempotency_key),
        CONSTRAINT handyman_scope_variations_reduce_target_check
          CHECK (variation_type = 'ADD' OR target_quotation_line_id IS NOT NULL),
        CONSTRAINT handyman_scope_variations_revised_quotation_required_check
          CHECK (
            status NOT IN ('REVISED_QUOTATION', 'TENANT_DECISION', 'AUTHORIZED_SCOPE', 'EXECUTION', 'QC', 'FINAL_CHARGE_ELIGIBILITY')
            OR (
              revised_quotation_version_id IS NOT NULL
              AND quoted_unit_amount IS NOT NULL
              AND quoted_total_delta IS NOT NULL
              AND currency IS NOT NULL
            )
          ),
        CONSTRAINT handyman_scope_variations_authorized_requires_tenant_approval
          CHECK (
            status NOT IN ('AUTHORIZED_SCOPE', 'EXECUTION', 'QC', 'FINAL_CHARGE_ELIGIBILITY')
            OR tenant_decision_outcome = 'APPROVED'
          ),
        CONSTRAINT handyman_scope_variations_qc_requires_qc_run_check
          CHECK (
            status NOT IN ('QC', 'FINAL_CHARGE_ELIGIBILITY')
            OR (qc_outcome IS NOT NULL AND qc_run_id IS NOT NULL)
          ),
        CONSTRAINT handyman_scope_variations_final_charge_requires_qc_pass
          CHECK (
            status <> 'FINAL_CHARGE_ELIGIBILITY'
            OR (
              qc_outcome = 'PASSED'
              AND qc_run_id IS NOT NULL
              AND bast_id IS NOT NULL
              AND final_charge_eligible = TRUE
            )
          )
      );

      CREATE INDEX handyman_scope_variations_scope_idx
        ON handyman_scope_variations (execution_scope_id, created_at ASC, id ASC);
    `);

    await client.query(`
      CREATE TABLE handyman_scope_variation_events (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        variation_id       UUID NOT NULL REFERENCES handyman_scope_variations (id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes (id),
        event_type         TEXT NOT NULL
          CHECK (event_type IN (
            'FIELD_FINDING',
            'PROPOSAL',
            'OPERATIONS_REVIEW',
            'REVISED_QUOTATION',
            'TENANT_DECISION',
            'AUTHORIZED_SCOPE',
            'EXECUTION',
            'QC',
            'FINAL_CHARGE_ELIGIBILITY'
          )),
        from_status        TEXT,
        to_status          TEXT NOT NULL,
        actor_user_id      UUID NOT NULL REFERENCES users (id),
        actor_role         TEXT NOT NULL
          CHECK (actor_role IN ('PIC_PEKERJAAN', 'INSPECTOR', 'OPERATIONS_MANAGER', 'TENANT')),
        evidence_reference TEXT NOT NULL
          CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 500),
        notes              TEXT,
        idempotency_key    TEXT NOT NULL
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_scope_variation_events_idem_unique
          UNIQUE (variation_id, event_type, idempotency_key)
      );

      CREATE INDEX handyman_scope_variation_events_var_idx
        ON handyman_scope_variation_events (variation_id, occurred_at ASC, id ASC);
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_scope_variations_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        scope_approved_qv UUID;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Handyman scope variations cannot be deleted'
            USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND (
          NEW.id IS DISTINCT FROM OLD.id OR
          NEW.client_id IS DISTINCT FROM OLD.client_id OR
          NEW.execution_scope_id IS DISTINCT FROM OLD.execution_scope_id OR
          NEW.handyman_request_id IS DISTINCT FROM OLD.handyman_request_id OR
          NEW.tenant_company_id IS DISTINCT FROM OLD.tenant_company_id OR
          NEW.building_id IS DISTINCT FROM OLD.building_id OR
          NEW.variation_type IS DISTINCT FROM OLD.variation_type OR
          NEW.origin_actor_user_id IS DISTINCT FROM OLD.origin_actor_user_id OR
          NEW.origin_actor_role IS DISTINCT FROM OLD.origin_actor_role OR
          NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key OR
          NEW.created_at IS DISTINCT FROM OLD.created_at
        ) THEN
          RAISE EXCEPTION 'Handyman scope variation identity and origin provenance are immutable'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.revised_quotation_version_id IS NOT NULL THEN
          SELECT approved_quotation_version_id INTO scope_approved_qv
            FROM handyman_execution_scopes
           WHERE id = NEW.execution_scope_id;
          IF scope_approved_qv IS NOT NULL
             AND NEW.revised_quotation_version_id = scope_approved_qv THEN
            RAISE EXCEPTION 'Handyman scope variation revised_quotation_version_id cannot reuse the original approved quotation version'
              USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER handyman_scope_variations_guard_trg
        BEFORE INSERT OR UPDATE OR DELETE ON handyman_scope_variations
        FOR EACH ROW EXECUTE FUNCTION handyman_scope_variations_guard();

      CREATE OR REPLACE FUNCTION handyman_scope_variation_events_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman scope variation events are append-only'
          USING ERRCODE = '23514';
      END;
      $$;

      CREATE TRIGGER handyman_scope_variation_events_immutable_trg
        BEFORE UPDATE OR DELETE ON handyman_scope_variation_events
        FOR EACH ROW EXECUTE FUNCTION handyman_scope_variation_events_immutable();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_scope_variation_events_immutable_trg
        ON handyman_scope_variation_events;
      DROP FUNCTION IF EXISTS handyman_scope_variation_events_immutable();
      DROP TRIGGER IF EXISTS handyman_scope_variations_guard_trg
        ON handyman_scope_variations;
      DROP FUNCTION IF EXISTS handyman_scope_variations_guard();
      DROP TABLE IF EXISTS handyman_scope_variation_events;
      DROP TABLE IF EXISTS handyman_scope_variations;
    `);
  },
};
