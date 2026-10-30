import type { PoolClient } from 'pg';
import type { Migration } from './types';

// The receipt guard remains the existing independent-verification contract. We
// extend only its invoice-reference clause; historical immutable snapshots are
// never rewritten. Exact replacement fails closed if the older guard changed.
const GENERIC_RECEIPT_INVOICE_GUARD = String.raw`        IF jsonb_typeof(NEW.source_snapshot#>'{reference,invoice}')='object' THEN
          IF NOT EXISTS (SELECT 1 FROM tenant_invoices i JOIN handyman_customer_transactions t ON t.id=NEW.transaction_id
            JOIN handyman_execution_scopes s ON s.id=NEW.execution_scope_id
            WHERE i.id::text=NEW.source_snapshot#>>'{reference,invoice,id}' AND i.handyman_execution_scope_id=s.id
              AND i.client_id=NEW.client_id AND i.building_id=NEW.building_id AND i.tenant_company_id=NEW.tenant_company_id
              AND i.space_id IS NOT DISTINCT FROM s.space_id AND i.currency_code=t.currency
              AND i.invoice_number=NEW.source_snapshot#>>'{reference,invoice,number}'
              AND i.status=NEW.source_snapshot#>>'{reference,invoice,status}') THEN
            RAISE EXCEPTION 'Receipt invoice reference does not match.' USING ERRCODE='23514';
          END IF;
        ELSIF NEW.source_snapshot#>'{reference,invoice}'='null'::jsonb THEN
          IF EXISTS (SELECT 1 FROM tenant_invoices WHERE handyman_execution_scope_id=NEW.execution_scope_id) THEN
            RAISE EXCEPTION 'Receipt omitted an existing invoice reference.' USING ERRCODE='23514';
          END IF;
        ELSE RAISE EXCEPTION 'Receipt invoice reference is invalid.' USING ERRCODE='23514';
        END IF;`;
const OFFICIAL_RECEIPT_INVOICE_GUARD = String.raw`        IF jsonb_typeof(NEW.source_snapshot#>'{reference,invoice}')='object' THEN
          IF NOT EXISTS (SELECT 1 FROM tenant_invoices i JOIN handyman_customer_transactions t ON t.id=NEW.transaction_id
            JOIN handyman_execution_scopes s ON s.id=NEW.execution_scope_id
            WHERE i.id::text=NEW.source_snapshot#>>'{reference,invoice,id}' AND i.handyman_execution_scope_id=s.id
              AND i.client_id=NEW.client_id AND i.building_id=NEW.building_id AND i.tenant_company_id=NEW.tenant_company_id
              AND i.space_id IS NOT DISTINCT FROM s.space_id AND i.currency_code=t.currency
              AND i.invoice_number=NEW.source_snapshot#>>'{reference,invoice,number}'
              AND i.status=NEW.source_snapshot#>>'{reference,invoice,status}')
            AND NOT EXISTS (SELECT 1 FROM handyman_official_invoices i JOIN handyman_official_invoice_payment_links l
                ON l.invoice_id=i.id AND l.payment_id=NEW.payment_id
              WHERE i.id::text=NEW.source_snapshot#>>'{reference,invoice,id}' AND i.execution_scope_id=NEW.execution_scope_id
                AND i.transaction_id=NEW.transaction_id AND i.client_id=NEW.client_id AND i.building_id=NEW.building_id
                AND i.request_id=NEW.request_id AND i.tenant_company_id=NEW.tenant_company_id
                AND i.document_number=NEW.source_snapshot#>>'{reference,invoice,number}'
                AND NEW.source_snapshot#>>'{reference,invoice,status}'='ISSUED') THEN
            RAISE EXCEPTION 'Receipt invoice reference does not match.' USING ERRCODE='23514';
          END IF;
        ELSIF NEW.source_snapshot#>'{reference,invoice}'='null'::jsonb THEN
          IF EXISTS (SELECT 1 FROM tenant_invoices WHERE handyman_execution_scope_id=NEW.execution_scope_id)
            OR EXISTS (SELECT 1 FROM handyman_official_invoices i JOIN handyman_official_invoice_payment_links l
              ON l.invoice_id=i.id AND l.payment_id=NEW.payment_id WHERE i.execution_scope_id=NEW.execution_scope_id) THEN
            RAISE EXCEPTION 'Receipt omitted an existing invoice reference.' USING ERRCODE='23514';
          END IF;
        ELSE RAISE EXCEPTION 'Receipt invoice reference is invalid.' USING ERRCODE='23514';
        END IF;`;

