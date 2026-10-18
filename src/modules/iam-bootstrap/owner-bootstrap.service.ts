import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import {
  PLATFORM_ADMIN_ROLE,
  seedFoundationAccess,
} from '../../database/seeds/foundation-access.seed';
import { insertAuditEvent } from '../audit';
import {
  credentialRepository,
  passwordService,
} from '../auth';
import {
  isValidEmail,
  normalizeDisplayName,
  normalizeEmail,
  userRepository,
} from '../users';
import {
  CANONICAL_ROLE_DEFINITIONS,
  CANONICAL_ROLE_PERMISSION_CODES,
  OWNER_ROLE_CODE,
} from './iam-canonical-roles';

/**
 * CR-HM-IAM-BOOTSTRAP-01 — one-time first-owner provisioning.
 *
 * OPERATOR-ONLY: this module is reachable exclusively through the database CLI
 * (`node dist/database/cli.js bootstrap-owner`). It is never mounted on the
 * HTTP application, so there is no public bootstrap endpoint to attack.
 *
 * Safety properties:
 *   - no default/hardcoded account; email and display name are supplied by the
 *     operator and the password is read interactively without echo,
 *   - no password ever enters argv, an environment variable, a log line or the
 *     audit metadata,
 *   - the database must be in the initial empty-user state,
 *   - the whole bootstrap (foundation permissions, PLATFORM_ADMIN, canonical
 *     persona roles, grants, owner user, credential, role assignment and the
 *     singleton proof row) is ONE transaction; any failure rolls everything
 *     back, so an interrupted run can simply be retried,
 *   - a completed bootstrap can never be repeated: the singleton
 *     `iam_bootstrap_state` row plus the empty-user and privileged-assignment
 *     preconditions make a second privileged account impossible,
 *   - nothing here creates a Client/Property/Building assignment, so the
 *     existing BE-02G tenant/Building isolation rules are untouched.
 */

/** Distinct from the migration advisory lock (724196031). */
const OWNER_BOOTSTRAP_LOCK_KEY = 724196032;
const BOOTSTRAP_STATE_ID = 'OWNER_BOOTSTRAP';

export type BootstrapErrorCode =
  | 'IAM_BOOTSTRAP_INVALID_EMAIL'
  | 'IAM_BOOTSTRAP_INVALID_DISPLAY_NAME'
  | 'IAM_BOOTSTRAP_SCHEMA_MISSING'
  | 'IAM_BOOTSTRAP_ALREADY_COMPLETED'
  | 'IAM_BOOTSTRAP_USERS_EXIST'
  | 'IAM_BOOTSTRAP_PRIVILEGED_ASSIGNMENTS_EXIST'
  | 'IAM_BOOTSTRAP_PERMISSION_MISSING'
  | 'IAM_BOOTSTRAP_ROLE_INACTIVE'
  | 'IAM_BOOTSTRAP_ROLE_MISSING';

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;

  constructor(code: BootstrapErrorCode, message: string) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
  }
}

export type BootstrapOwnerInput = {
  email: string;
  displayName: string;
  password: string;
};

export type BootstrapOwnerResult = {
  ownerUserId: string;
  email: string;
  displayName: string;
  roleCodes: readonly string[];
  effectivePermissionCount: number;
  canonicalRoleCodes: readonly string[];
  bootstrappedAt: string;
};

export type OwnerBootstrapStatus = {
  schemaReady: boolean;
  usersTableReady: boolean;
  completed: boolean;
  ownerUserId: string | null;
  ownerEmail: string | null;
  roleCodes: string[];
  bootstrappedAt: string | null;
  userCount: number;
};

function normalizeBootstrapEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    throw new BootstrapError(
      'IAM_BOOTSTRAP_INVALID_EMAIL',
      'A valid owner email address is required.',
    );
  }
  return normalized;
}

function normalizeBootstrapDisplayName(displayName: string): string {
  const normalized = normalizeDisplayName(displayName);
  if (normalized.length === 0) {
    throw new BootstrapError(
      'IAM_BOOTSTRAP_INVALID_DISPLAY_NAME',
      'An owner display name is required.',
    );
  }
  if (normalized.length > 128) {
    throw new BootstrapError(
      'IAM_BOOTSTRAP_INVALID_DISPLAY_NAME',
      'The owner display name must be at most 128 characters.',
    );
  }
  return normalized;
}

async function tableExists(
  client: PoolClient,
  name: string,
): Promise<boolean> {
  const result = await client.query<{ present: string | null }>(
    `SELECT to_regclass($1)::text AS present`,
    [`public.${name}`],
  );
  return result.rows[0]?.present !== null && result.rows[0]?.present !== undefined;
}

