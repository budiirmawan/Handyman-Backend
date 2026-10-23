import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-IAM-PERMISSION-REVOCATION-01 — role-permission grant audit
 * vocabulary extension.
 *
 * Adds audit event types for the role-permission grant lifecycle that backs
 * `DELETE /api/v1/roles/:roleId/permissions/:permissionId`:
 *
 *   - PERMISSION_GRANTED  — a permission grant was created on a role,
 *   - PERMISSION_REVOKED  — an ACTIVE role-permission grant was revoked.
 *
 * No existing event type is removed or renamed; the column and its CHECK
 * constraint retain their original shape. Follows the additive pattern of
 * migrations 0453/0454/0457.
 *
 * Numbering note: 0461–0467 are reserved by CR-HM-WORKER-COMPETENCY-01
 * (PR #55); this migration takes 0468 so the two change sets never collide.
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
  'CLIENT_CREATED',
  'CLIENT_UPDATED',
  'TENANT_IMPORT_UPLOADED',
  'TENANT_IMPORT_VALIDATED',
  'TENANT_IMPORT_CONFIRMED',
  'TENANT_IMPORT_COMMITTED',
  'TENANT_IMPORT_ABORTED',
  'TENANT_VERIFICATION_UPDATED',
] as const;

const PERMISSION_GRANT_AUDIT_EVENT_TYPES = [
  ...PREVIOUS_AUDIT_EVENT_TYPES,
  'PERMISSION_GRANTED',
  'PERMISSION_REVOKED',
] as const;

function eventTypeCheck(values: readonly string[]): string {
  return `CHECK (event_type IN (${values
    .map((value) => `'${value}'`)
    .join(', ')}))`;
}

export const migration0468ExtendPermissionGrantAuditEvents: Migration = {
  id: '0468_extend_permission_grant_audit_events',

  async up(client: PoolClient): Promise<void> {
    await client.query(
      'ALTER TABLE authentication_audit_events DROP CONSTRAINT authentication_audit_events_event_type_check',
    );
    await client.query(`
      ALTER TABLE authentication_audit_events
        ADD CONSTRAINT authentication_audit_events_event_type_check
        ${eventTypeCheck(PERMISSION_GRANT_AUDIT_EVENT_TYPES)}
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