async function replaceReceiptInvoiceGuard(tx: PoolClient, forward: boolean) {
  const definition = (await tx.query<{ definition: string }>(
    `SELECT pg_get_functiondef('hm_tenant_receipt_insert_guard()'::regprocedure) AS definition`,
  )).rows[0]?.definition;
  const from = forward ? GENERIC_RECEIPT_INVOICE_GUARD : OFFICIAL_RECEIPT_INVOICE_GUARD;
  const to = forward ? OFFICIAL_RECEIPT_INVOICE_GUARD : GENERIC_RECEIPT_INVOICE_GUARD;
  if (!definition || definition.split(from).length !== 2) {
    throw new Error('The tenant receipt invoice guard is not the expected version.');
  }
  await tx.query(definition.replace(from, to));
}

/** Add only an immutable invoice/payment bridge and reference arbitration.
 * The existing payment, evidence, Finance confirmation, allocation and receipt
 * engines remain authoritative; a link never verifies or allocates money. */
export const migration0521HandymanOfficialInvoicePayments: Migration = {
  id: '0521_handyman_official_invoice_payments',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      -- Reserve each real reference per Client, even across execution scopes
      -- and across reported references versus Finance bank reconciliations.
      -- Existing ambiguous duplicates are NOT resolved or backfilled: they
      -- remain blocked for new bindings until a governed correction exists.
      CREATE TABLE handyman_payment_reference_claims (
        client_id uuid NOT NULL REFERENCES clients(id),
        reference_key text NOT NULL CHECK (length(reference_key) BETWEEN 1 AND 200),
        payment_id uuid NOT NULL REFERENCES handyman_customer_payments(id) DEFERRABLE INITIALLY DEFERRED,
        PRIMARY KEY(client_id, reference_key)
      );
      INSERT INTO handyman_payment_reference_claims(client_id, reference_key, payment_id)
        SELECT client_id, ref, min(payment_id::text)::uuid FROM (
          SELECT client_id, lower(btrim(external_reference)) AS ref, id AS payment_id
            FROM handyman_customer_payments WHERE external_reference IS NOT NULL AND length(btrim(external_reference)) BETWEEN 1 AND 200
          UNION ALL
          SELECT client_id, lower(btrim(bank_reference)), payment_id FROM handyman_payment_reconciliations
        ) refs GROUP BY client_id,ref HAVING count(DISTINCT payment_id)=1;
      CREATE FUNCTION hm_payment_claim_reference(cid uuid, pid uuid, reference text) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE ref text := lower(btrim(reference));
      BEGIN
        IF reference IS NULL THEN RETURN; END IF;
        IF length(ref) NOT BETWEEN 1 AND 200 THEN
          RAISE EXCEPTION 'A bounded payment reference is required.' USING ERRCODE='23514';
        END IF;
        IF EXISTS (SELECT 1 FROM handyman_customer_payments p WHERE p.client_id=cid AND p.id<>pid
              AND lower(btrim(p.external_reference))=ref)
          OR EXISTS (SELECT 1 FROM handyman_payment_reconciliations r WHERE r.client_id=cid AND r.payment_id<>pid
              AND lower(btrim(r.bank_reference))=ref) THEN
          RAISE EXCEPTION 'Payment reference is already used or historically ambiguous for this Client.' USING ERRCODE='23505';
        END IF;
        INSERT INTO handyman_payment_reference_claims(client_id,reference_key,payment_id) VALUES(cid,ref,pid)
          ON CONFLICT DO NOTHING;
        IF NOT EXISTS (SELECT 1 FROM handyman_payment_reference_claims WHERE client_id=cid AND reference_key=ref AND payment_id=pid) THEN
          RAISE EXCEPTION 'Payment reference is already used for this Client.' USING ERRCODE='23505';
        END IF;
      END; $$;
      CREATE FUNCTION hm_payment_reference_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME='handyman_customer_payments' THEN
          PERFORM hm_payment_claim_reference(NEW.client_id,NEW.id,NEW.external_reference);
        ELSE
          IF NOT EXISTS(SELECT 1 FROM handyman_customer_payments p WHERE p.id=NEW.payment_id AND p.client_id=NEW.client_id) THEN
            RAISE EXCEPTION 'Bank reconciliation must match the payment Client.' USING ERRCODE='23514';
          END IF;
          PERFORM hm_payment_claim_reference(NEW.client_id,NEW.payment_id,NEW.bank_reference);
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_payment_reference_claim BEFORE INSERT ON handyman_customer_payments
        FOR EACH ROW EXECUTE FUNCTION hm_payment_reference_insert_guard();
      CREATE TRIGGER hm_reconciliation_reference_claim BEFORE INSERT ON handyman_payment_reconciliations
        FOR EACH ROW EXECUTE FUNCTION hm_payment_reference_insert_guard();
      CREATE FUNCTION hm_payment_fact_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND TG_TABLE_NAME='handyman_payment_reference_claims'
          AND NOT EXISTS(SELECT 1 FROM handyman_payment_reference_claims) THEN RETURN NULL; END IF;
        IF TG_OP='TRUNCATE' AND TG_TABLE_NAME='handyman_official_invoice_payment_links'
          AND NOT EXISTS(SELECT 1 FROM handyman_official_invoice_payment_links) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Handyman invoice payment bindings and reference claims are immutable.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_payment_reference_no_change BEFORE UPDATE OR DELETE ON handyman_payment_reference_claims
        FOR EACH ROW EXECUTE FUNCTION hm_payment_fact_immutable();
      CREATE TRIGGER hm_payment_reference_no_truncate BEFORE TRUNCATE ON handyman_payment_reference_claims
        FOR EACH STATEMENT EXECUTE FUNCTION hm_payment_fact_immutable();

      -- The unique payment ID is the bridge: all amount, payer, reference and
      -- verification facts remain on the pre-existing immutable ledger rows.
      CREATE TABLE handyman_official_invoice_payment_links (
        payment_id uuid PRIMARY KEY REFERENCES handyman_customer_payments(id),
        invoice_id uuid NOT NULL REFERENCES handyman_official_invoices(id),
        linked_by_user_id uuid NOT NULL REFERENCES users(id),
        linked_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX hm_official_invoice_payment_invoice_idx ON handyman_official_invoice_payment_links(invoice_id);
      CREATE FUNCTION hm_official_invoice_payment_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE p handyman_customer_payments%ROWTYPE; i handyman_official_invoices%ROWTYPE; bankref text;
      BEGIN
        SELECT * INTO p FROM handyman_customer_payments WHERE id=NEW.payment_id;
        SELECT * INTO i FROM handyman_official_invoices WHERE id=NEW.invoice_id;
        IF i.id IS NOT NULL THEN
          -- Same ledger/fence ordering as invoice issuance and allocations.
          -- A stale repeatable-read writer must not miss a concurrent invoice
          -- or a committed allocation while deciding whether it can link.
          PERFORM 1 FROM handyman_customer_transactions WHERE id=i.transaction_id FOR UPDATE;
          PERFORM 1 FROM handyman_invoice_source_fences WHERE execution_scope_id=i.execution_scope_id FOR UPDATE;
          IF current_setting('transaction_isolation') <> 'read committed' THEN
            RAISE EXCEPTION 'Official invoice payment bindings require READ COMMITTED.' USING ERRCODE='23514';
          END IF;
        END IF;
        IF p.id IS NULL OR i.id IS NULL OR p.client_id<>i.client_id OR p.transaction_id<>i.transaction_id
          OR p.currency<>i.currency OR NOT EXISTS (
            SELECT 1 FROM handyman_customer_transactions t JOIN handyman_execution_scopes s ON s.id=t.execution_scope_id
            WHERE t.id=p.transaction_id AND t.client_id=i.client_id AND s.id=i.execution_scope_id
              AND s.client_id=i.client_id AND s.building_id=i.building_id AND s.tenant_company_id=i.tenant_company_id
              AND s.handyman_request_id=i.request_id) THEN
          RAISE EXCEPTION 'Payment and official invoice scope, payer and currency must match.' USING ERRCODE='23514';
        END IF;
        SELECT bank_reference INTO bankref FROM handyman_payment_reconciliations WHERE payment_id=p.id AND client_id=p.client_id;
        IF p.external_reference IS NULL AND bankref IS NULL THEN
          RAISE EXCEPTION 'Official invoice payment requires a reported or independently reconciled reference.' USING ERRCODE='23514';
        END IF;
        PERFORM hm_payment_claim_reference(p.client_id,p.id,p.external_reference);
        PERFORM hm_payment_claim_reference(p.client_id,p.id,bankref);
        -- Refuse to reinterpret legacy allocations that do not fit the exact
        -- frozen invoice. Such funds remain visible for explicit correction.
        IF EXISTS (
          SELECT 1 FROM handyman_payment_allocations a
          WHERE a.payment_id=p.id AND NOT EXISTS (SELECT 1 FROM handyman_ledger_corrections c
            WHERE c.correction_kind='REVERSAL' AND c.source_allocation_id=a.id)
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.source_snapshot#>'{calculation,commercialSource,lines}') l
              WHERE l->>'chargeLineId'=a.charge_line_id::text)
        ) OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(i.source_snapshot#>'{calculation,commercialSource,lines}') l
          WHERE EXISTS (SELECT 1 FROM handyman_payment_allocations own WHERE own.payment_id=p.id
            AND own.charge_line_id::text=l->>'chargeLineId' AND NOT EXISTS
              (SELECT 1 FROM handyman_ledger_corrections x WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=own.id))
            AND (SELECT coalesce(sum(a.amount),0) FROM handyman_payment_allocations a
              WHERE a.transaction_id=i.transaction_id AND a.charge_line_id::text=l->>'chargeLineId' AND NOT EXISTS
                (SELECT 1 FROM handyman_ledger_corrections x WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=a.id))
              > (l->>'grossAmount')::numeric
        ) THEN
          RAISE EXCEPTION 'Pre-invoice allocations exceed or do not match the official invoice; explicit correction is required.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_official_invoice_payment_link BEFORE INSERT ON handyman_official_invoice_payment_links
        FOR EACH ROW EXECUTE FUNCTION hm_official_invoice_payment_link_guard();
      CREATE TRIGGER hm_official_invoice_payment_no_change BEFORE UPDATE OR DELETE ON handyman_official_invoice_payment_links
        FOR EACH ROW EXECUTE FUNCTION hm_payment_fact_immutable();
      CREATE TRIGGER hm_official_invoice_payment_no_truncate BEFORE TRUNCATE ON handyman_official_invoice_payment_links
        FOR EACH STATEMENT EXECUTE FUNCTION hm_payment_fact_immutable();
      CREATE FUNCTION hm_official_invoice_payment_auto_link() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE invoice uuid; sid uuid;
      BEGIN
        -- Use the issuer's ledger/fence ordering. A stale repeatable-read
        -- transaction must abort rather than miss a concurrently issued invoice.
        SELECT execution_scope_id INTO sid FROM handyman_customer_transactions WHERE id=NEW.transaction_id FOR UPDATE;
        PERFORM 1 FROM handyman_invoice_source_fences WHERE execution_scope_id=sid FOR UPDATE;
        SELECT id INTO invoice FROM handyman_official_invoices WHERE transaction_id=NEW.transaction_id;
        IF invoice IS NOT NULL THEN
          INSERT INTO handyman_official_invoice_payment_links(payment_id,invoice_id,linked_by_user_id)
            VALUES(NEW.id,invoice,NEW.recorded_by_user_id);
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_official_invoice_payment_auto_link AFTER INSERT ON handyman_customer_payments
        FOR EACH ROW EXECUTE FUNCTION hm_official_invoice_payment_auto_link();

      -- In addition to the existing confirmed-payment/payment-cap and REDUCE
      -- gates, all new invoice allocations must use this exact link and the
      -- frozen net gross for that line, including existing legacy allocations.
      CREATE FUNCTION hm_official_invoice_payment_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE invoice handyman_official_invoices%ROWTYPE; frozen numeric; applied numeric; sid uuid;
      BEGIN
        -- The earlier allocation trigger holds the ledger row; this source
        -- fence also detects an invoice issued after a repeatable-read snapshot.
        SELECT execution_scope_id INTO sid FROM handyman_customer_transactions WHERE id=NEW.transaction_id;
        PERFORM 1 FROM handyman_invoice_source_fences WHERE execution_scope_id=sid FOR UPDATE;
        SELECT * INTO invoice FROM handyman_official_invoices WHERE transaction_id=NEW.transaction_id;
        IF invoice.id IS NULL THEN RETURN NEW; END IF;
        IF current_setting('transaction_isolation') <> 'read committed' THEN
          RAISE EXCEPTION 'Official invoice allocations require READ COMMITTED.' USING ERRCODE='23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM handyman_official_invoice_payment_links
          WHERE payment_id=NEW.payment_id AND invoice_id=invoice.id) THEN
          RAISE EXCEPTION 'Payment must be bound to the exact official invoice before allocation.' USING ERRCODE='23514';
        END IF;
        SELECT (l->>'grossAmount')::numeric INTO frozen
          FROM jsonb_array_elements(invoice.source_snapshot#>'{calculation,commercialSource,lines}') l
          WHERE l->>'chargeLineId'=NEW.charge_line_id::text;
        IF frozen IS NULL THEN RAISE EXCEPTION 'Allocation must target an official invoice charge.' USING ERRCODE='23514'; END IF;
        SELECT coalesce(sum(a.amount),0) INTO applied FROM handyman_payment_allocations a
          WHERE a.transaction_id=NEW.transaction_id AND a.charge_line_id=NEW.charge_line_id AND NOT EXISTS
            (SELECT 1 FROM handyman_ledger_corrections c WHERE c.correction_kind='REVERSAL' AND c.source_allocation_id=a.id);
        IF applied+NEW.amount>frozen THEN
          RAISE EXCEPTION 'Allocation exceeds the official invoice net charge line.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_official_invoice_payment_allocation_guard BEFORE INSERT ON handyman_payment_allocations
        FOR EACH ROW EXECUTE FUNCTION hm_official_invoice_payment_allocation_guard();

      -- Read-only money projection. Unbound legacy facts remain explicit and
      -- never contribute to settled balance. Refunds/reversals reduce received
      -- funds; impossible/ambiguous correction histories fail closed.
      CREATE VIEW handyman_official_invoice_payment_status AS
      WITH per_payment AS (
        SELECT i.id AS invoice_id, p.id, p.status, p.amount, (l.payment_id IS NOT NULL) AS linked,
          coalesce((SELECT sum(a.amount) FROM handyman_payment_allocations a WHERE a.payment_id=p.id AND NOT EXISTS
            (SELECT 1 FROM handyman_ledger_corrections c WHERE c.correction_kind='REVERSAL' AND c.source_allocation_id=a.id)),0) AS applied,
          coalesce((SELECT sum(c.amount) FROM handyman_ledger_corrections c WHERE c.correction_kind='REFUND' AND c.source_payment_id=p.id),0) AS refunded,
          EXISTS(SELECT 1 FROM handyman_ledger_corrections c WHERE c.correction_kind='REVERSAL' AND c.source_kind='PAYMENT' AND c.source_payment_id=p.id) AS reversed
        FROM handyman_official_invoices i JOIN handyman_customer_payments p
          ON p.transaction_id=i.transaction_id AND p.client_id=i.client_id
        LEFT JOIN handyman_official_invoice_payment_links l ON l.payment_id=p.id AND l.invoice_id=i.id
      ), totals AS (
        SELECT invoice_id,
          coalesce(sum(greatest(applied-refunded,0)) FILTER (WHERE linked AND status='CONFIRMED' AND NOT reversed),0) AS paid,
          coalesce(sum(greatest(amount-refunded,0)) FILTER (WHERE linked AND status='CONFIRMED' AND NOT reversed),0) AS received,
          coalesce(sum(applied) FILTER (WHERE NOT linked AND status='CONFIRMED' AND NOT reversed),0) AS unlinked_applied,
          coalesce(sum(greatest(amount-refunded,0)) FILTER (WHERE NOT linked AND status='CONFIRMED' AND NOT reversed),0) AS unlinked_received,
          count(*) FILTER (WHERE NOT linked AND status='CONFIRMED' AND NOT reversed) AS unlinked_count,
          coalesce(bool_or((refunded>applied OR (reversed AND applied>0)) AND status='CONFIRMED'),false) AS inconsistent
        FROM per_payment GROUP BY invoice_id
      )
      SELECT i.id AS invoice_id, i.transaction_id, i.client_id, i.building_id, i.tenant_company_id, i.currency,
        i.total_amount AS invoice_total, coalesce(t.paid,0)::numeric(18,2) AS applied_amount,
        (i.total_amount-coalesce(t.paid,0))::numeric(18,2) AS outstanding_amount,
        coalesce(t.received,0)::numeric(18,2) AS verified_received_amount,
        greatest(coalesce(t.received,0)-coalesce(t.paid,0),0)::numeric(18,2) AS unallocated_verified_amount,
        greatest(coalesce(t.received,0)-i.total_amount,0)::numeric(18,2) AS excess_funds_amount,
        coalesce(t.unlinked_applied,0)::numeric(18,2) AS unlinked_allocation_amount,
        coalesce(t.unlinked_received,0)::numeric(18,2) AS unlinked_verified_amount,
        coalesce(t.unlinked_count,0) AS unlinked_verified_count,
        CASE WHEN coalesce(t.inconsistent,false) OR coalesce(t.unlinked_count,0)>0 OR coalesce(t.paid,0)>i.total_amount
             THEN 'RECONCILIATION_REQUIRED'
          WHEN coalesce(t.received,0)>i.total_amount THEN 'EXCESS_FUNDS'
          WHEN coalesce(t.paid,0)=i.total_amount AND i.total_amount>0 THEN 'PAID'
          WHEN coalesce(t.paid,0)>0 THEN 'PARTIALLY_PAID'
          ELSE 'UNPAID' END AS status
      FROM handyman_official_invoices i LEFT JOIN totals t ON t.invoice_id=i.id;
    `);
    await replaceReceiptInvoiceGuard(tx, true);
  },
  async down(tx: PoolClient): Promise<void> {
    // Removing an official binding would erase authoritative reference history.
    await tx.query(`LOCK TABLE handyman_official_invoice_payment_links IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM handyman_official_invoice_payment_links) OR EXISTS (
        SELECT 1 FROM handyman_tenant_payment_receipts r JOIN handyman_official_invoices i
          ON i.id::text=r.source_snapshot#>>'{reference,invoice,id}') THEN
        RAISE EXCEPTION 'Cannot remove official invoice payment or receipt bindings.'; END IF; END $$;`);
    await replaceReceiptInvoiceGuard(tx, false);
    await tx.query(`DROP VIEW handyman_official_invoice_payment_status;
      DROP TRIGGER hm_official_invoice_payment_allocation_guard ON handyman_payment_allocations;
      DROP FUNCTION hm_official_invoice_payment_allocation_guard();
      DROP TRIGGER hm_official_invoice_payment_auto_link ON handyman_customer_payments;
      DROP FUNCTION hm_official_invoice_payment_auto_link();
      DROP TABLE handyman_official_invoice_payment_links;
      DROP FUNCTION hm_official_invoice_payment_link_guard();
      DROP TRIGGER hm_payment_reference_claim ON handyman_customer_payments;
      DROP TRIGGER hm_reconciliation_reference_claim ON handyman_payment_reconciliations;
      DROP FUNCTION hm_payment_reference_insert_guard();
      DROP TABLE handyman_payment_reference_claims;
      DROP FUNCTION hm_payment_claim_reference(uuid,uuid,text);
      DROP FUNCTION hm_payment_fact_immutable();`);
  },
};
