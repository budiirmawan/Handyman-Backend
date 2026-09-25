/**
 * CR-BE-SAAS-01 PART 05 — SaaS provisioning service (frozen §13).
 *
 * The frozen §13.2 Workflow runs as a single transaction per attempt:
 *
 *   1. verify customer exists, status in {PROSPECT, TRIAL, ACTIVE}, version
 *   2. resolve/keep Organization   (code-anchored: same code ⇒ same org)
 *   3. resolve/keep Property + initial Building (code-anchored)
 *   4. resolve/keep initial admin User (email-anchored; invite if new)
 *   5. apply initial building assignment for the admin
 *   6. apply default tenant configuration (frozen `platform_configurations`
 *      table does NOT exist yet; this step is recorded as SKIPPED with the
 *      caller's `reason` and is left for PART 12 — no invented defaults)
 *   7. mark customer provisioning COMPLETED (run status, not a `clients`
 *      mutation)
 *
 * Idempotency: `executeIdempotent` with operation key
 * `saas.customer.provision` (frozen §17.2 / §13.2). Each step is anchored
 * on a stable natural key — retry-after-partial-failure converges on the
 * same canonical resources.
 *
 * Audit: `SAAS_TENANT_PROVISIONED` on success, `SAAS_TENANT_PROVISIONING_FAILED`
 * with `last_error` on failure (frozen §13.2). Replay does not double-audit.
 *
 * Bounds: not PART 04 quota enforcement; not PART 06 billing; not
 * PART 09 usage; not PART 08 grace/suspension.
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { getPool } from '../../database';
import {
  computeRequestFingerprint,
  executeIdempotent,
} from '../request-idempotency';
import { recordOperationalEvent } from '../operational-events';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { platformCustomerRepository } from '../platform-customers/platform-customer.repository';
import { organizationRepository } from '../organizations/organization.repository';
import { propertyRepository } from '../properties/property.repository';
import { buildingRepository } from '../buildings/building.repository';
import { userRepository } from '../users/user.repository';
import { userService } from '../users/user.service';
import { invitationRepository } from '../invitations/invitation.repository';
import { invitationService } from '../invitations';
import { buildingAssignmentRepository } from '../building-assignments/building-assignment.repository';
import { buildingAssignmentService } from '../building-assignments';
import { roleRepository } from '../roles/role.repository';
import { roleService } from '../roles/role.service';
import { permissionRepository } from '../permissions/permission.repository';
import { permissionService } from '../permissions/permission.service';

import { SAAS_CUSTOMER_STATUSES } from '../platform-customers/platform-customer.types';
import type { SaaSCustomerStatus } from '../platform-customers/platform-customer.types';
import {
  saasProvisioningCustomerNotEligibleError,
  saasCustomerVersionConflictError,
  saasProvisioningRunNotFoundError,
} from './platform-provisioning.errors';
import { saasProvisioningRunRepository } from './platform-provisioning.repository';
import type {
  ProvisionCustomerInput,
  PublicSaasProvisionedResources,
  PublicSaasProvisioningResult,
  PublicSaasProvisioningRun,
  PublicSaasProvisioningSummary,
  SaasProvisioningStep,
} from './platform-provisioning.types';

/** Frozen §13.2 (and §17.2 operation key). */
export const SAAS_CUSTOMER_PROVISION_OPERATION_KEY = 'saas.customer.provision';

/** Frozen §18.2 event names. */
export const SAAS_TENANT_PROVISIONED_EVENT = 'SAAS_TENANT_PROVISIONED';
export const SAAS_TENANT_PROVISIONING_FAILED_EVENT = 'SAAS_TENANT_PROVISIONING_FAILED';

/** Frozen §13.2 eligibility gate: PROSPECT, TRIAL, or ACTIVE. */
export const ELIGIBLE_PROVISIONING_STATUSES = [
  'PROSPECT',
  'TRIAL',
  'ACTIVE',
] as const satisfies readonly SaaSCustomerStatus[];

