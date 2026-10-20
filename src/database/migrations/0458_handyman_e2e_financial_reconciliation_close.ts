import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-E2E-FINANCIAL-RECONCILIATION — Backend Audit & Gap Closure.
 *
 * Additive, forward-safe schema & trigger reconciliation:
 * 1. Quotation DP terms (`dp_required`, `dp_percentage`, `dp_amount`,
 *    `dp_terms_notes`) on `handyman_quotation_versions`, editable only while
 *    the version is `DRAFT` (or on `DRAFT -> ISSUED`) and immutable once
 *    `ISSUED` / `APPROVED`.
 * 2. Commercial obligation stage (`obligation_stage`: `DP | TERMIN | PELUNASAN`)
 *    on `handyman_customer_payments`, immutable after recording.
 * 3. Pre-completion / pre-final-invoice payment-proof upload support on
 *    `handyman_customer_payment_proof_guard()` (`0433`) so Customer Care can
 *    upload proof for `DP` and `TERMIN` payments before final invoice
 *    finalization while preserving parent payment/transaction/scope/client
 *    integrity and single-active-proof immutability.
 * 4. BAST re-preparation after customer `REJECT`: `handyman_bast_documents_active_scope_idx`
 *    treats `REJECTED` and `VOID` as non-active so rework + re-QC can produce a
 *    new BAST while preserving rejected BAST history.
 * 5. Scope variation (`ADD` / `REDUCE`) charge composition & invoice
 *    reconciliation: `handyman_charge_line_basis_consistency()` and
 *    `handyman_charge_line_basis_anchor_consistency()` accept quotation lines
 *    from approved `ADD` variations in `FINAL_CHARGE_ELIGIBILITY`
 *    (`final_charge_eligible = TRUE`), and `handyman_scope_variations_invoiced_check`
 *    allows `invoiced = TRUE` once `status = 'FINAL_CHARGE_ELIGIBILITY' AND
 *    final_charge_eligible = TRUE`.
 * 6. Manager `FINAL CLOSE` terminal state (`status = 'CLOSED'`, `closed_at`,
 *    `closed_by_user_id`, `close_reason`) on `handyman_execution_scopes` plus
 *    append-only `handyman_execution_scope_close_events` audit ledger.
 */
