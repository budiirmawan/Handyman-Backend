import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-07 RUN 1 — authoritative job-scoped material demand facts.
 *
 * This deliberately introduces no inventory, reservation, movement, ledger,
 * invoice, document, or mobile surface. It records only the governed demand
 * and commercial-approval facts that a later inventory/fulfilment run may
 * consume:
 *
 *   approved job + exact approved quotation MATERIAL line
 *     -> ACTIVE QUOTATION_INCLUDED demand
 *
 *   immutable supplemental addendum -> dedicated PENDING approval
 *     -> APPROVED -> exactly one ACTIVE ADDITIONAL_CUSTOMER_CHARGEABLE demand
 *
 *   internal/field operational scope
 *     -> ACTIVE NON_CHARGEABLE_OPERATIONAL demand
 *
 * Supply source and commercial basis remain independent facts. A customer-
 * supplied item can be identified without creating an item master; provider
 * stock always names an existing inventory item. Commercial amounts exist
 * only on an addendum with an already-governed price-catalog provenance;
 * demand rows deliberately do not become a second financial authority.
 *
 * The append-only convention is structural: source/commercial snapshots are
 * immutable, ACTIVE rows can only close to SUPERSEDED/CANCELLED, and changed
 * scope is a new successor row. Partial uniqueness prevents duplicate active
 * executable demands for the same exact job-bound quotation MATERIAL line.
 */
