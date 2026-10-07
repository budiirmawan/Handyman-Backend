import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-HM-14 PART 03: append-only internal state, inclusion and
 * reconciliation assertions. No mutable status projection, disbursement,
 * external-statement authority, or writes to the ledger/entitlements.
 */
export const migration0418HandymanSettlementReconciliation: Migration = {
  id: '0418_handyman_settlement_reconciliation',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_settlement_units (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        transaction_id UUID NOT NULL UNIQUE,
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        currency VARCHAR(3) NOT NULL CHECK (currency IN (
          'IDR','USD','SGD','MYR','AUD','EUR','GBP','JPY','CNY')),
        idempotency_key TEXT NOT NULL UNIQUE
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        actor_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_settlement_tx_client_fk FOREIGN KEY (transaction_id,client_id)
          REFERENCES handyman_customer_transactions(id,client_id),
        CONSTRAINT hm_settlement_tx_currency_fk FOREIGN KEY (transaction_id,currency)
          REFERENCES handyman_customer_transactions(id,currency)
      )
    `);
    await client.query(`
      CREATE TABLE handyman_settlement_inclusions (
        id UUID PRIMARY KEY,
        unit_id UUID NOT NULL REFERENCES handyman_settlement_units(id),
        entitlement_id UUID NOT NULL UNIQUE REFERENCES handyman_entitlement_facts(id),
        amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
        idempotency_key TEXT NOT NULL UNIQUE
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        actor_user_id UUID NOT NULL REFERENCES users(id),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_settlement_inclusion_pair UNIQUE (unit_id,entitlement_id)
      )
    `);
    await client.query(`
      CREATE TABLE handyman_settlement_reconciliations (
        id UUID PRIMARY KEY,
        reconciliation_seq BIGSERIAL UNIQUE,
        unit_id UUID NOT NULL REFERENCES handyman_settlement_units(id),
        ledger_contract_version TEXT NOT NULL
          CHECK (ledger_contract_version = 'CR-HM-13-PART-06'),
        window_from TIMESTAMPTZ NOT NULL,
        window_to TIMESTAMPTZ NOT NULL CHECK (window_to > window_from),
        currency VARCHAR(3) NOT NULL CHECK (currency IN (
          'IDR','USD','SGD','MYR','AUD','EUR','GBP','JPY','CNY')),
        ledger_charged_net NUMERIC(18,2) NOT NULL CHECK (ledger_charged_net >= 0),
        ledger_applied NUMERIC(18,2) NOT NULL CHECK (ledger_applied >= 0),
        ledger_net_received NUMERIC(18,2) NOT NULL CHECK (ledger_net_received >= 0),
        entitlement_total NUMERIC(18,2) NOT NULL CHECK (entitlement_total >= 0),
        included_total NUMERIC(18,2) NOT NULL CHECK (included_total >= 0),
        outcome TEXT NOT NULL CHECK (outcome IN ('MATCHED','VARIANCE')),
        variance_cause TEXT NOT NULL CHECK (variance_cause IN (
          'NONE','INCLUSION_MISMATCH','LEDGER_BASIS_MISMATCH',
          'FUNDING_SHORTFALL','OPEN_EXCEPTION')),
        variance_amount NUMERIC(18,2) NOT NULL CHECK (variance_amount >= 0),
        idempotency_key TEXT NOT NULL UNIQUE
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        actor_user_id UUID NOT NULL REFERENCES users(id),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_settlement_reconciliation_outcome_check CHECK (
          (outcome='MATCHED' AND variance_cause='NONE' AND variance_amount=0
           AND included_total=entitlement_total
           AND entitlement_total=ledger_charged_net
           AND included_total<=ledger_applied
           AND included_total<=ledger_net_received)
          OR (outcome='VARIANCE' AND variance_cause<>'NONE'))
      )
    `);
    await client.query(`
      CREATE TABLE handyman_settlement_events (
        id UUID PRIMARY KEY,
        unit_id UUID NOT NULL REFERENCES handyman_settlement_units(id),
        state TEXT NOT NULL CHECK (state IN (
          'PAYABLE','INCLUDED_IN_SETTLEMENT','SETTLED')),
        reconciliation_id UUID REFERENCES handyman_settlement_reconciliations(id),
        idempotency_key TEXT NOT NULL UNIQUE
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        actor_user_id UUID NOT NULL REFERENCES users(id),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_settlement_one_transition UNIQUE (unit_id,state),
        CONSTRAINT hm_settlement_terminal_reconciliation CHECK (
          (state='SETTLED' AND reconciliation_id IS NOT NULL)
          OR (state<>'SETTLED' AND reconciliation_id IS NULL))
      )
    `);
    await client.query(`
      CREATE TABLE handyman_settlement_exceptions (
        id UUID PRIMARY KEY,
        unit_id UUID NOT NULL REFERENCES handyman_settlement_units(id),
        exception_kind TEXT NOT NULL CHECK (exception_kind IN (
          'REVERSED','ADJUSTED','DISPUTED')),
        ledger_correction_id UUID,
        amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
        idempotency_key TEXT NOT NULL UNIQUE
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        actor_user_id UUID NOT NULL REFERENCES users(id),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_settlement_exception_cause_check CHECK (
          (exception_kind='DISPUTED' AND ledger_correction_id IS NULL AND amount=0)
          OR (exception_kind<>'DISPUTED' AND ledger_correction_id IS NOT NULL AND amount>0))
      )
    `);
    await client.query(`
      CREATE TABLE handyman_settlement_command_keys (
        idempotency_key TEXT PRIMARY KEY
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        unit_id UUID NOT NULL REFERENCES handyman_settlement_units(id),
        action TEXT NOT NULL CHECK (action IN (
          'PREPARE','INCLUDE','RECONCILE','SETTLE','CORRECTION','DISPUTE')),
        result_id UUID NOT NULL,
        actor_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX hm_settlement_exception_one_cause
      ON handyman_settlement_exceptions(unit_id,ledger_correction_id)
      WHERE ledger_correction_id IS NOT NULL`);
    await client.query(`CREATE UNIQUE INDEX hm_settlement_one_open_dispute
      ON handyman_settlement_exceptions(unit_id) WHERE exception_kind='DISPUTED'`);

    // Consistency of the two FK-backed anchors. A client/currency check
    // is not a balance or eligibility decision; PART 03 commands own it.
    await client.query(`
      CREATE FUNCTION handyman_settlement_anchor_guard() RETURNS trigger AS $$
      DECLARE scope_id UUID; unit_tx UUID; unit_client UUID; unit_currency VARCHAR(3);
              fact_tx UUID; fact_client UUID; fact_currency VARCHAR(3);
      BEGIN
        IF TG_TABLE_NAME='handyman_settlement_units' THEN
          SELECT execution_scope_id INTO scope_id FROM handyman_customer_transactions
            WHERE id=NEW.transaction_id;
          IF scope_id IS DISTINCT FROM NEW.execution_scope_id THEN
            RAISE EXCEPTION 'Settlement transaction/scope mismatch.';
          END IF;
        ELSIF TG_TABLE_NAME='handyman_settlement_inclusions' THEN
          IF EXISTS(SELECT 1 FROM handyman_settlement_events
                    WHERE unit_id=NEW.unit_id AND state IN
                    ('INCLUDED_IN_SETTLEMENT','SETTLED')) THEN
            RAISE EXCEPTION 'Settlement inclusion is closed.';
          END IF;
          SELECT transaction_id,client_id,currency INTO unit_tx,unit_client,unit_currency
            FROM handyman_settlement_units WHERE id=NEW.unit_id;
          SELECT transaction_id,client_id,currency INTO fact_tx,fact_client,fact_currency
            FROM handyman_entitlement_facts WHERE id=NEW.entitlement_id;
          IF unit_tx IS DISTINCT FROM fact_tx OR unit_client IS DISTINCT FROM fact_client
             OR unit_currency IS DISTINCT FROM fact_currency THEN
            RAISE EXCEPTION 'Settlement inclusion crosses transaction/client/currency.';
          END IF;
        ELSIF TG_TABLE_NAME='handyman_settlement_events' THEN
          IF EXISTS(SELECT 1 FROM handyman_settlement_events
                    WHERE unit_id=NEW.unit_id AND state='SETTLED') THEN
            RAISE EXCEPTION 'SETTLED is terminal.';
          END IF;
          IF NEW.state='PAYABLE' THEN
            IF EXISTS(SELECT 1 FROM handyman_settlement_events
                      WHERE unit_id=NEW.unit_id) THEN
              RAISE EXCEPTION 'Settlement PAYABLE must be first.';
            END IF;
          ELSIF NEW.state='INCLUDED_IN_SETTLEMENT' THEN
            IF NOT EXISTS(SELECT 1 FROM handyman_settlement_events
                          WHERE unit_id=NEW.unit_id AND state='PAYABLE')
               OR (SELECT count(*) FROM handyman_settlement_inclusions
                   WHERE unit_id=NEW.unit_id) <> 2 THEN
              RAISE EXCEPTION 'Settlement inclusion requires PAYABLE and two facts.';
            END IF;
          ELSIF NEW.state='SETTLED' THEN
            IF NOT EXISTS(SELECT 1 FROM handyman_settlement_events
                          WHERE unit_id=NEW.unit_id AND state='INCLUDED_IN_SETTLEMENT')
               OR EXISTS(SELECT 1 FROM handyman_settlement_exceptions
                         WHERE unit_id=NEW.unit_id)
               OR NOT EXISTS(SELECT 1 FROM handyman_settlement_reconciliations
                          WHERE id=NEW.reconciliation_id AND unit_id=NEW.unit_id
                            AND outcome='MATCHED') THEN
              RAISE EXCEPTION 'Settlement requires inclusion and exact reconciliation without exceptions.';
            END IF;
          END IF;
        ELSIF TG_TABLE_NAME='handyman_settlement_reconciliations' THEN
          SELECT currency INTO unit_currency FROM handyman_settlement_units WHERE id=NEW.unit_id;
          IF unit_currency IS DISTINCT FROM NEW.currency THEN
            RAISE EXCEPTION 'Settlement reconciliation currency mismatch.';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of [
      'handyman_settlement_units', 'handyman_settlement_inclusions',
      'handyman_settlement_reconciliations', 'handyman_settlement_events',
    ]) {
      await client.query(`CREATE TRIGGER ${table}_anchor
        BEFORE INSERT ON ${table} FOR EACH ROW
        EXECUTE FUNCTION handyman_settlement_anchor_guard()`);
    }
    await client.query(`
      CREATE FUNCTION handyman_settlement_no_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman settlement history is append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of [
      'handyman_settlement_units', 'handyman_settlement_inclusions',
      'handyman_settlement_reconciliations', 'handyman_settlement_events',
      'handyman_settlement_exceptions', 'handyman_settlement_command_keys',
    ]) {
      await client.query(`CREATE TRIGGER ${table}_immutable
        BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW
        EXECUTE FUNCTION handyman_settlement_no_mutation()`);
    }
  },
  async down(client: PoolClient): Promise<void> {
    for (const table of [
      'handyman_settlement_command_keys', 'handyman_settlement_exceptions',
      'handyman_settlement_events', 'handyman_settlement_reconciliations',
      'handyman_settlement_inclusions',
      'handyman_settlement_units',
    ]) {
      await client.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await client.query('DROP FUNCTION IF EXISTS handyman_settlement_anchor_guard()');
    await client.query('DROP FUNCTION IF EXISTS handyman_settlement_no_mutation()');
  },
};
