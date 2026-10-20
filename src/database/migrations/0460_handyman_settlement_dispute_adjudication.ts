import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-18 SETTLEMENT-DISPUTE-ADJUDICATION-01 (J12 closure).
 *
 * CR-HM-14 PART 03 could OPEN a settlement dispute hold
 * (`handyman_settlement_exceptions.exception_kind = 'DISPUTED'`) but had no
 * way to close one: the matrix recorded "dispute clearing/adjudication
 * MISSING — deliberately not invented" and every downstream gate
 * (include/settle/final close) stayed blocked forever once a hold existed.
 *
 * This migration adds the append-only adjudication fact, not a mutation:
 *
 *   handyman_settlement_dispute_resolutions
 *     exception_id (UNIQUE) → the DISPUTED exception being adjudicated
 *     outcome ∈ ('RELEASED', 'UPHELD')
 *       RELEASED — the dispute is cleared; the hold stops blocking
 *                  include/settle/final close. No financial fact changes.
 *       UPHELD   — the dispute is sustained; the hold keeps blocking.
 *     note, resolved_by_user_id, idempotency_key, occurred_at
 *
 * Laws preserved:
 *   - the 0418 exception tables stay append-only and untouched;
 *   - exactly one adjudication per dispute (UNIQUE exception_id);
 *   - the adjudication itself is append-only (trigger);
 *   - `handyman_settlement_command_keys.action` gains the single new
 *     action `DISPUTE_RESOLUTION` (bounded re-add of the 0418 CHECK).
 */
export const migration0460HandymanSettlementDisputeAdjudication: Migration = {
  id: '0460_handyman_settlement_dispute_adjudication',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_settlement_dispute_resolutions (
        id                    UUID PRIMARY KEY,
        unit_id               UUID NOT NULL
          REFERENCES handyman_settlement_units (id),
        exception_id          UUID NOT NULL
          REFERENCES handyman_settlement_exceptions (id),
        outcome               TEXT NOT NULL,
        note                  TEXT NOT NULL,
        resolved_by_user_id   UUID NOT NULL REFERENCES users (id),
        idempotency_key       VARCHAR(200) NOT NULL,
        occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_settlement_dispute_resolutions_outcome_check
          CHECK (outcome IN ('RELEASED', 'UPHELD')),
        CONSTRAINT handyman_settlement_dispute_resolutions_note_check
          CHECK (char_length(btrim(note)) BETWEEN 1 AND 500),
        CONSTRAINT handyman_settlement_dispute_resolutions_key_check
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_settlement_dispute_resolutions_exception_unique
          UNIQUE (exception_id),
        CONSTRAINT handyman_settlement_dispute_resolutions_key_unique
          UNIQUE (idempotency_key)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_settlement_dispute_resolutions_unit_idx
        ON handyman_settlement_dispute_resolutions (unit_id, occurred_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_settlement_dispute_resolutions_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman settlement dispute resolutions are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_settlement_dispute_resolutions_no_update
        BEFORE UPDATE ON handyman_settlement_dispute_resolutions
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_settlement_dispute_resolutions_block_mutation()
    `);
    await client.query(`
      CREATE TRIGGER handyman_settlement_dispute_resolutions_no_delete
        BEFORE DELETE ON handyman_settlement_dispute_resolutions
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_settlement_dispute_resolutions_block_mutation()
    `);

    // The 0418 SETTLED guard counted *every* exception row, so a released
    // dispute could never be settled even though the service considered the
    // hold clear. Replace only that predicate: RELEASED disputes stop
    // blocking; UPHELD disputes and all REVERSED/ADJUSTED exceptions keep
    // blocking exactly as before. No table is altered and no historical row
    // is rewritten.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_settlement_anchor_guard()
      RETURNS trigger AS $$
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
               OR EXISTS(SELECT 1 FROM handyman_settlement_exceptions se
                         WHERE se.unit_id=NEW.unit_id
                           AND NOT EXISTS (
                             SELECT 1 FROM handyman_settlement_dispute_resolutions r
                              WHERE r.exception_id=se.id AND r.outcome='RELEASED'
                           ))
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

    // Bounded action vocabulary: add the adjudication action only. The 0418
    // CHECK is an inline column constraint, so its generated name is
    // discovered rather than assumed (nothing is dropped unless it is the
    // settlement action vocabulary).
    await client.query(`
      DO $$
      DECLARE constraint_name TEXT;
      BEGIN
        FOR constraint_name IN
          SELECT conname FROM pg_constraint
           WHERE conrelid = 'handyman_settlement_command_keys'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%DISPUTE%'
        LOOP
          EXECUTE format(
            'ALTER TABLE handyman_settlement_command_keys DROP CONSTRAINT %I',
            constraint_name
          );
        END LOOP;
      END
      $$;
    `);
    await client.query(`
      ALTER TABLE handyman_settlement_command_keys
        ADD CONSTRAINT handyman_settlement_command_keys_action_check
        CHECK (action IN (
          'PREPARE', 'INCLUDE', 'RECONCILE', 'SETTLE', 'CORRECTION',
          'DISPUTE', 'DISPUTE_RESOLUTION'
        ))
    `);
  },
  async down(client: PoolClient): Promise<void> {
    // Restore the exact 0418 predicate (every exception row blocks SETTLED).
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_settlement_anchor_guard()
      RETURNS trigger AS $$
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

    await client.query(`
      DO $$
      DECLARE constraint_name TEXT;
      BEGIN
        FOR constraint_name IN
          SELECT conname FROM pg_constraint
           WHERE conrelid = 'handyman_settlement_command_keys'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%DISPUTE%'
        LOOP
          EXECUTE format(
            'ALTER TABLE handyman_settlement_command_keys DROP CONSTRAINT %I',
            constraint_name
          );
        END LOOP;
      END
      $$;
    `);
    await client.query(`
      ALTER TABLE handyman_settlement_command_keys
        ADD CONSTRAINT handyman_settlement_command_keys_action_check
        CHECK (action IN (
          'PREPARE', 'INCLUDE', 'RECONCILE', 'SETTLE', 'CORRECTION',
          'DISPUTE'
        ))
    `);
    await client.query(
      'DROP TABLE IF EXISTS handyman_settlement_dispute_resolutions CASCADE',
    );
  },
};
