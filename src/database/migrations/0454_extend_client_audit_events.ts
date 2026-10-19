import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-CLIENT-MASTER-01 — Client registry audit vocabulary extension.
 *
 * Adds the two additive security events for the Client master:
 *
 *   - CLIENT_CREATED — a Client (top-level tenant/commercial boundary) was
 *                      registered, including the first-Client bootstrap;
 *   - CLIENT_UPDATED — an existing Client's mutable identity/status changed.
 *
 * Client code (`clients_code_unique`) is immutable after creation, so no
 * "renamed" event exists.
 *
 * No existing event type is removed or renamed; the column, its OUTCOME check
 * and every other constraint keep their original shape. The previous list is
 * migration 0453's vocabulary, reproduced exactly so this migration cannot
 * silently narrow the accepted set.
 */
const PREVIOUS_AUDIT_EVENT_TYPES = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGOUT',
  'INVITATION_CREATED',
  'INVITATION_ACCEPTED',
  'INVITATION_REVOKED',
  'ACCOUNT_DEACTIVATED',
  'ACCOUNT_REACTIVATED',
  'ACCOUNT_SUSPENDED',
  'OWNER_BOOTSTRAPPED',
  'PASSWORD_RESET',
  'PASSWORD_CHANGED',
  'ROLE_ASSIGNED',
  'ROLE_REVOKED',
  'BUILDING_ASSIGNED',
  'BUILDING_REVOKED',
] as const;

const CLIENT_AUDIT_EVENT_TYPES = [
  ...PREVIOUS_AUDIT_EVENT_TYPES,
  'CLIENT_CREATED',
  'CLIENT_UPDATED',
] as const;

function eventTypeCheck(values: readonly string[]): string {
  return `CHECK (event_type IN (${values
    .map((value) => `'${value}'`)
    .join(', ')}))`;
}

export const migration0454ExtendClientAuditEvents: Migration = {
  id: '0454_extend_client_audit_events',

  async up(client: PoolClient): Promise<void> {
    await client.query(
      'ALTER TABLE authentication_audit_events DROP CONSTRAINT authentication_audit_events_event_type_check',
    );
    await client.query(`
      ALTER TABLE authentication_audit_events
        ADD CONSTRAINT authentication_audit_events_event_type_check
        ${eventTypeCheck(CLIENT_AUDIT_EVENT_TYPES)}
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Audit history is append-only: rows are never deleted by a down
    // migration (same policy as 0452/0453). If CLIENT_* events already exist,
    // narrowing the CHECK fails loudly instead of destroying evidence.
    await client.query(
      'ALTER TABLE authentication_audit_events DROP CONSTRAINT authentication_audit_events_event_type_check',
    );
    await client.query(`
      ALTER TABLE authentication_audit_events
        ADD CONSTRAINT authentication_audit_events_event_type_check
        ${eventTypeCheck(PREVIOUS_AUDIT_EVENT_TYPES)}
    `);
  },
};
