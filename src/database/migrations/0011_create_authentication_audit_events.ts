import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-01H — Authentication audit & security.
 *
 * Append-oriented security event history, separate from BE-00 application
 * logging. user_id/actor_user_id are nullable because some events (e.g. a
 * failed login for an unknown email) occur before user resolution. session_id
 * and request_id are correlation identifiers, not secrets.
 */
export const migration0011CreateAuthenticationAuditEvents: Migration = {
  id: '0011_create_authentication_audit_events',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE authentication_audit_events (
        id UUID PRIMARY KEY,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        user_id UUID,
        actor_user_id UUID,
        session_id UUID,
        request_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT authentication_audit_events_event_type_check
          CHECK (event_type IN (
            'LOGIN_SUCCESS',
            'LOGIN_FAILED',
            'LOGOUT',
            'INVITATION_CREATED',
            'INVITATION_ACCEPTED',
            'INVITATION_REVOKED',
            'ACCOUNT_DEACTIVATED',
            'ACCOUNT_REACTIVATED',
            'ACCOUNT_SUSPENDED'
          )),
        CONSTRAINT authentication_audit_events_outcome_check
          CHECK (outcome IN ('SUCCESS', 'FAILURE')),
        CONSTRAINT authentication_audit_events_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT authentication_audit_events_actor_user_id_fkey
          FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
      )
    `);

    await client.query(
      'CREATE INDEX authentication_audit_events_created_at_idx ON authentication_audit_events (created_at)',
    );
    await client.query(
      'CREATE INDEX authentication_audit_events_user_id_idx ON authentication_audit_events (user_id)',
    );
    await client.query(
      'CREATE INDEX authentication_audit_events_event_type_idx ON authentication_audit_events (event_type)',
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS authentication_audit_events');
  },
};