/**
 * Read-only status used by the runbook (`bootstrap-status`) and by tests.
 * It never mutates and never touches credentials.
 */
export async function getOwnerBootstrapStatus(): Promise<OwnerBootstrapStatus> {
  return withTransaction(async (client) => {
    const schemaReady = await tableExists(client, 'iam_bootstrap_state');
    const usersTableReady = await tableExists(client, 'users');

    let userCount = 0;
    if (usersTableReady) {
      const users = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM users',
      );
      userCount = Number(users.rows[0]?.count ?? '0');
    }

    if (!schemaReady) {
      return {
        schemaReady: false,
        usersTableReady,
        completed: false,
        ownerUserId: null,
        ownerEmail: null,
        roleCodes: [],
        bootstrappedAt: null,
        userCount,
      };
    }

    const state = await client.query<{
      ownerUserId: string;
      ownerEmail: string;
      roleCodes: string[];
      bootstrappedAt: Date;
    }>(
      `SELECT owner_user_id AS "ownerUserId",
              owner_email AS "ownerEmail",
              role_codes AS "roleCodes",
              bootstrapped_at AS "bootstrappedAt"
         FROM iam_bootstrap_state
        WHERE id = $1`,
      [BOOTSTRAP_STATE_ID],
    );
    const row = state.rows[0];

    return {
      schemaReady: true,
      usersTableReady,
      completed: Boolean(row),
      ownerUserId: row?.ownerUserId ?? null,
      ownerEmail: row?.ownerEmail ?? null,
      roleCodes: row?.roleCodes ?? [],
      bootstrappedAt: row?.bootstrappedAt.toISOString() ?? null,
      userCount,
    };
  });
}

/**
 * Creates the one and only first owner. Throws `BootstrapError` (or the
 * existing password-policy `AppError`) without leaving partial state.
 */