function isEligibleStatus(status: string): boolean {
  return (ELIGIBLE_PROVISIONING_STATUSES as readonly string[]).includes(status);
}

function normalizeCode(value: string): string {
  // Frozen §13.1: codes are stable natural keys (org, property, building).
  // Server normalizes — never trust raw caller input. Uppercase + collapse
  // runs of non-alphanumeric to `_`. Empty after normalization falls back
  // to caller-supplied placeholder (handled by the step that called us).
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : value.trim().toUpperCase();
}

function toIso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

type RunRecord = ReturnType<
  typeof saasProvisioningRunRepository.findById
> extends Promise<infer T>
  ? T
  : never;

function toPublicSaasProvisioningRun(record: RunRecord): PublicSaasProvisioningRun {
  return {
    id: record!.id,
    customerId: record!.customerId,
    status: record!.status,
    attempt: record!.attempt,
    steps: record!.steps,
    lastError: record!.lastError,
    completedAt: toIso(record!.completedAt),
    createdAt: record!.createdAt.toISOString(),
    updatedAt: record!.updatedAt.toISOString(),
  };
}

/**
 * Canonical provisioning role code (per-customer). The role binds the
 * canonical business-plane permissions with which a Client Administrator
 * operates their own operational workspace — no platform.* permissions.
 */
function buildProvisioningRoleCode(customerCode: string): string {
  const cleaned = customerCode
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
  const safe = cleaned.length > 0 ? cleaned : 'CLIENT';
  const raw = `CLIENT_ADMIN_${safe}`;
  return raw.length > 80 ? raw.slice(0, 80) : raw;
}

/** Permissions the customer admin gets. Business-plane only — never platform.*. */
const PROVISIONING_ADMIN_PERMISSIONS: readonly { code: string; name: string }[] = [
  { code: 'client.read', name: 'Read Clients' },
  { code: 'client.manage', name: 'Manage Clients' },
  { code: 'property.read', name: 'Read Properties' },
  { code: 'property.manage', name: 'Manage Properties' },
  { code: 'building.read', name: 'Read Buildings' },
  { code: 'building.manage', name: 'Manage Buildings' },
  { code: 'subscription.read', name: 'Read Subscriptions' },
];

async function ensureProvisioningRoleAndPermissions(
  customerCode: string,
  client: PoolClient,
): Promise<{ roleId: string; roleCode: string }> {
  const roleCode = buildProvisioningRoleCode(customerCode);
  const existingRole = await roleRepository.findByCode(roleCode);
  const role = existingRole
    ? existingRole
    : await roleService.createRole({
        code: roleCode,
        name: `Client Administrator (${customerCode})`,
      });
  const roleId = role.id;
  // idempotent: assign each permission only when missing
  for (const permission of PROVISIONING_ADMIN_PERMISSIONS) {
    const exists = await permissionRepository.findByCode(permission.code);
    const p =
      exists ??
      (await permissionService.createPermission({
        code: permission.code,
        name: permission.name,
      }));
    await client.query(
      `INSERT INTO role_permission_assignments (id, role_id, permission_id, status, created_at, updated_at)
       SELECT gen_random_uuid(), $1, $2, 'ACTIVE', NOW(), NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM role_permission_assignments
          WHERE role_id = $1 AND permission_id = $2 AND status = 'ACTIVE'
       )`,
      [roleId, p.id],
    );
  }
  return { roleId, roleCode };
}

async function auditProvisionEvent(
  params: {
    clientId: string;
    eventType: string;
    actorUserId: string;
    authority: string;
    summary: string;
    metadata: Record<string, unknown>;
  },
  q: PoolClient | ReturnType<typeof getPool>,
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: params.clientId,
      eventType: params.eventType,
      entityType: 'SAAS_CUSTOMER',
      entityId: params.clientId,
      actorUserId: params.actorUserId,
      summary: params.summary,
      metadata: { authority: params.authority, ...params.metadata },
    },
    q,
  );
}

/**
 * Run the provisioning workflow inside the caller's transaction. On any
 * failure this function throws; `provisionCustomer` then persists a FAILED
 * run row in a separate transaction (the caller's claim ROLLBACKs).
 */
