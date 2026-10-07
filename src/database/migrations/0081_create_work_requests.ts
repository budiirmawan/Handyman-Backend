import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-08A — Work Request Foundation.
 *
 * A Work Request is an operational request for work captured BEFORE a formal
 * Work Order is created. It is deliberately lightweight: intake and basic
 * state only (OPEN / CANCELLED / CONVERTED). It carries no Asset, priority,
 * assignee, execution, evidence, or lifecycle concerns — those belong to
 * BE-08B+.
 *
 * `request_type` is a data-driven code string (no Engineering-, Housekeeping-,
 * or Security-specific model). Client ownership is stored directly but derived
 * authoritatively by the service from Building → Property → Client, so
 * isolation can never drift from BE-02.
 *
 * Request numbers are unique within a Client (`(client_id, request_number)`),
 * which is the appropriate uniqueness scope for an operational request code.
 */
export const migration0081CreateWorkRequests: Migration = {
  id: '0081_create_work_requests',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE work_requests (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        building_id UUID NOT NULL REFERENCES buildings (id),
        request_number TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        request_type TEXT NOT NULL,
        requested_by_user_id UUID NOT NULL REFERENCES users (id),
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'OPEN',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT work_request_status
          CHECK (status IN ('OPEN', 'CANCELLED', 'CONVERTED')),
        CONSTRAINT work_request_number_unique
          UNIQUE (client_id, request_number)
      )
    `);

    await client.query(`
      CREATE INDEX work_requests_client_idx
        ON work_requests (client_id, status, requested_at);
      CREATE INDEX work_requests_building_idx
        ON work_requests (building_id, status, requested_at);
      CREATE INDEX work_requests_requester_idx
        ON work_requests (requested_by_user_id, status);
      CREATE INDEX work_requests_request_type_idx
        ON work_requests (request_type, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS work_requests');
  },
};
