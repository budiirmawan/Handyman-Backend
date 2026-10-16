import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Request-scoped, non-executable Care communication intake. */
export const migration0451HandymanCareCommunications: Migration = {
  id: '0451_handyman_care_communications',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_service_requests
        ADD CONSTRAINT handyman_service_requests_id_client_building_unique
        UNIQUE (id, client_id, building_id);
      CREATE TABLE handyman_care_communications (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        handyman_request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        purpose TEXT NOT NULL CHECK (purpose IN ('SERVICE_REQUEST_FOLLOW_UP','QUOTATION_RESPONSE_RECEIVED','VARIATION_RESPONSE_RECEIVED','BAST_CONFIRMATION_RECEIVED','PAYMENT_COMMUNICATION','WARRANTY_COMMUNICATION')),
        reported_contact_name TEXT NOT NULL CHECK (char_length(btrim(reported_contact_name)) BETWEEN 1 AND 200),
        reported_contact_reference TEXT CHECK (reported_contact_reference IS NULL OR char_length(reported_contact_reference) <= 200),
        channel TEXT NOT NULL CHECK (channel IN ('PHONE','EMAIL','IN_PERSON','MESSAGING','OTHER')),
        channel_reference TEXT CHECK (channel_reference IS NULL OR char_length(channel_reference) <= 200),
        statement TEXT NOT NULL CHECK (char_length(btrim(statement)) BETWEEN 1 AND 4000),
        reported_statement TEXT CHECK (reported_statement IS NULL OR reported_statement IN ('CONFIRM','REJECT','OTHER')),
        recorded_by_user_id UUID NOT NULL REFERENCES users(id),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        verification_state TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (verification_state = 'PENDING_VERIFICATION'),
        idempotency_key TEXT NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (recorded_by_user_id, idempotency_key),
        FOREIGN KEY (handyman_request_id, client_id, building_id)
          REFERENCES handyman_service_requests(id, client_id, building_id)
      );
      CREATE INDEX handyman_care_communications_request_idx
        ON handyman_care_communications (handyman_request_id, recorded_at DESC);
      CREATE TABLE handyman_care_communication_evidence (
        communication_id UUID NOT NULL REFERENCES handyman_care_communications(id),
        evidence_submission_id UUID NOT NULL REFERENCES evidence_submissions(id),
        PRIMARY KEY (communication_id, evidence_submission_id)
      );
      CREATE INDEX handyman_care_communication_evidence_submission_idx
        ON handyman_care_communication_evidence (evidence_submission_id);
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_care_communication_evidence; DROP TABLE IF EXISTS handyman_care_communications; ALTER TABLE handyman_service_requests DROP CONSTRAINT IF EXISTS handyman_service_requests_id_client_building_unique');
  },
};