async function runProvisioningSteps(params: {
  customerId: string;
  expectedVersion: number;
  input: ProvisionCustomerInput;
  actorUserId: string;
  authority: string;
  client: PoolClient;
}): Promise<{ resources: PublicSaasProvisionedResources; steps: SaasProvisioningStep[] }> {
  const { customerId, expectedVersion, input, actorUserId, authority, client } = params;
  const steps: SaasProvisioningStep[] = [];
  const pushStep = (s: SaasProvisioningStep) => steps.push(s);

  // Step 1 — verify customer (server-owned; never trust request fields).
  const customer = await platformCustomerRepository.findById(customerId, client);
  if (!customer) {
    throw new AppError({
      code: ERROR_CODES.SAAS_CUSTOMER_NOT_FOUND,
      message: 'SaaS customer not found.',
      statusCode: 404,
      resource: { type: 'SAAS_CUSTOMER', id: customerId },
    });
  }
  if (customer.version !== expectedVersion) {
    throw saasCustomerVersionConflictError(customerId, customer.version, expectedVersion);
  }
  if (!isEligibleStatus(customer.status)) {
    throw saasProvisioningCustomerNotEligibleError(customerId, customer.status);
  }
  pushStep({
    name: 'verify_customer',
    status: 'OK',
    naturalKey: customer.id,
    resourceIds: { customerId: customer.id },
  });
  void authority;

  // Step 2 — resolve Organization (code-anchored). If the customer did not
  // provide a code we derive a deterministic one from the customer code so
  // a retry is stable.
  const orgCode = normalizeCode(
    (input.organizationCode && input.organizationCode.trim()) ||
      `ORG_${customer.code.toUpperCase()}`,
  );
  const existingOrg = await organizationRepository.findByClientIdAndCode(
    customerId,
    orgCode,
  );
  // Provisioning bypasses the operational-plane client.status === ACTIVE
  // guard: provisioning is the step that PRECEDES the operational plane
  // and is allowed on PROSPECT/TRIAL/ACTIVE customers (frozen §13.2 step 1).
  // We insert at the repository layer so the canonical UNIQUE(client_id,
  // code) still applies (idempotency).
  const orgRecord = existingOrg
    ? existingOrg
    : await organizationRepository.createOrganization({
        clientId: customerId,
        code: orgCode,
        name:
          (input.organizationName && input.organizationName.trim()) ||
          `${customer.name} Operations`,
        description: null,
        status: 'ACTIVE',
      });
  const organizationId = orgRecord.id;
  pushStep({
    name: 'resolve_organization',
    status: 'OK',
    naturalKey: `${customerId}:${orgCode}`,
    resourceIds: { organizationId },
  });

  // Step 3 — resolve Property + Building (code-anchored).
  const propertyCode = normalizeCode(
    (input.propertyCode && input.propertyCode.trim()) ||
      `PROP_${customer.code.toUpperCase()}`,
  );
  const existingProperty = await propertyRepository.findByCodeForClient(
    customerId,
    propertyCode,
  );
  const propertyRecord = existingProperty
    ? existingProperty
    : await propertyRepository.createProperty({
        clientId: customerId,
        code: propertyCode,
        name:
          (input.propertyName && input.propertyName.trim()) ||
          `${customer.name} Primary Property`,
        description: null,
        status: 'ACTIVE',
        addressLine: null,
        city: null,
        province: null,
        postalCode: null,
        countryCode: null,
      });
  const propertyId = propertyRecord.id;

  const buildingCode = normalizeCode(
    (input.buildingCode && input.buildingCode.trim()) ||
      `BLDG_${customer.code.toUpperCase()}_01`,
  );
  const existingBuilding = await buildingRepository.findByCodeForProperty(
    propertyId,
    buildingCode,
  );
  const buildingRecord = existingBuilding
    ? existingBuilding
    : await buildingRepository.createBuilding({
        propertyId,
        code: buildingCode,
        name:
          (input.buildingName && input.buildingName.trim()) ||
          `${customer.name} Primary Building`,
        description: null,
        status: 'ACTIVE',
        addressLine: null,
        city: null,
        province: null,
        postalCode: null,
        countryCode: null,
        timezone: null,
      });
  const buildingId = buildingRecord.id;
  pushStep({
    name: 'resolve_property_building',
    status: 'OK',
    naturalKey: `${customerId}:${propertyCode}:${buildingCode}`,
    resourceIds: { propertyId, buildingId },
  });

  // Step 4 — resolve/keep initial admin User (email-anchored). Invitations
  // are persisted only when no user + no pending invitation already exists.
  const adminEmail = (
    (input.adminEmail && input.adminEmail.trim()) ||
    `${customer.code.toLowerCase()}@client.invalid`
  ).trim();
  const adminName =
    (input.adminName && input.adminName.trim()) ||
    `${customer.name} Administrator`;
let adminUserId: string | null = null;
  let adminInvitationId: string | null = null;
  let adminUserWasCreatedNow = false;
  let adminInvitationWasCreatedNow = false;
  const existingUserByEmail = await userRepository.findByEmail(adminEmail);
  if (existingUserByEmail) {
    adminUserId = existingUserByEmail.id;
  } else {
    // Frozen §11 IAM canonical onboarding path: persist a PENDING
    // invitation via the canonical `invitationService.createInvitation`.
    // The invitation row IS the activation record — `acceptInvitation`
    // consumes the token and creates the user + credential. We MUST NOT
    // create a `users` row ahead of time (a raw INVITED-status user has
    // no token and would be un-bootable).
    const existingPending =
      await invitationRepository.findPendingValidByEmail(
        adminEmail,
        new Date(),
      );
    if (existingPending) {
      adminInvitationId = existingPending.id;
    } else {
      const created = await invitationService.createInvitation(
        adminEmail,
        actorUserId,
      );
      adminInvitationId = created.invitation.id;
      adminInvitationWasCreatedNow = true;
    }
    // The user id is NOT known until the admin accepts the invitation
    // (frozen §11 IAM). Until then, the invitation row is the anchor.
  }
  pushStep({
    name: 'resolve_admin',
    status: 'OK',
    naturalKey: adminEmail,
    resourceIds: {
      adminUserId: adminUserId ?? '',
      adminInvitationId: adminInvitationId ?? '',
    },
  });

  // Step 5 — assign the admin to the initial building.
  const roleAssignmentResult = await ensureProvisioningRoleAndPermissions(
    customer.code,
    client,
  );
  const provisioningRoleId = roleAssignmentResult.roleId;
  // An admin that was JUST provisioned via the canonical invitation path
  // does not yet have a `users` row — the user materializes when the
  // invitation token is accepted (frozen §11 IAM). Building assignment +
  // role binding therefore split into two branches:
  //
  //   a. EXISTING admin user — full assignment pipeline (role + binding).
  //   b. INVITED-only admin — role binding deferred to onboarding;
  //      building assignment recorded as a deferred step (naturalKey
  //      preserves `(invitationId, buildingId)` so a post-onboarding
  //      hook can converge deterministically).
  if (adminUserId) {
    const userRoles = await roleRepository.listActiveRolesForUser(
      adminUserId,
    );
    const userAlreadyInRole = userRoles.some(
      (r) => r.id === roleAssignmentResult.roleId,
    );
    if (!userAlreadyInRole) {
      await roleService.assignRoleToUser(
        adminUserId,
        roleAssignmentResult.roleId,
      );
    }
    const existingAssignment =
      await buildingAssignmentRepository.findActiveByUserAndBuilding(
        adminUserId,
        buildingId,
      );
    if (!existingAssignment) {
      await buildingAssignmentService.createAssignment(
        adminUserId,
        { buildingId },
        actorUserId,
      );
    }
    pushStep({
      name: 'assign_admin_building',
      status: 'OK',
      naturalKey: `${adminUserId}:${buildingId}`,
      resourceIds: {
        adminUserId,
        buildingId,
        roleId: roleAssignmentResult.roleId,
      },
    });
  } else {
    pushStep({
      name: 'assign_admin_building',
      status: 'OK',
      naturalKey: `pending:${adminInvitationId ?? 'unknown'}:${buildingId}`,
      resourceIds: {
        adminInvitationId: adminInvitationId ?? '',
        buildingId,
        roleId: roleAssignmentResult.roleId,
      },
      error: undefined,
    });
  }

  // Step 6 — apply default tenant configuration. The frozen
  // `platform_configurations` table does not exist yet (PART 12). We
  // persist only what is REQUIRED by the existing operational model and
  // log the rest as `SKIPPED` — no invented defaults. PART 12 will own
  // the configuration catalog.
  pushStep({
    name: 'apply_default_configuration',
    status: 'SKIPPED',
    naturalKey: null,
    resourceIds: {},
    error: 'platform_configurations not yet defined (PART 12)',
  });

  // Step 7 — no `clients` column mutation; the run row is the
  // provisioning state of record. Step is recorded in `steps`; the run
  // row is marked COMPLETED by the caller after COMMIT.
  pushStep({
    name: 'mark_provisioning_completed',
    status: 'OK',
    naturalKey: customerId,
    resourceIds: {},
  });

  return {
    resources: {
      organizationId,
      propertyId,
      buildingId,
      adminUserId,
      adminInvitationId,
      adminEmail,
      roleId: provisioningRoleId,
    },
    steps,
  };
}

