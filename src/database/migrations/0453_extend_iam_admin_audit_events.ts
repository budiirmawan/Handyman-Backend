import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-IAM-ADMIN-02 — IAM Admin audit vocabulary extension.
 *
 * Adds audit event types for the administrative IAM surfaces that were
 * missing durable security events:
 *
 *   - ROLE_ASSIGNED       — a role was granted to a user,
 *   - ROLE_REVOKED        — an active role assignment was removed,
 *   - BUILDING_ASSIGNED   — a user was granted access to a Building,
 *   - BUILDING_REVOKED    — a user's Building access was removed.
 *
 * No existing event type is removed or renamed; the column and its CHECK
 * constraint retain their original shape.
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
] as const;

const IAM_ADMIN_AUDIT_EVENT_TYPES = [
  ...PREVIOUS_AUDIT_EVENT_TYPES,
  'ROLE_ASSIGNED',
  'ROLE_REVOKED',
  'BUILDING_ASSIGNED',
  'BUILDING_REVOKED',
] as const;

function eventTypeCheck(values: readonly string[]): string {
  return `CHECK (event_type IN (${values
    .map((value) => `'${value}'`)
    .join(', ')}))`;
}

export const migration0453ExtendIamAdminAuditEvents: Migration = {
  id: '0453_extend_iam_admin_audit_events',

  async up(client: PoolClient): Promise<void> {
    await client.query(
      'ALTER TABLE authentication_audit_events DROP CONSTRAINT authentication_audit_events_event_type_check',
    );
    await client.query(`
      ALTER TABLE authentication_audit_events
        ADD CONSTRAINT authentication_audit_events_event_type_check
        ${eventTypeCheck(IAM_ADMIN_AUDIT_EVENT_TYPES)}
    `);
  },

  async down(client: PoolClient): Promise<void> {
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