export const migration0458HandymanE2eFinancialReconciliationClose: Migration = {
  id: '0458_handyman_e2e_financial_reconciliation_close',
  async up(client: PoolClient): Promise<void> {
    // 1. Quotation DP terms on handyman_quotation_versions
    await client.query(`
      ALTER TABLE handyman_quotation_versions
        ADD COLUMN IF NOT EXISTS dp_required BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS dp_percentage NUMERIC(5, 2) NULL,
        ADD COLUMN IF NOT EXISTS dp_amount NUMERIC(18, 2) NULL,
        ADD COLUMN IF NOT EXISTS dp_terms_notes VARCHAR(500) NULL
    `);

    await client.query(`
      ALTER TABLE handyman_quotation_versions
        DROP CONSTRAINT IF EXISTS handyman_quotation_versions_dp_pct_check,
        DROP CONSTRAINT IF EXISTS handyman_quotation_versions_dp_amt_check,
        DROP CONSTRAINT IF EXISTS handyman_quotation_versions_dp_consistency_check
    `);

    await client.query(`
      ALTER TABLE handyman_quotation_versions
        ADD CONSTRAINT handyman_quotation_versions_dp_pct_check
          CHECK (dp_percentage IS NULL OR (dp_percentage > 0 AND dp_percentage <= 100)),
        ADD CONSTRAINT handyman_quotation_versions_dp_amt_check
          CHECK (dp_amount IS NULL OR dp_amount > 0),
        ADD CONSTRAINT handyman_quotation_versions_dp_consistency_check
          CHECK (dp_required = TRUE OR (dp_percentage IS NULL AND dp_amount IS NULL))
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
        IF OLD.status <> 'DRAFT' AND (
             NEW.dp_required IS DISTINCT FROM OLD.dp_required
             OR NEW.dp_percentage IS DISTINCT FROM OLD.dp_percentage
             OR NEW.dp_amount IS DISTINCT FROM OLD.dp_amount
             OR NEW.dp_terms_notes IS DISTINCT FROM OLD.dp_terms_notes
           ) THEN
          RAISE EXCEPTION
            'Handyman quotation version DP terms are immutable once version leaves DRAFT.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 2. Commercial obligation stage on handyman_customer_payments
    await client.query(`
      ALTER TABLE handyman_customer_payments
        ADD COLUMN IF NOT EXISTS obligation_stage VARCHAR(32) NOT NULL DEFAULT 'PELUNASAN'
    `);

    await client.query(`
      ALTER TABLE handyman_customer_payments
        DROP CONSTRAINT IF EXISTS handyman_customer_payments_obligation_stage_check
    `);

    await client.query(`
      ALTER TABLE handyman_customer_payments
        ADD CONSTRAINT handyman_customer_payments_obligation_stage_check
          CHECK (obligation_stage IN ('DP', 'TERMIN', 'PELUNASAN'))
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_customer_payment_guard_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman customer payments are immutable ledger facts: never deleted.';
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF NEW.status IS DISTINCT FROM 'PENDING'
             OR NEW.decided_at IS NOT NULL
             OR NEW.decided_by_user_id IS NOT NULL
             OR NEW.rejection_reason IS NOT NULL
          THEN
            RAISE EXCEPTION
              'Handyman customer payments enter the ledger as PENDING: only the bounded confirmation path may decide them.';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM OLD.client_id
           OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
           OR NEW.amount IS DISTINCT FROM OLD.amount
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.channel IS DISTINCT FROM OLD.channel
           OR NEW.obligation_stage IS DISTINCT FROM OLD.obligation_stage
           OR NEW.provider_name IS DISTINCT FROM OLD.provider_name
           OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
           OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
           OR NEW.received_at IS DISTINCT FROM OLD.received_at
           OR NEW.recorded_by_user_id IS DISTINCT FROM OLD.recorded_by_user_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION
            'Handyman customer payment money and identity facts are immutable once recorded.';
        END IF;
        IF OLD.status IS DISTINCT FROM 'PENDING' THEN
          RAISE EXCEPTION
            'Handyman customer payment is already decided: a second decision is forbidden (one authoritative transition per fact).';
        END IF;
        IF NEW.status IS NULL
           OR NEW.status NOT IN ('CONFIRMED', 'REJECTED')
        THEN
          RAISE EXCEPTION
            'Handyman customer payment decision must be CONFIRMED or REJECTED.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 3. Payment proof guard: allow DP / TERMIN / PELUNASAN proof upload on
    // any recorded payment belonging to the scope's ledger transaction, with or
    // without an already-FINALIZED tenant invoice.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_customer_payment_proof_guard()
      RETURNS TRIGGER AS $$
      DECLARE
        v_payment RECORD;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.execution_type = 'HANDYMAN_CUSTOMER_PAYMENT' THEN
            RAISE EXCEPTION
              'Handyman customer payment proof cannot be deleted.'
              USING ERRCODE = '23514';
          END IF;
          RETURN OLD;
        END IF;

        IF TG_OP = 'UPDATE' THEN
          IF OLD.execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'
             AND (
               NEW.id <> OLD.id
               OR NEW.client_id <> OLD.client_id
               OR NEW.evidence_requirement_id IS DISTINCT FROM OLD.evidence_requirement_id
               OR NEW.execution_type <> OLD.execution_type
               OR NEW.execution_id <> OLD.execution_id
               OR NEW.evidence_type <> OLD.evidence_type
               OR NEW.file_reference <> OLD.file_reference
               OR NEW.original_file_name <> OLD.original_file_name
               OR NEW.mime_type <> OLD.mime_type
               OR NEW.file_size <> OLD.file_size
               OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
               OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
               OR NEW.content_hashed_at IS DISTINCT FROM OLD.content_hashed_at
               OR NEW.hash_algorithm IS DISTINCT FROM OLD.hash_algorithm
               OR NEW.created_at <> OLD.created_at
             ) THEN
            RAISE EXCEPTION
              'Handyman customer payment proof is immutable once recorded.'
              USING ERRCODE = '23514';
          END IF;
          IF OLD.execution_type <> 'HANDYMAN_CUSTOMER_PAYMENT'
             AND NEW.execution_type = 'HANDYMAN_CUSTOMER_PAYMENT' THEN
            RAISE EXCEPTION
              'Evidence submission cannot be rebound to HANDYMAN_CUSTOMER_PAYMENT.'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;

        IF NEW.execution_type <> 'HANDYMAN_CUSTOMER_PAYMENT' THEN
          RETURN NEW;
        END IF;

        SELECT p.client_id, es.handyman_request_id, i.id AS invoice_id
          INTO v_payment
          FROM handyman_customer_payments p
          JOIN handyman_customer_transactions t ON t.id = p.transaction_id
          JOIN handyman_execution_scopes es ON es.id = t.execution_scope_id
          LEFT JOIN tenant_invoices i
            ON i.handyman_execution_scope_id = es.id
           AND i.client_id = p.client_id
           AND i.tenant_company_id = es.tenant_company_id
           AND i.status = 'FINALIZED'
         WHERE p.id = NEW.execution_id;

        IF NOT FOUND OR v_payment.client_id <> NEW.client_id THEN
          RAISE EXCEPTION
            'Handyman customer payment proof must reference a valid customer payment on the execution scope ledger.'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.evidence_requirement_id IS NOT NULL
           OR NEW.evidence_type NOT IN ('PHOTO', 'DOCUMENT')
           OR NEW.file_reference <> ('evidence/' || NEW.id::text)
           OR NEW.file_size <= 0
           OR NEW.content_sha256 IS NULL
           OR NEW.content_sha256 !~ '^[0-9a-f]{64}$'
           OR NEW.content_hashed_at IS NULL
           OR NEW.hash_algorithm <> 'SHA-256'
           OR NEW.status <> 'ACTIVE' THEN
          RAISE EXCEPTION
            'Handyman customer payment proof violates integrity constraints.'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 4. Allow preparing a new BAST after customer REJECT (once re-QC PASS is recorded)
    await client.query(`
      DROP INDEX IF EXISTS handyman_bast_one_active_idx
    `);
    await client.query(`
      DROP INDEX IF EXISTS handyman_bast_documents_active_scope_idx
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_bast_one_active_idx
        ON handyman_bast_documents (execution_scope_id)
        WHERE status NOT IN ('VOID', 'REJECTED')
    `);

    // 5. Scope variation charge line composition & invoiced flag reconciliation
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_charge_line_basis_consistency()
      RETURNS trigger AS $$
      DECLARE
        tx_version             UUID;
        tx_scope_id            UUID;
        tx_client_id           UUID;
        quote_version          UUID;
        quote_type             TEXT;
        quote_total            NUMERIC(18, 2);
        quote_currency         VARCHAR(3);
        v_authorized_variation BOOLEAN;
      BEGIN
        SELECT quotation_version_id, execution_scope_id, client_id
          INTO tx_version, tx_scope_id, tx_client_id
          FROM handyman_customer_transactions
          WHERE id = NEW.transaction_id;
        IF tx_version IS NULL THEN
          -- Absent parent falls through to the FK constraints.
          RETURN NEW;
        END IF;
        SELECT quotation_version_id, line_type, line_total, currency
          INTO quote_version, quote_type, quote_total, quote_currency
          FROM handyman_quotation_lines
          WHERE id = NEW.quotation_line_id;
        IF quote_version IS NULL THEN
          -- Absent referent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        v_authorized_variation := FALSE;
        IF quote_version IS DISTINCT FROM tx_version THEN
          SELECT EXISTS (
            SELECT 1
              FROM handyman_scope_variations v
             WHERE v.execution_scope_id = tx_scope_id
               AND v.client_id = tx_client_id
               AND v.variation_type = 'ADD'
               AND v.status = 'FINAL_CHARGE_ELIGIBILITY'
               AND v.final_charge_eligible = TRUE
               AND v.revised_quotation_version_id = quote_version
          ) INTO v_authorized_variation;
        END IF;
        IF quote_version IS DISTINCT FROM tx_version
           AND NOT v_authorized_variation THEN
          RAISE EXCEPTION
            'Handyman charge line must reference a quotation line of the transaction anchored approved quotation version.';
        END IF;
        IF NEW.line_kind IS DISTINCT FROM quote_type
           OR NEW.currency IS DISTINCT FROM quote_currency
           OR NEW.amount > quote_total
           OR (NEW.line_kind = 'LABOR'
               AND NEW.amount IS DISTINCT FROM quote_total)
        THEN
          RAISE EXCEPTION
            'Handyman charge lines are composed from the immutable quotation snapshot line: LABOR equals the approved amount, MATERIAL never exceeds it, and the unit amount is never re-authored.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_charge_line_basis_anchor_consistency()
      RETURNS trigger AS $$
      DECLARE
        line_client        UUID;
        line_tx            UUID;
        line_version       UUID;
        line_quote_version UUID;
        line_quote         UUID;
        line_kind          TEXT;
        line_currency      VARCHAR(3);
        line_amount        NUMERIC(18, 2);
      BEGIN
        SELECT l.client_id, l.transaction_id, t.quotation_version_id,
               ql.quotation_version_id, l.quotation_line_id, l.line_kind,
               l.currency, l.amount
          INTO line_client, line_tx, line_version, line_quote_version,
               line_quote, line_kind, line_currency, line_amount
          FROM handyman_charge_lines l
          JOIN handyman_customer_transactions t
            ON t.id = l.transaction_id
          LEFT JOIN handyman_quotation_lines ql
            ON ql.id = l.quotation_line_id
          WHERE l.id = NEW.charge_line_id;
        IF line_client IS NULL THEN
          -- Absent parent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM line_client
           OR NEW.transaction_id IS DISTINCT FROM line_tx
           OR (NEW.quotation_version_id IS DISTINCT FROM line_version
               AND NEW.quotation_version_id IS DISTINCT FROM line_quote_version)
           OR NEW.quotation_line_id IS DISTINCT FROM line_quote
           OR NEW.line_kind IS DISTINCT FROM line_kind
           OR NEW.currency IS DISTINCT FROM line_currency
           OR NEW.amount IS DISTINCT FROM line_amount
        THEN
          RAISE EXCEPTION
            'Handyman charge line composition anchor must match its posted charge line exactly (client, transaction, quotation snapshot, kind, currency, amount).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      ALTER TABLE handyman_scope_variations
        DROP CONSTRAINT IF EXISTS handyman_scope_variations_invoiced_check
    `);
    await client.query(`
      ALTER TABLE handyman_scope_variations
        ADD CONSTRAINT handyman_scope_variations_invoiced_check
          CHECK (invoiced = FALSE OR (status = 'FINAL_CHARGE_ELIGIBILITY' AND final_charge_eligible = TRUE))
    `);

    // 6. Manager FINAL CLOSE terminal state & immutable close audit events
    await client.query(`
      ALTER TABLE handyman_execution_scopes
        ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS closed_by_user_id UUID NULL REFERENCES users (id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS close_reason VARCHAR(500) NULL
    `);

    await client.query(`
      ALTER TABLE handyman_execution_scopes
        DROP CONSTRAINT IF EXISTS handyman_execution_scopes_status_check,
        DROP CONSTRAINT IF EXISTS handyman_execution_scopes_close_fields_check
    `);

    await client.query(`
      ALTER TABLE handyman_execution_scopes
        ADD CONSTRAINT handyman_execution_scopes_status_check
          CHECK (status IN ('AUTHORIZED', 'CLOSED')),
        ADD CONSTRAINT handyman_execution_scopes_close_fields_check
          CHECK (
            (status = 'AUTHORIZED' AND closed_at IS NULL AND closed_by_user_id IS NULL AND close_reason IS NULL)
            OR (status = 'CLOSED' AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL AND length(btrim(close_reason)) BETWEEN 1 AND 500)
          )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS handyman_execution_scope_close_events (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
        building_id UUID NOT NULL REFERENCES buildings (id) ON DELETE RESTRICT,
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes (id) ON DELETE RESTRICT,
        handyman_request_id UUID NOT NULL REFERENCES handyman_service_requests (id) ON DELETE RESTRICT,
        bast_id UUID NOT NULL REFERENCES handyman_bast_documents (id) ON DELETE RESTRICT,
        qc_run_id UUID NOT NULL REFERENCES handyman_qc_runs (id) ON DELETE RESTRICT,
        transaction_id UUID NOT NULL REFERENCES handyman_customer_transactions (id) ON DELETE RESTRICT,
        invoice_id UUID NOT NULL REFERENCES tenant_invoices (id) ON DELETE RESTRICT,
        currency VARCHAR(3) NOT NULL,
        charged_net_amount NUMERIC(18, 2) NOT NULL,
        paid_applied_amount NUMERIC(18, 2) NOT NULL,
        actor_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        reason VARCHAR(500) NOT NULL,
        idempotency_key VARCHAR(200) NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_execution_scope_close_events_scope_unique UNIQUE (execution_scope_id),
        CONSTRAINT handyman_execution_scope_close_events_idempotency_unique UNIQUE (execution_scope_id, idempotency_key),
        CONSTRAINT handyman_execution_scope_close_events_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
        CONSTRAINT handyman_execution_scope_close_events_key_check CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_execution_scope_close_events_immutable()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION
          'handyman_execution_scope_close_events is append-only (op=%)',
          TG_OP
          USING ERRCODE = 'check_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS handyman_execution_scope_close_events_no_mutate
        ON handyman_execution_scope_close_events
    `);
    await client.query(`
      CREATE TRIGGER handyman_execution_scope_close_events_no_mutate
        BEFORE UPDATE OR DELETE ON handyman_execution_scope_close_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_execution_scope_close_events_immutable()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_execution_scope_block_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman execution scopes are immutable authority records.';
        END IF;

        IF NEW.id <> OLD.id
           OR NEW.client_id <> OLD.client_id
           OR NEW.handyman_request_id <> OLD.handyman_request_id
           OR NEW.channel_attribution_id <> OLD.channel_attribution_id
           OR NEW.quotation_id <> OLD.quotation_id
           OR NEW.approved_quotation_version_id <> OLD.approved_quotation_version_id
           OR NEW.quotation_decision_id <> OLD.quotation_decision_id
           OR NEW.tenant_company_id <> OLD.tenant_company_id
           OR NEW.tenant_pic_id IS DISTINCT FROM OLD.tenant_pic_id
           OR NEW.building_id <> OLD.building_id
           OR NEW.floor_id IS DISTINCT FROM OLD.floor_id
           OR NEW.area_id IS DISTINCT FROM OLD.area_id
           OR NEW.room_id IS DISTINCT FROM OLD.room_id
           OR NEW.space_id IS DISTINCT FROM OLD.space_id
           OR NEW.created_by_user_id <> OLD.created_by_user_id
           OR NEW.created_at <> OLD.created_at
           OR OLD.status <> 'AUTHORIZED'
           OR NEW.status <> 'CLOSED'
           OR NEW.closed_at IS NULL
           OR NEW.closed_by_user_id IS NULL
           OR NEW.close_reason IS NULL
           OR NOT EXISTS (
             SELECT 1
               FROM handyman_execution_scope_close_events ce
              WHERE ce.execution_scope_id = NEW.id
                AND ce.actor_user_id = NEW.closed_by_user_id
           ) THEN
          RAISE EXCEPTION
            'Handyman execution scopes are immutable authority records.';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION tenant_invoice_handyman_line_guard()
      RETURNS trigger AS $$
      DECLARE
        invoice_scope UUID;
        invoice_status TEXT;
        invoice_client UUID;
        invoice_tenant UUID;
        invoice_building UUID;
        invoice_space UUID;
        invoice_currency VARCHAR(3);
        line_client UUID;
        line_transaction UUID;
        line_scope UUID;
        line_tenant UUID;
        line_building UUID;
        line_space UUID;
        line_currency VARCHAR(3);
        line_amount NUMERIC;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          SELECT handyman_execution_scope_id INTO invoice_scope
            FROM tenant_invoices WHERE id = OLD.invoice_id FOR UPDATE;
          IF invoice_scope IS NOT NULL THEN
            RAISE EXCEPTION 'Handyman invoice source lines cannot be deleted.'
              USING ERRCODE = '23514';
          END IF;
          RETURN OLD;
        END IF;
        SELECT handyman_execution_scope_id, status, client_id,
               tenant_company_id, building_id, space_id, currency_code
          INTO invoice_scope, invoice_status, invoice_client, invoice_tenant,
               invoice_building, invoice_space, invoice_currency
          FROM tenant_invoices WHERE id = NEW.invoice_id FOR UPDATE;
        IF invoice_status IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'Only a draft invoice can receive source lines.'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.source_type <> 'HANDYMAN_CHARGE' THEN
          IF invoice_scope IS NOT NULL THEN
            RAISE EXCEPTION 'Handyman invoices cannot contain mixed source types.'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;
        SELECT cl.client_id, cl.transaction_id, tx.execution_scope_id,
               es.tenant_company_id, es.building_id, es.space_id,
               cl.currency,
               (cl.amount - COALESCE((
                 SELECT SUM(c.amount)
                   FROM handyman_ledger_corrections c
                  WHERE c.source_charge_line_id = cl.id
                    AND c.correction_kind = 'ADJUSTMENT'
               ), 0))::numeric(18, 2)
          INTO line_client, line_transaction, line_scope,
               line_tenant, line_building, line_space, line_currency,
               line_amount
          FROM handyman_charge_lines cl
          JOIN handyman_customer_transactions tx ON tx.id = cl.transaction_id
          JOIN handyman_execution_scopes es ON es.id = tx.execution_scope_id
         WHERE cl.id = NEW.handyman_charge_line_id;
        IF line_scope IS NULL OR invoice_scope IS DISTINCT FROM line_scope OR
           invoice_client IS DISTINCT FROM line_client OR
           invoice_tenant IS DISTINCT FROM line_tenant OR
           invoice_building IS DISTINCT FROM line_building OR
           invoice_space IS DISTINCT FROM line_space OR
           invoice_currency IS DISTINCT FROM line_currency OR
           NEW.amount_snapshot IS DISTINCT FROM line_amount OR
           NEW.currency_code IS DISTINCT FROM line_currency THEN
          RAISE EXCEPTION 'Handyman invoice line must match its source charge and execution scope.'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_execution_scope_close_events_no_mutate
        ON handyman_execution_scope_close_events
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS handyman_execution_scope_close_events_immutable()
    `);
    await client.query(`
      DROP TABLE IF EXISTS handyman_execution_scope_close_events
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_execution_scopes_immutable()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION
          'handyman_execution_scopes is immutable after creation (op=%)',
          TG_OP
          USING ERRCODE = 'check_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      ALTER TABLE handyman_execution_scopes
        DROP CONSTRAINT IF EXISTS handyman_execution_scopes_close_fields_check,
        DROP CONSTRAINT IF EXISTS handyman_execution_scopes_status_check
    `);
    await client.query(`
      ALTER TABLE handyman_execution_scopes
        ADD CONSTRAINT handyman_execution_scopes_status_check
          CHECK (status IN ('AUTHORIZED'))
    `);
    await client.query(`
      ALTER TABLE handyman_execution_scopes
        DROP COLUMN IF EXISTS close_reason,
        DROP COLUMN IF EXISTS closed_by_user_id,
        DROP COLUMN IF EXISTS closed_at
    `);

    await client.query(`
      ALTER TABLE handyman_scope_variations
        DROP CONSTRAINT IF EXISTS handyman_scope_variations_invoiced_check
    `);
    await client.query(`
      ALTER TABLE handyman_scope_variations
        ADD CONSTRAINT handyman_scope_variations_invoiced_check
          CHECK (invoiced = FALSE)
    `);

    await client.query(`
      DROP INDEX IF EXISTS handyman_bast_documents_active_scope_idx
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_bast_documents_active_scope_idx
        ON handyman_bast_documents (execution_scope_id)
        WHERE status <> 'VOID'
    `);

    await client.query(`
      ALTER TABLE handyman_customer_payments
        DROP CONSTRAINT IF EXISTS handyman_customer_payments_obligation_stage_check,
        DROP COLUMN IF EXISTS obligation_stage
    `);

    await client.query(`
      ALTER TABLE handyman_quotation_versions
        DROP CONSTRAINT IF EXISTS handyman_quotation_versions_dp_consistency_check,
        DROP CONSTRAINT IF EXISTS handyman_quotation_versions_dp_amt_check,
        DROP CONSTRAINT IF EXISTS handyman_quotation_versions_dp_pct_check,
        DROP COLUMN IF EXISTS dp_terms_notes,
        DROP COLUMN IF EXISTS dp_amount,
        DROP COLUMN IF EXISTS dp_percentage,
        DROP COLUMN IF EXISTS dp_required
    `);
  },
};