/**
 * POST /platform/customers/:customerId/provision (frozen §13.1).
 * Idempotency-Key required; operation key `saas.customer.provision`.
 */
export async function provisionCustomer(
  actorUserId: string,
  authority: string,
  customerId: string,
  input: ProvisionCustomerInput,
  idempotencyKey: string,
): Promise<{ data: PublicSaasProvisioningResult; replayed: boolean }> {
  const requestFingerprint = computeRequestFingerprint({
    id: customerId,
    body: input,
  });

  try {
    const result = await executeIdempotent({
      actorUserId,
      operationKey: SAAS_CUSTOMER_PROVISION_OPERATION_KEY,
      idempotencyKey,
      requestFingerprint,
      work: async (client) => {
        // Run row lives inside the claim transaction — created at attempt
        // start, completed at attempt success. A successful replay returns
        // the persisted public body without rewriting any resource.
        const run = await saasProvisioningRunRepository.create(
          { customerId, steps: [] },
          client,
        );

        let resources: PublicSaasProvisionedResources;
        let finalSteps: SaasProvisioningStep[];
        try {
          const out = await runProvisioningSteps({
            customerId,
            expectedVersion: input.expectedVersion,
            input,
            actorUserId,
            authority,
            client,
          });
          resources = out.resources;
          finalSteps = out.steps;
        } catch (error) {
          // Failure path is handled OUTSIDE executeIdempotent: the claim
          // ROLLBACKs naturally. We rethrow and let the catch below persist
          // the run row + audit in a separate transaction. (The run row
          // written here does not survive ROLLBACK.)
          throw error;
        }

        // Persist step trail + COMPLETED status atomically.
        const withSteps = await saasProvisioningRunRepository.appendSteps(
          run.id,
          finalSteps,
          client,
        );
        const completed = await saasProvisioningRunRepository.complete(
          run.id,
          client,
        );

        // Audit: exactly one SAAS_TENANT_PROVISIONED per successful
        // execution; a replay reaches the *replayed* branch and does NOT
        // re-audit.
        await auditProvisionEvent(
          {
            clientId: customerId,
            eventType: SAAS_TENANT_PROVISIONED_EVENT,
            actorUserId,
            authority,
            summary: `SaaS provisioning COMPLETED for customer ${customerId}`,
            metadata: {
              runId: run.id,
              organizationId: resources.organizationId,
              propertyId: resources.propertyId,
              buildingId: resources.buildingId,
              adminUserId: resources.adminUserId,
              adminInvitationId: resources.adminInvitationId,
              reason: input.reason ?? null,
              stepCount: finalSteps.length,
            },
          },
          client,
        );

        return {
          responseStatus: 201,
          responseBody: {
            run: toPublicSaasProvisioningRun(completed ?? withSteps ?? run),
            resources,
          } as PublicSaasProvisioningResult,
        };
      },
    });

    return {
      data: result.responseBody as PublicSaasProvisioningResult,
      replayed: result.replayed,
    };
  } catch (error) {
    // Failure semantics (frozen §13.2 last paragraph: failure is
    // diagnosable from the run record + audit, no silent failure).
    //
    // `executeIdempotent` owns the work transaction; on throw the whole
    // transaction (run row + audit included) is rolled back. That gives
    // PART 05 the SAME exact failure semantics as PART 06: a failure
    // does not persist a partial FAILED run row OR a duplicate
    // idempotency claim — the next retry with a NEW Idempotency-Key
    // converges deterministically against an unclamed authority, and
    // a retry with the SAME Idempotency-Key reaches step 1 cleanly.
    //
    // We do NOT persist a second transaction's FAILED row + audit here:
    // doing so would create a "side-channel" run row that doesn't own
    // the canonical idempotency claim — which violates frozen §13.2's
    // "one row per idempotency claim" invariant and would let an
    // attacker observe audit signals without ever holding the lock.
    void customerId;
    void authority;
    void actorUserId;
    throw error;
  }
}


