import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-14K — Tenant Communication operational records.
 *
 * This stores communication content and traceable state only. It does not
 * implement transport, inbox synchronization, delivery providers, or a
 * generic messaging platform.
 */
export const migration0154CreateTenantCommunications: Migration = {
  id: '0154_create_tenant_communications',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_communications (
        id                         UUID PRIMARY KEY,
        client_id                  UUID NOT NULL REFERENCES clients (id),
        tenant_company_id          UUID NOT NULL REFERENCES tenant_companies (id),
        building_id                UUID REFERENCES buildings (id),
        sender_user_id             UUID NOT NULL REFERENCES users (id),
        recipient_tenant_pic_id    UUID REFERENCES tenant_pics (id),
        recipient_user_id          UUID REFERENCES users (id),
        communication_type         TEXT NOT NULL,
        subject                    TEXT NOT NULL,
        message_body               TEXT NOT NULL,
        related_type               TEXT,
        service_request_id         UUID REFERENCES tenant_service_requests (id),
        complaint_id               UUID REFERENCES tenant_complaints (id),
        utility_request_id         UUID REFERENCES tenant_utility_requests (id),
        document_id                UUID REFERENCES tenant_documents (id),
        status                     TEXT NOT NULL DEFAULT 'DRAFT',
        sent_at                    TIMESTAMPTZ,
        read_at                    TIMESTAMPTZ,
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_communication_recipient_required
          CHECK (
            recipient_tenant_pic_id IS NOT NULL
            OR recipient_user_id IS NOT NULL
          ),
        CONSTRAINT tenant_communication_related_type_check
          CHECK (
            related_type IS NULL
            OR related_type IN (
              'SERVICE_REQUEST', 'COMPLAINT', 'UTILITY_REQUEST', 'DOCUMENT'
            )
          ),
        CONSTRAINT tenant_communication_related_reference_check
          CHECK (
            (service_request_id IS NOT NULL)::int
            + (complaint_id IS NOT NULL)::int
            + (utility_request_id IS NOT NULL)::int
            + (document_id IS NOT NULL)::int <= 1
          ),
        CONSTRAINT tenant_communication_related_consistency_check
          CHECK (
            (related_type IS NULL
              AND service_request_id IS NULL AND complaint_id IS NULL
              AND utility_request_id IS NULL AND document_id IS NULL)
            OR (related_type = 'SERVICE_REQUEST' AND service_request_id IS NOT NULL)
            OR (related_type = 'COMPLAINT' AND complaint_id IS NOT NULL)
            OR (related_type = 'UTILITY_REQUEST' AND utility_request_id IS NOT NULL)
            OR (related_type = 'DOCUMENT' AND document_id IS NOT NULL)
          ),
        CONSTRAINT tenant_communication_status_check
          CHECK (status IN ('DRAFT', 'SENT', 'READ')),
        CONSTRAINT tenant_communication_status_time_check
          CHECK (
            (status = 'DRAFT' AND sent_at IS NULL AND read_at IS NULL)
            OR (status = 'SENT' AND sent_at IS NOT NULL AND read_at IS NULL)
            OR (status = 'READ' AND sent_at IS NOT NULL AND read_at IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE INDEX tenant_communications_tenant_idx
        ON tenant_communications (tenant_company_id, status, created_at);
      CREATE INDEX tenant_communications_building_idx
        ON tenant_communications (building_id, status, created_at);
      CREATE INDEX tenant_communications_recipient_pic_idx
        ON tenant_communications (recipient_tenant_pic_id, status, created_at);
      CREATE INDEX tenant_communications_recipient_user_idx
        ON tenant_communications (recipient_user_id, status, created_at);
      CREATE INDEX tenant_communications_related_idx
        ON tenant_communications (related_type, created_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_communications');
  },
};
