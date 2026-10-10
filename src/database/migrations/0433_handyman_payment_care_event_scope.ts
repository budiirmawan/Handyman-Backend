import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-CUSTOMER-PAYMENT-REPORT-01 PART 06 — payment event identity scope.
 *
 * PART 05 made `handyman_customer_payment_events.actor_type` exclusive
 * (USER xor CARE_ACTOR) but still allowed ANY event_type with a CARE_ACTOR
 * actor. A Customer Care actor may only record a payment claim
 * (RECORD_PAYMENT). CONFIRM/REJECT stay User-only, enforced structurally.
 *
 * Forward-only; no existing rows can violate it because PART 05 only ever
 * wrote RECORD_PAYMENT events for CARE_ACTOR.
 */
export const migration0433HandymanPaymentCareEventScope: Migration = {
  id: '0433_handyman_payment_care_event_scope',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_customer_payment_events
        ADD CONSTRAINT handyman_customer_payment_events_care_event_check CHECK (
          actor_type = 'USER' OR event_type = 'RECORD_PAYMENT'
        );
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_customer_payment_events
        DROP CONSTRAINT IF EXISTS handyman_customer_payment_events_care_event_check;
    `);
  },
};