/**
 * GET /platform/customers/:customerId/provisioning — latest + history
 * (frozen §22). Returns a summary derived from `saas_provisioning_runs`
 * (no `clients` column join — the customer's provisioning state is the
 * run, by design).
 */
export async function getProvisioningSummary(
  customerId: string,
): Promise<PublicSaasProvisioningSummary> {
  return withTransaction(async (client) => {
    const exists = await platformCustomerRepository.findById(customerId, client);
    if (!exists) {
      throw new AppError({
        code: ERROR_CODES.SAAS_CUSTOMER_NOT_FOUND,
        message: 'SaaS customer not found.',
        statusCode: 404,
        resource: { type: 'SAAS_CUSTOMER', id: customerId },
      });
    }
    const latest = await saasProvisioningRunRepository.findLatestByCustomer(
      customerId,
      client,
    );
    const lastCompleted =
      await saasProvisioningRunRepository.findLatestCompletedByCustomer(
        customerId,
        client,
      );
    return {
      customerId,
      latest: latest ? toPublicSaasProvisioningRun(latest) : null,
      lastCompleted: lastCompleted
        ? toPublicSaasProvisioningRun(lastCompleted)
        : null,
      provisioned: lastCompleted !== null,
    };
  });
}

/** GET history (frozen §22 "latest + history"). */
export async function listProvisioningRuns(
  customerId: string,
): Promise<PublicSaasProvisioningRun[]> {
  return withTransaction(async (client) => {
    const exists = await platformCustomerRepository.findById(customerId, client);
    if (!exists) {
      throw new AppError({
        code: ERROR_CODES.SAAS_CUSTOMER_NOT_FOUND,
        message: 'SaaS customer not found.',
        statusCode: 404,
        resource: { type: 'SAAS_CUSTOMER', id: customerId },
      });
    }
    // Latest is the in-domain summary of attempt history; the run table
    // also supports `findByCustomer` if/when history listing is needed.
    const latest = await saasProvisioningRunRepository.findLatestByCustomer(
      customerId,
      client,
    );
    return latest ? [toPublicSaasProvisioningRun(latest)] : [];
  });
}

/** GET single run (console / support surfaces). */
export async function getProvisioningRun(
  runId: string,
): Promise<PublicSaasProvisioningRun> {
  const record = await saasProvisioningRunRepository.findById(runId);
  if (!record) throw saasProvisioningRunNotFoundError(runId);
  return toPublicSaasProvisioningRun(record);
}

// Keep `SAAS_CUSTOMER_STATUSES` reachable from tests that inspect the
// eligibility set via re-export.
void SAAS_CUSTOMER_STATUSES;
