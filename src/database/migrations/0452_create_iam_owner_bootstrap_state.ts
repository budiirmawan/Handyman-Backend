import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-IAM-BOOTSTRAP-01 — First-owner bootstrap state + security audit
 * event vocabulary.
 *
 * `iam_bootstrap_state` is a SINGLETON proof row: exactly one first-owner
 * bootstrap may ever complete on a database. The fixed primary key plus the
 * CHECK constraint make a second row impossible even under a direct SQL
 * mistake, and the CLI/service additionally refuses to run when any user or
 * privileged assignment already exists.
 *
 * The row is written in the SAME transaction as the owner user, credential,
 * role and permission grants (see `owner-bootstrap.service.ts`). A crash or
 * error therefore leaves either the complete bootstrap or nothing at all —
 * there is no half-provisioned administrator to recover by hand.
 *
 * Audit vocabulary is extended additively for the new security events:
 *   - OWNER_BOOTSTRAPPED — one-time first-owner provisioning completed,
 *   - PASSWORD_RESET      — an administrator reset another account's password
 *                           (sessions are revoked by the application),
 *   - PASSWORD_CHANGED    — an authenticated user changed their own password.
 *
 * No existing event type is removed or renamed.
 */
export const IAM_AUDIT_EVENT_TYPES = [
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
] as const;

function eventTypeCheck(values: readonly string[]): string {
  return `CHECK (event_type IN (${values
    .map((value) => `'${value}'`)
    .join(', ')}))`;
}

export const migration0452CreateIamOwnerBootstrapState: Migration = {
  id: '0452_create_iam_owner_bootstrap_state',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE iam_bootstrap_state (
        id TEXT PRIMARY KEY,
        owner_user_id UUID NOT NULL,
        owner_email TEXT NOT NULL,
        role_codes TEXT[] NOT NULL DEFAULT '{}'::text[],
        bootstrapped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT iam_bootstrap_state_singleton_check
          CHECK (id = 'OWNER_BOOTSTRAP'),
        CONSTRAINT iam_bootstrap_state_owner_user_id_fkey
          FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT
      )
    `);

    await client.query(
      'ALTER TABLE authentication_audit_events DROP CONSTRAINT authentication_audit_events_event_type_check',
    );
    await client.query(`
      ALTER TABLE authentication_audit_events
        ADD CONSTRAINT authentication_audit_events_event_type_check
        ${eventTypeCheck(IAM_AUDIT_EVENT_TYPES)}
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS iam_bootstrap_state');

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
