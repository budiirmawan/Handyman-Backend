import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * W02 PART 03 — Reporter identity, contact & request provenance.
 *
 * `handyman_service_request_contacts` is an ADDITIVE, append-only snapshot of
 * the people recorded by Customer Care at intake. It is deliberately separate
 * from:
 *   - the immutable channel attribution (never mutated),
 *   - the request row and its C6 projections (unchanged), and
 *   - tenant PIC / User / permission tables (no FK, no write).
 *
 * Roles recorded as data only (none of them grants authority):
 *   - reporter        : the person who conveyed the request (name required);
 *   - contact person  : an optional person to coordinate with (name plus phone
 *                       or email).
 * The PIC approval authority of a Tenant Company stays with tenant_pics and the
 * quotation approval rules. This table never resolves to it.
 *
 * Provenance: `captured_by_care_actor_id` (the attested Customer Care actor
 * that recorded the snapshot), `captured_at` (database clock) and the immutable
 * `channel_attribution_id`. Rows are append-only: UPDATE and DELETE are blocked.
 */
export const migration0435HandymanServiceRequestContacts: Migration = {
  id: '0435_handyman_service_request_contacts',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_service_request_contacts (
        id                       UUID PRIMARY KEY,
        handyman_request_id      UUID NOT NULL UNIQUE
          REFERENCES handyman_service_requests (id),
        channel_attribution_id   UUID NOT NULL
          REFERENCES handyman_channel_attributions (id),
        reporter_name            VARCHAR(120) NOT NULL,
        reporter_phone           VARCHAR(16),
        reporter_email           VARCHAR(254),
        contact_person_name      VARCHAR(120),
        contact_person_phone     VARCHAR(16),
        contact_person_email     VARCHAR(254),
        captured_by_care_actor_id UUID NOT NULL
          REFERENCES handyman_handoff_care_actors (id),
        captured_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

        CONSTRAINT handyman_request_contacts_reporter_name_check
          CHECK (char_length(btrim(reporter_name)) BETWEEN 1 AND 120),
        CONSTRAINT handyman_request_contacts_reporter_phone_check
          CHECK (reporter_phone IS NULL OR reporter_phone ~ '^[+]?[0-9]{6,15}$'),
        CONSTRAINT handyman_request_contacts_reporter_email_check
          CHECK (reporter_email IS NULL OR (char_length(reporter_email) BETWEEN 3 AND 254
            AND reporter_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')),
        CONSTRAINT handyman_request_contacts_person_phone_check
          CHECK (contact_person_phone IS NULL OR contact_person_phone ~ '^[+]?[0-9]{6,15}$'),
        CONSTRAINT handyman_request_contacts_person_email_check
          CHECK (contact_person_email IS NULL OR (char_length(contact_person_email) BETWEEN 3 AND 254
            AND contact_person_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')),
        CONSTRAINT handyman_request_contacts_person_complete_check
          CHECK (
            (contact_person_name IS NULL AND contact_person_phone IS NULL AND contact_person_email IS NULL)
            OR (contact_person_name IS NOT NULL
              AND char_length(btrim(contact_person_name)) BETWEEN 1 AND 120
              AND (contact_person_phone IS NOT NULL OR contact_person_email IS NOT NULL))
          )
      )
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_service_request_contacts_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman request contact snapshots are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_service_request_contacts_no_update
        BEFORE UPDATE ON handyman_service_request_contacts
        FOR EACH ROW EXECUTE FUNCTION handyman_service_request_contacts_block_mutation()
    `);
    await client.query(`
      CREATE TRIGGER handyman_service_request_contacts_no_delete
        BEFORE DELETE ON handyman_service_request_contacts
        FOR EACH ROW EXECUTE FUNCTION handyman_service_request_contacts_block_mutation()
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_service_request_contacts CASCADE');
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_service_request_contacts_block_mutation() CASCADE',
    );
  },
};
