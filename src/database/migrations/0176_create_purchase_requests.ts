import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-17A — Purchase Request Foundation.
 *
 * A Purchase Request is a lightweight operational procurement intake record
 * (BE-17). It is deliberately NOT a procurement ERP: it captures intake and
 * basic state only and carries no approval, vendor selection, purchase order,
 * receiving, or payment/accounting concerns — those belong to later BE-17
 * PARTs.
 *
 * It reuses the existing User / Building context: `client_id` is stored
 * directly but derived authoritatively by the service from Building →
 * Property → Client, so isolation can never drift from BE-02. `request_type`
 * is a data-driven code string (never a hardcoded model). `priority` mirrors
 * the BE-08 Work Order priority set. `requested_at` defaults to the creation
 * time.
 *
 * Request numbers are unique within a Client (`(client_id, request_number)`),
 * consistent with the Work Request / Vendor / Inventory Item patterns.
 */
export const migration0176CreatePurchaseRequests: Migration = {
  id: '0176_create_purchase_requests',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE purchase_requests (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        request_number        TEXT NOT NULL,
        requester_reference   TEXT,
        request_type          TEXT NOT NULL,
        title                 TEXT NOT NULL,
        description           TEXT,
        required_date         TIMESTAMPTZ,
        priority              TEXT NOT NULL DEFAULT 'MEDIUM',
        status                TEXT NOT NULL DEFAULT 'OPEN',
        requested_by_user_id  UUID NOT NULL REFERENCES users (id),
        requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT purchase_request_status
          CHECK (status IN ('OPEN', 'CANCELLED')),
        CONSTRAINT purchase_request_priority
          CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        CONSTRAINT purchase_request_number_unique
          UNIQUE (client_id, request_number)
      )
    `);

    await client.query(`
      CREATE INDEX purchase_requests_client_idx
        ON purchase_requests (client_id, status, requested_at);
      CREATE INDEX purchase_requests_building_idx
        ON purchase_requests (building_id, status, requested_at);
      CREATE INDEX purchase_requests_requester_idx
        ON purchase_requests (requested_by_user_id, status);
      CREATE INDEX purchase_requests_request_type_idx
        ON purchase_requests (request_type, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS purchase_requests');
  },
};