export const migration0358CreateHandymanMaterialDemands: Migration = {
  id: '0358_create_handyman_material_demands',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_material_commercial_addenda (
        id                              UUID PRIMARY KEY,
        client_id                       UUID NOT NULL REFERENCES clients (id),
        handyman_job_id                 UUID NOT NULL REFERENCES handyman_jobs (id),
        handyman_request_id             UUID NOT NULL REFERENCES handyman_requests (id),
        building_id                     UUID NOT NULL REFERENCES buildings (id),
        supply_source                   TEXT NOT NULL,
        commercial_basis                TEXT NOT NULL DEFAULT 'ADDITIONAL_CUSTOMER_CHARGEABLE',
        inventory_item_id               UUID,
        uom_id                          UUID NOT NULL,
        description                     TEXT NOT NULL,
        quantity                        NUMERIC(18, 4) NOT NULL,
        currency                        TEXT,
        unit_commercial_amount          NUMERIC(18, 2),
        total_commercial_amount         NUMERIC(18, 2)
          GENERATED ALWAYS AS (
            CASE
              WHEN unit_commercial_amount IS NULL THEN NULL
              ELSE quantity * unit_commercial_amount
            END
          ) STORED,
        reference_price_catalog_entry_id UUID REFERENCES price_catalog_entries (id),
        reference_scope_tier            TEXT,
        reference_as_of                 TIMESTAMPTZ,
        status                          TEXT NOT NULL DEFAULT 'PENDING',
        supersedes_addendum_id          UUID REFERENCES handyman_material_commercial_addenda (id),
        superseded_at                   TIMESTAMPTZ,
        superseded_by_user_id           UUID REFERENCES users (id),
        cancelled_at                    TIMESTAMPTZ,
        cancelled_by_user_id            UUID REFERENCES users (id),
        cancellation_reason             TEXT,
        idempotency_key                 TEXT NOT NULL,
        idempotency_fingerprint         CHAR(64) NOT NULL,
        cancellation_idempotency_key    TEXT,
        cancellation_idempotency_fingerprint CHAR(64),
        created_by_user_id              UUID NOT NULL REFERENCES users (id),
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_mat_addenda_scope_unique
          UNIQUE (id, client_id),
        CONSTRAINT hm_mat_addenda_item_scope_fk
          FOREIGN KEY (inventory_item_id, client_id)
          REFERENCES inventory_items (id, client_id),
        CONSTRAINT hm_mat_addenda_uom_scope_fk
          FOREIGN KEY (uom_id, client_id)
          REFERENCES units_of_measure (id, client_id),
        CONSTRAINT hm_mat_addenda_supply_check
          CHECK (supply_source IN ('PROVIDER_STOCK', 'CUSTOMER_SUPPLIED')),
        CONSTRAINT hm_mat_addenda_basis_check
          CHECK (commercial_basis = 'ADDITIONAL_CUSTOMER_CHARGEABLE'),
        CONSTRAINT hm_mat_addenda_provider_item_check
          CHECK (supply_source <> 'PROVIDER_STOCK' OR inventory_item_id IS NOT NULL),
        -- Additional Provider-stock scope may be proposed only with one
        -- existing governed material price snapshot; no manual price lane.
        CONSTRAINT hm_mat_addenda_provider_price_check
          CHECK (supply_source <> 'PROVIDER_STOCK'
            OR reference_price_catalog_entry_id IS NOT NULL),
        CONSTRAINT hm_mat_addenda_description_check
          CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
        CONSTRAINT hm_mat_addenda_quantity_check
          CHECK (quantity > 0),
        CONSTRAINT hm_mat_addenda_currency_check
          CHECK (currency IS NULL OR currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD', 'EUR', 'GBP', 'JPY', 'CNY'
          )),
        CONSTRAINT hm_mat_addenda_price_snapshot_check
          CHECK (
            (currency IS NULL
              AND unit_commercial_amount IS NULL
              AND reference_price_catalog_entry_id IS NULL
              AND reference_scope_tier IS NULL
              AND reference_as_of IS NULL)
            OR (currency IS NOT NULL
              AND unit_commercial_amount IS NOT NULL
              AND unit_commercial_amount > 0
              AND reference_price_catalog_entry_id IS NOT NULL
              AND reference_scope_tier IN (
                'VENDOR_BUILDING', 'VENDOR', 'BUILDING', 'CLIENT_WIDE'
              )
              AND reference_as_of IS NOT NULL)
          ),
        CONSTRAINT hm_mat_addenda_status_check
          CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'CANCELLED')),
        CONSTRAINT hm_mat_addenda_pending_shape_check
          CHECK (
            status <> 'PENDING'
            OR (superseded_at IS NULL AND superseded_by_user_id IS NULL
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
              AND cancellation_reason IS NULL
              AND cancellation_idempotency_key IS NULL
              AND cancellation_idempotency_fingerprint IS NULL)
          ),
        CONSTRAINT hm_mat_addenda_decided_shape_check
          CHECK (
            status NOT IN ('APPROVED', 'REJECTED')
            OR (superseded_at IS NULL AND superseded_by_user_id IS NULL
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
              AND cancellation_reason IS NULL
              AND cancellation_idempotency_key IS NULL
              AND cancellation_idempotency_fingerprint IS NULL)
          ),
        CONSTRAINT hm_mat_addenda_superseded_shape_check
          CHECK (
            status <> 'SUPERSEDED'
            OR (superseded_at IS NOT NULL AND superseded_by_user_id IS NOT NULL
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
              AND cancellation_reason IS NULL
              AND cancellation_idempotency_key IS NULL
              AND cancellation_idempotency_fingerprint IS NULL)
          ),
        CONSTRAINT hm_mat_addenda_cancelled_shape_check
          CHECK (
            status <> 'CANCELLED'
            OR (cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
              AND cancellation_reason IN (
                'CUSTOMER_WITHDREW', 'SCOPE_NO_LONGER_REQUIRED', 'OTHER_OPERATIONAL'
              )
              AND cancellation_idempotency_key IS NOT NULL
              AND cancellation_idempotency_fingerprint IS NOT NULL
              AND superseded_at IS NULL AND superseded_by_user_id IS NULL)
          ),
        CONSTRAINT hm_mat_addenda_idempotency_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT hm_mat_addenda_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT hm_mat_addenda_cancel_key_check
          CHECK (cancellation_idempotency_key IS NULL
            OR length(btrim(cancellation_idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT hm_mat_addenda_cancel_fingerprint_check
          CHECK (cancellation_idempotency_fingerprint IS NULL
            OR cancellation_idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT hm_mat_addenda_cancel_idempotency_pair_check
          CHECK (
            (cancellation_idempotency_key IS NULL
              AND cancellation_idempotency_fingerprint IS NULL)
            OR (cancellation_idempotency_key IS NOT NULL
              AND cancellation_idempotency_fingerprint IS NOT NULL)
          )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX hm_mat_addenda_client_key_unique
        ON handyman_material_commercial_addenda (client_id, idempotency_key)
    `);
    await client.query(`
      CREATE UNIQUE INDEX hm_mat_addenda_successor_unique
        ON handyman_material_commercial_addenda (supersedes_addendum_id)
        WHERE supersedes_addendum_id IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX hm_mat_addenda_cancel_key_unique
        ON handyman_material_commercial_addenda (client_id, cancellation_idempotency_key)
        WHERE cancellation_idempotency_key IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX hm_mat_addenda_job_status_idx
        ON handyman_material_commercial_addenda (handyman_job_id, status, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE handyman_material_approvals (
        id                              UUID PRIMARY KEY,
        client_id                       UUID NOT NULL,
        handyman_job_id                 UUID NOT NULL REFERENCES handyman_jobs (id),
        handyman_request_id             UUID NOT NULL REFERENCES handyman_requests (id),
        building_id                     UUID NOT NULL REFERENCES buildings (id),
        commercial_addendum_id          UUID NOT NULL,
        status                          TEXT NOT NULL DEFAULT 'PENDING',
        method                          TEXT,
        approved_for_type               TEXT,
        approved_for_tenant_company_id  UUID REFERENCES tenant_companies (id),
        approved_for_tenant_pic_id      UUID REFERENCES tenant_pics (id),
        approved_for_name               TEXT,
        decision_notes                  TEXT,
        recorded_by_user_id             UUID REFERENCES users (id),
        decided_at                      TIMESTAMPTZ,
        cancelled_at                    TIMESTAMPTZ,
        cancelled_by_user_id            UUID REFERENCES users (id),
        decision_idempotency_key        TEXT,
        decision_idempotency_fingerprint CHAR(64),
        created_by_user_id              UUID NOT NULL REFERENCES users (id),
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_mat_approvals_scope_unique
          UNIQUE (id, client_id),
        CONSTRAINT hm_mat_approvals_scope_fk
          FOREIGN KEY (commercial_addendum_id, client_id)
          REFERENCES handyman_material_commercial_addenda (id, client_id),
        CONSTRAINT hm_mat_approvals_addendum_unique
          UNIQUE (commercial_addendum_id),
        CONSTRAINT hm_mat_approvals_status_check
          CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
        CONSTRAINT hm_mat_approvals_method_check
          CHECK (method IS NULL OR method IN ('IN_APP', 'ASSISTED')),
        CONSTRAINT hm_mat_approvals_for_type_check
          CHECK (approved_for_type IS NULL OR approved_for_type IN (
            'TENANT_COMPANY', 'TENANT_PIC', 'CUSTOMER'
          )),
        CONSTRAINT hm_mat_approvals_pending_shape_check
          CHECK (
            status <> 'PENDING'
            OR (method IS NULL AND approved_for_type IS NULL
              AND approved_for_tenant_company_id IS NULL
              AND approved_for_tenant_pic_id IS NULL
              AND approved_for_name IS NULL
              AND decision_notes IS NULL AND recorded_by_user_id IS NULL
              AND decided_at IS NULL AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL
              AND decision_idempotency_key IS NULL
              AND decision_idempotency_fingerprint IS NULL)
          ),
        CONSTRAINT hm_mat_approvals_decided_shape_check
          CHECK (
            status NOT IN ('APPROVED', 'REJECTED')
            OR (method IN ('IN_APP', 'ASSISTED')
              AND approved_for_type IS NOT NULL
              AND approved_for_name IS NOT NULL
              AND length(btrim(approved_for_name)) BETWEEN 1 AND 200
              AND decided_at IS NOT NULL
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
              AND decision_idempotency_key IS NOT NULL
              AND decision_idempotency_fingerprint IS NOT NULL)
          ),
        CONSTRAINT hm_mat_approvals_cancelled_shape_check
          CHECK (
            status <> 'CANCELLED'
            OR (method IS NULL AND approved_for_type IS NULL
              AND approved_for_tenant_company_id IS NULL
              AND approved_for_tenant_pic_id IS NULL
              AND approved_for_name IS NULL
              AND decision_notes IS NULL AND recorded_by_user_id IS NULL
              AND decided_at IS NULL AND cancelled_at IS NOT NULL
              AND cancelled_by_user_id IS NOT NULL
              AND decision_idempotency_key IS NULL
              AND decision_idempotency_fingerprint IS NULL)
          ),
        CONSTRAINT hm_mat_approvals_in_app_shape_check
          CHECK (
            method IS DISTINCT FROM 'IN_APP'
            OR (recorded_by_user_id IS NULL
              AND approved_for_type = 'TENANT_PIC'
              AND approved_for_tenant_pic_id IS NOT NULL)
          ),
        CONSTRAINT hm_mat_approvals_assisted_shape_check
          CHECK (
            method IS DISTINCT FROM 'ASSISTED'
            OR (recorded_by_user_id IS NOT NULL
              AND decision_notes IS NOT NULL
              AND length(btrim(decision_notes)) BETWEEN 1 AND 2000)
          ),
        CONSTRAINT hm_mat_approvals_for_company_shape_check
          CHECK (
            approved_for_type IS DISTINCT FROM 'TENANT_COMPANY'
            OR approved_for_tenant_company_id IS NOT NULL
          ),
        CONSTRAINT hm_mat_approvals_for_pic_shape_check
          CHECK (
            approved_for_type IS DISTINCT FROM 'TENANT_PIC'
            OR (approved_for_tenant_company_id IS NOT NULL
              AND approved_for_tenant_pic_id IS NOT NULL)
          ),
        CONSTRAINT hm_mat_approvals_notes_check
          CHECK (decision_notes IS NULL OR length(btrim(decision_notes)) BETWEEN 1 AND 2000),
        CONSTRAINT hm_mat_approvals_key_check
          CHECK (decision_idempotency_key IS NULL
            OR length(btrim(decision_idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT hm_mat_approvals_fingerprint_check
          CHECK (decision_idempotency_fingerprint IS NULL
            OR decision_idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT hm_mat_approvals_idempotency_pair_check
          CHECK (
            (decision_idempotency_key IS NULL
              AND decision_idempotency_fingerprint IS NULL)
            OR (decision_idempotency_key IS NOT NULL
              AND decision_idempotency_fingerprint IS NOT NULL)
          )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX hm_mat_approvals_client_decision_key_unique
        ON handyman_material_approvals (client_id, decision_idempotency_key)
        WHERE decision_idempotency_key IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX hm_mat_approvals_job_status_idx
        ON handyman_material_approvals (handyman_job_id, status, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE handyman_material_demands (
        id                              UUID PRIMARY KEY,
        client_id                       UUID NOT NULL REFERENCES clients (id),
        handyman_job_id                 UUID NOT NULL REFERENCES handyman_jobs (id),
        handyman_request_id             UUID NOT NULL REFERENCES handyman_requests (id),
        building_id                     UUID NOT NULL REFERENCES buildings (id),
        supply_source                   TEXT NOT NULL,
        commercial_basis                TEXT NOT NULL,
        source_context                  TEXT NOT NULL,
        inventory_item_id               UUID,
        uom_id                          UUID NOT NULL,
        description                     TEXT NOT NULL,
        quantity                        NUMERIC(18, 4) NOT NULL,
        handyman_service_visit_id       UUID REFERENCES handyman_service_visits (id),
        quotation_revision_id           UUID REFERENCES handyman_quotation_revisions (id),
        handyman_quotation_line_id      UUID REFERENCES handyman_quotation_lines (id),
        commercial_addendum_id          UUID,
        handyman_material_approval_id   UUID,
        status                          TEXT NOT NULL DEFAULT 'ACTIVE',
        supersedes_demand_id            UUID REFERENCES handyman_material_demands (id),
        superseded_at                   TIMESTAMPTZ,
        superseded_by_user_id           UUID REFERENCES users (id),
        cancelled_at                    TIMESTAMPTZ,
        cancelled_by_user_id            UUID REFERENCES users (id),
        cancellation_reason             TEXT,
        idempotency_key                 TEXT NOT NULL,
        idempotency_fingerprint         CHAR(64) NOT NULL,
        cancellation_idempotency_key    TEXT,
        cancellation_idempotency_fingerprint CHAR(64),
        created_by_user_id              UUID NOT NULL REFERENCES users (id),
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_mat_demands_addendum_scope_fk
          FOREIGN KEY (commercial_addendum_id, client_id)
          REFERENCES handyman_material_commercial_addenda (id, client_id),
        CONSTRAINT hm_mat_demands_approval_scope_fk
          FOREIGN KEY (handyman_material_approval_id, client_id)
          REFERENCES handyman_material_approvals (id, client_id),
        CONSTRAINT hm_mat_demands_item_scope_fk
          FOREIGN KEY (inventory_item_id, client_id)
          REFERENCES inventory_items (id, client_id),
        CONSTRAINT hm_mat_demands_uom_scope_fk
          FOREIGN KEY (uom_id, client_id)
          REFERENCES units_of_measure (id, client_id),
        CONSTRAINT hm_mat_demands_supply_check
          CHECK (supply_source IN ('PROVIDER_STOCK', 'CUSTOMER_SUPPLIED')),
        CONSTRAINT hm_mat_demands_basis_check
          CHECK (commercial_basis IN (
            'QUOTATION_INCLUDED',
            'ADDITIONAL_CUSTOMER_CHARGEABLE',
            'NON_CHARGEABLE_OPERATIONAL'
          )),
        CONSTRAINT hm_mat_demands_source_check
          CHECK (source_context IN (
            'QUOTATION_INCLUDED', 'CUSTOMER_APPROVED_ADDENDUM',
            'INTERNAL_OPERATION', 'FIELD_DISCOVERED'
          )),
        CONSTRAINT hm_mat_demands_provider_item_check
          CHECK (supply_source <> 'PROVIDER_STOCK' OR inventory_item_id IS NOT NULL),
        CONSTRAINT hm_mat_demands_description_check
          CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
        CONSTRAINT hm_mat_demands_quantity_check
          CHECK (quantity > 0),
        CONSTRAINT hm_mat_demands_included_shape_check
          CHECK (
            commercial_basis <> 'QUOTATION_INCLUDED'
            OR (source_context = 'QUOTATION_INCLUDED'
              AND supply_source = 'PROVIDER_STOCK'
              AND quotation_revision_id IS NOT NULL
              AND handyman_quotation_line_id IS NOT NULL
              AND commercial_addendum_id IS NULL
              AND handyman_material_approval_id IS NULL
              AND handyman_service_visit_id IS NULL)
          ),
        CONSTRAINT hm_mat_demands_additional_shape_check
          CHECK (
            commercial_basis <> 'ADDITIONAL_CUSTOMER_CHARGEABLE'
            OR (source_context = 'CUSTOMER_APPROVED_ADDENDUM'
              AND quotation_revision_id IS NULL
              AND handyman_quotation_line_id IS NULL
              AND commercial_addendum_id IS NOT NULL
              AND handyman_material_approval_id IS NOT NULL)
          ),
        CONSTRAINT hm_mat_demands_non_chargeable_shape_check
          CHECK (
            commercial_basis <> 'NON_CHARGEABLE_OPERATIONAL'
            OR (source_context IN ('INTERNAL_OPERATION', 'FIELD_DISCOVERED')
              AND quotation_revision_id IS NULL
              AND handyman_quotation_line_id IS NULL
              AND commercial_addendum_id IS NULL
              AND handyman_material_approval_id IS NULL)
          ),
        CONSTRAINT hm_mat_demands_field_visit_shape_check
          CHECK (
            source_context <> 'FIELD_DISCOVERED'
            OR handyman_service_visit_id IS NOT NULL
          ),
        CONSTRAINT hm_mat_demands_status_check
          CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'CANCELLED')),
        CONSTRAINT hm_mat_demands_active_shape_check
          CHECK (
            status <> 'ACTIVE'
            OR (superseded_at IS NULL AND superseded_by_user_id IS NULL
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
              AND cancellation_reason IS NULL
              AND cancellation_idempotency_key IS NULL
              AND cancellation_idempotency_fingerprint IS NULL)
          ),
        CONSTRAINT hm_mat_demands_superseded_shape_check
          CHECK (
            status <> 'SUPERSEDED'
            OR (superseded_at IS NOT NULL AND superseded_by_user_id IS NOT NULL
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
              AND cancellation_reason IS NULL
              AND cancellation_idempotency_key IS NULL
              AND cancellation_idempotency_fingerprint IS NULL)
          ),
        CONSTRAINT hm_mat_demands_cancelled_shape_check
          CHECK (
            status <> 'CANCELLED'
            OR (cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
              AND cancellation_reason IN (
                'CUSTOMER_WITHDREW', 'SCOPE_NO_LONGER_REQUIRED', 'OTHER_OPERATIONAL'
              )
              AND cancellation_idempotency_key IS NOT NULL
              AND cancellation_idempotency_fingerprint IS NOT NULL
              AND superseded_at IS NULL AND superseded_by_user_id IS NULL)
          ),
        CONSTRAINT hm_mat_demands_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT hm_mat_demands_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT hm_mat_demands_cancel_key_check
          CHECK (cancellation_idempotency_key IS NULL
            OR length(btrim(cancellation_idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT hm_mat_demands_cancel_fingerprint_check
          CHECK (cancellation_idempotency_fingerprint IS NULL
            OR cancellation_idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT hm_mat_demands_cancel_idempotency_pair_check
          CHECK (
            (cancellation_idempotency_key IS NULL
              AND cancellation_idempotency_fingerprint IS NULL)
            OR (cancellation_idempotency_key IS NOT NULL
              AND cancellation_idempotency_fingerprint IS NOT NULL)
          )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX hm_mat_demands_client_key_unique
        ON handyman_material_demands (client_id, idempotency_key)
    `);
    // The required no-duplicate rule is exact line scope, not item scope:
    // repeated material items on different quotation lines remain legal.
    await client.query(`
      CREATE UNIQUE INDEX hm_mat_demands_active_quote_line_unique
        ON handyman_material_demands
          (client_id, handyman_job_id, handyman_quotation_line_id)
        WHERE status = 'ACTIVE' AND commercial_basis = 'QUOTATION_INCLUDED'
    `);
    await client.query(`
      CREATE UNIQUE INDEX hm_mat_demands_approval_unique
        ON handyman_material_demands (handyman_material_approval_id)
        WHERE handyman_material_approval_id IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX hm_mat_demands_successor_unique
        ON handyman_material_demands (supersedes_demand_id)
        WHERE supersedes_demand_id IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX hm_mat_demands_cancel_key_unique
        ON handyman_material_demands (client_id, cancellation_idempotency_key)
        WHERE cancellation_idempotency_key IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX hm_mat_demands_job_status_idx
        ON handyman_material_demands (handyman_job_id, status, created_at DESC);
      CREATE INDEX hm_mat_demands_visit_idx
        ON handyman_material_demands (handyman_service_visit_id, status)
        WHERE handyman_service_visit_id IS NOT NULL;
      CREATE INDEX hm_mat_demands_quote_line_idx
        ON handyman_material_demands (handyman_quotation_line_id)
        WHERE handyman_quotation_line_id IS NOT NULL
    `);

    // Source/commercial facts are immutable. Only the established closure
    // transition ACTIVE -> SUPERSEDED/CANCELLED may update a demand.
    await client.query(`
      CREATE OR REPLACE FUNCTION assert_handyman_material_demand_integrity()
      RETURNS TRIGGER AS $$
      DECLARE
        included_line RECORD;
        approved_addendum RECORD;
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.status <> 'ACTIVE' THEN
          RAISE EXCEPTION 'HANDYMAN_MATERIAL_DEMAND_STATE_INVALID: demands must begin ACTIVE';
        END IF;

        -- Every demand context is server-derived from one coherent job ->
        -- request -> building chain, including non-chargeable scope.
        IF TG_OP = 'INSERT' THEN
          PERFORM 1
            FROM handyman_jobs j
            JOIN handyman_requests r ON r.id = j.handyman_request_id
           WHERE j.id = NEW.handyman_job_id
             AND j.client_id = NEW.client_id
             AND j.handyman_request_id = NEW.handyman_request_id
             AND r.client_id = NEW.client_id
             AND r.building_id = NEW.building_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_DEMAND_CONTEXT_INVALID: demand must use the job-derived request and building context';
          END IF;
          IF NEW.handyman_service_visit_id IS NOT NULL THEN
            PERFORM 1
              FROM handyman_service_visits v
             WHERE v.id = NEW.handyman_service_visit_id
               AND v.handyman_job_id = NEW.handyman_job_id
               AND v.client_id = NEW.client_id;
            IF NOT FOUND THEN
              RAISE EXCEPTION
                'HANDYMAN_MATERIAL_DEMAND_CONTEXT_INVALID: material visit provenance must belong to the job';
            END IF;
          END IF;
        END IF;

        IF TG_OP = 'INSERT' AND NEW.commercial_basis = 'QUOTATION_INCLUDED' THEN
          SELECT l.id
            INTO included_line
            FROM handyman_jobs j
            JOIN handyman_quotations q
              ON q.id = j.handyman_quotation_id
             AND q.status = 'APPROVED'
             AND q.sent_revision_id = j.handyman_quotation_revision_id
            JOIN handyman_quotation_revisions qr
              ON qr.id = j.handyman_quotation_revision_id
             AND qr.status = 'SUBMITTED'
            JOIN handyman_quotation_lines l
              ON l.id = NEW.handyman_quotation_line_id
            JOIN handyman_quotation_approvals qa
              ON qa.quotation_revision_id = j.handyman_quotation_revision_id
             AND qa.status = 'APPROVED'
           WHERE j.id = NEW.handyman_job_id
             AND j.client_id = NEW.client_id
             AND j.handyman_request_id = NEW.handyman_request_id
             AND j.handyman_quotation_revision_id = NEW.quotation_revision_id
             AND l.quotation_revision_id = j.handyman_quotation_revision_id
             AND l.line_type = 'MATERIAL'
             AND l.inventory_item_id = NEW.inventory_item_id
             AND l.uom_id = NEW.uom_id
             AND l.quantity = NEW.quantity
             AND COALESCE(l.description, l.subject_name) = NEW.description;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_DEMAND_CONTEXT_INVALID: included demand must exactly snapshot an approved job-bound MATERIAL line';
          END IF;
        ELSIF TG_OP = 'INSERT' AND NEW.commercial_basis = 'ADDITIONAL_CUSTOMER_CHARGEABLE' THEN
          SELECT a.id
            INTO approved_addendum
            FROM handyman_material_commercial_addenda a
            JOIN handyman_material_approvals ap
              ON ap.id = NEW.handyman_material_approval_id
             AND ap.commercial_addendum_id = a.id
             AND ap.status = 'APPROVED'
           WHERE a.id = NEW.commercial_addendum_id
             AND a.status = 'APPROVED'
             AND a.client_id = NEW.client_id
             AND a.handyman_job_id = NEW.handyman_job_id
             AND a.handyman_request_id = NEW.handyman_request_id
             AND a.building_id = NEW.building_id
             AND a.supply_source = NEW.supply_source
             AND a.inventory_item_id IS NOT DISTINCT FROM NEW.inventory_item_id
             AND a.uom_id = NEW.uom_id
             AND a.description = NEW.description
             AND a.quantity = NEW.quantity
             AND a.client_id = NEW.client_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_DEMAND_CONTEXT_INVALID: additional demand must exactly snapshot its approved addendum';
          END IF;
        END IF;

        IF TG_OP = 'UPDATE' THEN
          IF NEW.client_id <> OLD.client_id
            OR NEW.handyman_job_id <> OLD.handyman_job_id
            OR NEW.handyman_request_id <> OLD.handyman_request_id
            OR NEW.building_id <> OLD.building_id
            OR NEW.supply_source <> OLD.supply_source
            OR NEW.commercial_basis <> OLD.commercial_basis
            OR NEW.source_context <> OLD.source_context
            OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id
            OR NEW.uom_id <> OLD.uom_id
            OR NEW.description <> OLD.description
            OR NEW.quantity <> OLD.quantity
            OR NEW.handyman_service_visit_id IS DISTINCT FROM OLD.handyman_service_visit_id
            OR NEW.quotation_revision_id IS DISTINCT FROM OLD.quotation_revision_id
            OR NEW.handyman_quotation_line_id IS DISTINCT FROM OLD.handyman_quotation_line_id
            OR NEW.commercial_addendum_id IS DISTINCT FROM OLD.commercial_addendum_id
            OR NEW.handyman_material_approval_id IS DISTINCT FROM OLD.handyman_material_approval_id
            OR NEW.supersedes_demand_id IS DISTINCT FROM OLD.supersedes_demand_id
            OR NEW.idempotency_key <> OLD.idempotency_key
            OR NEW.idempotency_fingerprint <> OLD.idempotency_fingerprint
            OR NEW.created_by_user_id <> OLD.created_by_user_id
            OR NEW.created_at <> OLD.created_at
            OR OLD.status <> 'ACTIVE'
            OR NEW.status NOT IN ('SUPERSEDED', 'CANCELLED')
          THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_DEMAND_STATE_INVALID: demand source facts are append-only';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_demand_integrity
        BEFORE INSERT OR UPDATE ON handyman_material_demands
        FOR EACH ROW EXECUTE FUNCTION assert_handyman_material_demand_integrity()
    `);

    // Addendum scope, price provenance, and original facts never change. A
    // status can only close its PENDING commercial proposal once.
    await client.query(`
      CREATE OR REPLACE FUNCTION assert_handyman_material_addendum_integrity()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.status <> 'PENDING' THEN
          RAISE EXCEPTION 'HANDYMAN_MATERIAL_ADDENDUM_STATE_INVALID: addenda must begin PENDING';
        END IF;
        IF TG_OP = 'INSERT' THEN
          PERFORM 1
            FROM handyman_jobs j
            JOIN handyman_requests r ON r.id = j.handyman_request_id
           WHERE j.id = NEW.handyman_job_id
             AND j.client_id = NEW.client_id
             AND j.handyman_request_id = NEW.handyman_request_id
             AND r.client_id = NEW.client_id
             AND r.building_id = NEW.building_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_ADDENDUM_STATE_INVALID: addendum must use the job-derived request and building context';
          END IF;
          -- A commercial snapshot may only cite the exact active, effective
          -- MATERIAL price authority selected for this job building. Run 1
          -- has no vendor assignment input, so only the non-vendor tiers are
          -- admissible here; callers cannot inject an arbitrary amount.
          IF NEW.reference_price_catalog_entry_id IS NOT NULL THEN
            PERFORM 1
              FROM price_catalog_entries p
             WHERE p.id = NEW.reference_price_catalog_entry_id
               AND p.client_id = NEW.client_id
               AND p.source_mode = 'MATERIAL'
               AND p.item_id IS NOT DISTINCT FROM NEW.inventory_item_id
               AND p.uom_id = NEW.uom_id
               AND p.currency = NEW.currency
               AND p.unit_price = NEW.unit_commercial_amount
               AND p.status = 'ACTIVE'
               AND p.effective_from <= NEW.reference_as_of
               AND (p.effective_to IS NULL OR p.effective_to > NEW.reference_as_of)
               AND p.vendor_id IS NULL
               AND (
                 (NEW.reference_scope_tier = 'BUILDING'
                   AND p.building_id = NEW.building_id)
                 OR (NEW.reference_scope_tier = 'CLIENT_WIDE'
                   AND p.building_id IS NULL)
               );
            IF NOT FOUND THEN
              RAISE EXCEPTION
                'HANDYMAN_MATERIAL_ADDENDUM_STATE_INVALID: addendum price must exactly snapshot an active governed material price';
            END IF;
          END IF;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF NEW.client_id <> OLD.client_id
            OR NEW.handyman_job_id <> OLD.handyman_job_id
            OR NEW.handyman_request_id <> OLD.handyman_request_id
            OR NEW.building_id <> OLD.building_id
            OR NEW.supply_source <> OLD.supply_source
            OR NEW.commercial_basis <> OLD.commercial_basis
            OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id
            OR NEW.uom_id <> OLD.uom_id
            OR NEW.description <> OLD.description
            OR NEW.quantity <> OLD.quantity
            OR NEW.currency IS DISTINCT FROM OLD.currency
            OR NEW.unit_commercial_amount IS DISTINCT FROM OLD.unit_commercial_amount
            OR NEW.reference_price_catalog_entry_id IS DISTINCT FROM OLD.reference_price_catalog_entry_id
            OR NEW.reference_scope_tier IS DISTINCT FROM OLD.reference_scope_tier
            OR NEW.reference_as_of IS DISTINCT FROM OLD.reference_as_of
            OR NEW.supersedes_addendum_id IS DISTINCT FROM OLD.supersedes_addendum_id
            OR NEW.idempotency_key <> OLD.idempotency_key
            OR NEW.idempotency_fingerprint <> OLD.idempotency_fingerprint
            OR NEW.created_by_user_id <> OLD.created_by_user_id
            OR NEW.created_at <> OLD.created_at
            OR OLD.status <> 'PENDING'
            OR NEW.status NOT IN ('APPROVED', 'REJECTED', 'SUPERSEDED', 'CANCELLED')
          THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_ADDENDUM_STATE_INVALID: addendum commercial facts are append-only';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_addendum_integrity
        BEFORE INSERT OR UPDATE ON handyman_material_commercial_addenda
        FOR EACH ROW EXECUTE FUNCTION assert_handyman_material_addendum_integrity()
    `);

    // The dedicated approval is a once-only decision fact. Its decision
    // authority fields cannot be rewritten after PENDING.
    await client.query(`
      CREATE OR REPLACE FUNCTION assert_handyman_material_approval_integrity()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.status <> 'PENDING' THEN
          RAISE EXCEPTION 'HANDYMAN_MATERIAL_APPROVAL_STATE_INVALID: approvals must begin PENDING';
        END IF;
        IF TG_OP = 'INSERT' THEN
          PERFORM 1
            FROM handyman_material_commercial_addenda a
           WHERE a.id = NEW.commercial_addendum_id
             AND a.client_id = NEW.client_id
             AND a.handyman_job_id = NEW.handyman_job_id
             AND a.handyman_request_id = NEW.handyman_request_id
             AND a.building_id = NEW.building_id
             AND a.status = 'PENDING';
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_APPROVAL_STATE_INVALID: approval must begin for its pending addendum context';
          END IF;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF NEW.client_id <> OLD.client_id
            OR NEW.handyman_job_id <> OLD.handyman_job_id
            OR NEW.handyman_request_id <> OLD.handyman_request_id
            OR NEW.building_id <> OLD.building_id
            OR NEW.commercial_addendum_id <> OLD.commercial_addendum_id
            OR NEW.created_by_user_id <> OLD.created_by_user_id
            OR NEW.created_at <> OLD.created_at
            OR OLD.status <> 'PENDING'
            OR NEW.status NOT IN ('APPROVED', 'REJECTED', 'CANCELLED')
          THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_APPROVAL_STATE_INVALID: approval facts are once-only';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_approval_integrity
        BEFORE INSERT OR UPDATE ON handyman_material_approvals
        FOR EACH ROW EXECUTE FUNCTION assert_handyman_material_approval_integrity()
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_material_demands');
    await client.query('DROP TABLE IF EXISTS handyman_material_approvals');
    await client.query('DROP TABLE IF EXISTS handyman_material_commercial_addenda');
    await client.query(
      'DROP FUNCTION IF EXISTS assert_handyman_material_demand_integrity()',
    );
    await client.query(
      'DROP FUNCTION IF EXISTS assert_handyman_material_approval_integrity()',
    );
    await client.query(
      'DROP FUNCTION IF EXISTS assert_handyman_material_addendum_integrity()',
    );
  },
};