export async function bootstrapOwner(
  input: BootstrapOwnerInput,
): Promise<BootstrapOwnerResult> {
  const email = normalizeBootstrapEmail(input.email);
  const displayName = normalizeBootstrapDisplayName(input.displayName);

  // Existing policy + bcrypt implementation. `hashPassword` validates before
  // hashing and never logs the plaintext.
  const passwordHash = await passwordService.hashPassword(input.password);

  return withTransaction(async (client) => {
    // Serialize concurrent operator runs (transaction-scoped; released on
    // COMMIT/ROLLBACK).
    await client.query('SELECT pg_advisory_xact_lock($1)', [
      OWNER_BOOTSTRAP_LOCK_KEY,
    ]);

    if (!(await tableExists(client, 'iam_bootstrap_state'))) {
      throw new BootstrapError(
        'IAM_BOOTSTRAP_SCHEMA_MISSING',
        'iam_bootstrap_state is missing. Run the migration step first: node dist/database/cli.js migrate',
      );
    }

    const existingState = await client.query(
      'SELECT owner_user_id FROM iam_bootstrap_state WHERE id = $1',
      [BOOTSTRAP_STATE_ID],
    );
    if ((existingState.rowCount ?? 0) > 0) {
      throw new BootstrapError(
        'IAM_BOOTSTRAP_ALREADY_COMPLETED',
        'The first-owner bootstrap has already completed on this database. It cannot run again; manage further administrators through the authenticated user-management API.',
      );
    }

    // Block concurrent user inserts for the duration of the transaction, then
    // require the documented initial state.
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const users = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM users',
    );
    if (Number(users.rows[0]?.count ?? '0') > 0) {
      throw new BootstrapError(
        'IAM_BOOTSTRAP_USERS_EXIST',
        'The users table is not empty. Bootstrap is only valid on a fresh database with zero users.',
      );
    }

    const privilegedCodes = [
      OWNER_ROLE_CODE,
      ...CANONICAL_ROLE_DEFINITIONS.map((role) => role.code),
    ];
    const privilegedAssignments = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
        WHERE ura.status = 'ACTIVE'
          AND r.status = 'ACTIVE'
          AND r.code = ANY($1::text[])`,
      [privilegedCodes],
    );
    if (Number(privilegedAssignments.rows[0]?.count ?? '0') > 0) {
      throw new BootstrapError(
        'IAM_BOOTSTRAP_PRIVILEGED_ASSIGNMENTS_EXIST',
        'Privileged role assignments already exist. Refusing to create another privileged account.',
      );
    }

    // Authoritative foundation catalogue (idempotent, same transaction).
    await seedFoundationAccess(client);

    // Every code must already be registered — never invent a privilege.
    const registered = await client.query<{ code: string }>(
      `SELECT code FROM permissions
        WHERE status = 'ACTIVE' AND code = ANY($1::text[])`,
      [CANONICAL_ROLE_PERMISSION_CODES],
    );
    const registeredCodes = new Set(registered.rows.map((row) => row.code));
    const missing = CANONICAL_ROLE_PERMISSION_CODES.filter(
      (code) => !registeredCodes.has(code),
    );
    if (missing.length > 0) {
      throw new BootstrapError(
        'IAM_BOOTSTRAP_PERMISSION_MISSING',
        `The permission catalogue is incomplete; refusing to bootstrap. Missing: ${missing.join(', ')}. Apply all migrations first.`,
      );
    }

    for (const definition of CANONICAL_ROLE_DEFINITIONS) {
      await client.query(
        `INSERT INTO roles (id, code, name, description, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')
         ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), definition.code, definition.name, definition.description],
      );

      const roleResult = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM roles WHERE code = $1',
        [definition.code],
      );
      const role = roleResult.rows[0];
      if (!role) {
        throw new BootstrapError(
          'IAM_BOOTSTRAP_ROLE_MISSING',
          `Canonical role ${definition.code} could not be created.`,
        );
      }
      if (role.status !== 'ACTIVE') {
        throw new BootstrapError(
          'IAM_BOOTSTRAP_ROLE_INACTIVE',
          `Canonical role ${definition.code} exists but is not ACTIVE; refusing to grant it.`,
        );
      }

      for (const permissionCode of definition.permissions) {
        await client.query(
          `INSERT INTO role_permission_assignments (id, role_id, permission_id, status)
           SELECT $1, $2, p.id, 'ACTIVE'
             FROM permissions p
            WHERE p.code = $3 AND p.status = 'ACTIVE'
           ON CONFLICT (role_id, permission_id) WHERE status = 'ACTIVE' DO NOTHING`,
          [randomUUID(), role.id, permissionCode],
        );
      }
    }

    const ownerRole = await client.query<{ id: string }>(
      'SELECT id FROM roles WHERE code = $1 AND status = $2',
      [OWNER_ROLE_CODE, 'ACTIVE'],
    );
    const ownerRoleId = ownerRole.rows[0]?.id;
    if (!ownerRoleId) {
      throw new BootstrapError(
        'IAM_BOOTSTRAP_ROLE_MISSING',
        `The canonical owner role ${OWNER_ROLE_CODE} is missing after seeding.`,
      );
    }

    const owner = await userRepository.createUser(
      { email, displayName, status: 'ACTIVE' },
      client,
    );

    await credentialRepository.createForUser(
      { userId: owner.id, passwordHash, mustChangePassword: false },
      client,
    );

    await client.query(
      `INSERT INTO user_role_assignments (id, user_id, role_id, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [randomUUID(), owner.id, ownerRoleId],
    );

    const permissionCount = await client.query<{ count: string }>(
      `SELECT count(DISTINCT p.id)::text AS count
         FROM role_permission_assignments rpa
         JOIN permissions p ON p.id = rpa.permission_id
        WHERE rpa.role_id = $1
          AND rpa.status = 'ACTIVE'
          AND p.status = 'ACTIVE'`,
      [ownerRoleId],
    );

    const bootstrappedAt = new Date();
    await client.query(
      `INSERT INTO iam_bootstrap_state
         (id, owner_user_id, owner_email, role_codes, bootstrapped_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        BOOTSTRAP_STATE_ID,
        owner.id,
        owner.email,
        [OWNER_ROLE_CODE, ...CANONICAL_ROLE_DEFINITIONS.map((role) => role.code)],
        bootstrappedAt,
        JSON.stringify({
          source: 'CLI',
          ownerRole: OWNER_ROLE_CODE,
          canonicalRoles: CANONICAL_ROLE_DEFINITIONS.map((role) => role.code),
          foundationRole: PLATFORM_ADMIN_ROLE.code,
        }),
      ],
    );

    // Same transaction: the security event exists if and only if the
    // bootstrap committed. Metadata contains ids/codes only.
    await insertAuditEvent(
      {
        eventType: 'OWNER_BOOTSTRAPPED',
        outcome: 'SUCCESS',
        userId: owner.id,
        metadata: {
          source: 'CLI',
          ownerRole: OWNER_ROLE_CODE,
          canonicalRoles: CANONICAL_ROLE_DEFINITIONS.map((role) => role.code),
        },
      },
      client,
    );

    return {
      ownerUserId: owner.id,
      email: owner.email,
      displayName: owner.displayName,
      roleCodes: [OWNER_ROLE_CODE],
      effectivePermissionCount: Number(permissionCount.rows[0]?.count ?? '0'),
      canonicalRoleCodes: CANONICAL_ROLE_DEFINITIONS.map((role) => role.code),
      bootstrappedAt: bootstrappedAt.toISOString(),
    };
  });
}
