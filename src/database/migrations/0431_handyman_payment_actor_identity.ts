import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-CUSTOMER-PAYMENT-REPORT-01 PART 05 — auditable, comparable actor
 * identity for customer payment reports and their evidence events.
 *
 * A payment reporter is EITHER a User (existing authority, unchanged) OR a
 * Customer Care actor acting through a workspace session. The two identities
 * live in separate namespaces; exactly one is set per row, enforced by CHECK.
 * Existing rows are USER rows and keep their identity unchanged.
 *
 * The verifier/decider identity stays User-only (`decided_by_user_id`,
 * `actor_user_id` on CONFIRM/REJECT). The immutability guard is extended so the
 * recorder identity can never be rewritten after the fact.
 */
export const migration0431HandymanPaymentActorIdentity: Migration = {
  id: '0431_handyman_payment_actor_identity',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_customer_payments
        ADD COLUMN recorded_by_actor_type TEXT NOT NULL DEFAULT 'USER',
        ADD COLUMN recorded_by_care_actor_id UUID
          REFERENCES handyman_handoff_care_actors (id),
        ADD COLUMN recorded_by_workspace_session_id UUID
          REFERENCES handyman_care_workspace_sessions (id),
        ALTER COLUMN recorded_by_user_id DROP NOT NULL,
        ADD CONSTRAINT handyman_customer_payments_recorder_identity_check CHECK (
          (recorded_by_actor_type = 'USER'
            AND recorded_by_user_id IS NOT NULL
            AND recorded_by_care_actor_id IS NULL
            AND recorded_by_workspace_session_id IS NULL)
          OR (recorded_by_actor_type = 'CARE_ACTOR'
            AND recorded_by_user_id IS NULL
            AND recorded_by_care_actor_id IS NOT NULL
            AND recorded_by_workspace_session_id IS NOT NULL));

      ALTER TABLE handyman_customer_payment_events
        ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'USER',
        ADD COLUMN actor_care_actor_id UUID
          REFERENCES handyman_handoff_care_actors (id),
        ADD COLUMN actor_workspace_session_id UUID
          REFERENCES handyman_care_workspace_sessions (id),
        ALTER COLUMN actor_user_id DROP NOT NULL,
        ADD CONSTRAINT handyman_customer_payment_events_actor_identity_check CHECK (
          (actor_type = 'USER'
            AND actor_user_id IS NOT NULL
            AND actor_care_actor_id IS NULL
            AND actor_workspace_session_id IS NULL)
          OR (actor_type = 'CARE_ACTOR'
            AND actor_user_id IS NULL
            AND actor_care_actor_id IS NOT NULL
            AND actor_workspace_session_id IS NOT NULL));

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
           OR NEW.provider_name IS DISTINCT FROM OLD.provider_name
           OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
           OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
           OR NEW.received_at IS DISTINCT FROM OLD.received_at
           OR NEW.recorded_by_user_id IS DISTINCT FROM OLD.recorded_by_user_id
           OR NEW.recorded_by_actor_type IS DISTINCT FROM OLD.recorded_by_actor_type
           OR NEW.recorded_by_care_actor_id IS DISTINCT FROM OLD.recorded_by_care_actor_id
           OR NEW.recorded_by_workspace_session_id IS DISTINCT FROM OLD.recorded_by_workspace_session_id
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
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_customer_payment_events
        DROP CONSTRAINT handyman_customer_payment_events_actor_identity_check,
        DROP COLUMN actor_workspace_session_id,
        DROP COLUMN actor_care_actor_id,
        DROP COLUMN actor_type;
      ALTER TABLE handyman_customer_payments
        DROP CONSTRAINT handyman_customer_payments_recorder_identity_check,
        DROP COLUMN recorded_by_workspace_session_id,
        DROP COLUMN recorded_by_care_actor_id,
        DROP COLUMN recorded_by_actor_type;
    `);
  },
};
