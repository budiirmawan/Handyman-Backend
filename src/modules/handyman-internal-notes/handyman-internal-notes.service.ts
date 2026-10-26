import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { stableJson } from '../../shared/stable-json';
import { authenticationRequiredError, sessionService } from '../auth';
import { assertBuildingScopedResourceAccess } from '../context-access';
import {
  careAuthorityDeniedError,
  HANDYMAN_CARE_BUILDING_PERMISSION,
  resolveBuildingCareAuthority,
} from '../handyman-care-authority';
import { authorizeCareCommercialRequest } from '../handyman-commercial-consent/commercial-consent.service';
import { careCreateContextNotFound } from '../handyman-care-workspace/care-create-exchange.scope';
import {
  resolveCareWorkspacePrincipal,
  workspaceUnauthorized,
} from '../handyman-care-workspace/care-workspace.service';
import { handymanServiceRequestRepository } from '../handyman-requests';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { userRepository } from '../users';
import {
  handymanInternalNoteForbiddenError,
  handymanInternalNoteIdempotencyConflictError,
  handymanServiceRequestNotFoundForInternalNoteError,
} from './handyman-internal-notes.errors';
import { handymanInternalNotesRepository } from './handyman-internal-notes.repository';
import type {
  CreateHandymanInternalNoteBody,
  HandymanInternalNoteAuthorRole,
  HandymanInternalNoteRecord,
  PublicHandymanInternalNote,
  PublicHandymanInternalNoteMutationResult,
} from './handyman-internal-notes.types';
import {
  parseCreateHandymanInternalNoteBody,
  parseInternalNoteUuidParam,
  parseOptionalCareWorkspaceScopeQuery,
} from './handyman-internal-notes.validation';

export function toPublicHandymanInternalNote(
  record: HandymanInternalNoteRecord,
): PublicHandymanInternalNote {
  return {
    id: record.id,
    clientId: record.clientId,
    tenantCompanyId: record.tenantCompanyId,
    buildingId: record.buildingId,
    spaceId: record.spaceId,
    subjectType: record.subjectType,
    handymanRequestId: record.handymanRequestId,
    unlistedIntakeCaseId: record.unlistedIntakeCaseId,
    visibilityClassification: 'INTERNAL_ONLY',
    authorRole: record.authorRole,
    createdByUserId: record.createdByUserId,
    createdByCareActorId: record.createdByCareActorId,
    authorDisplayName: record.authorDisplayName,
    author: {
      actorType: record.createdByCareActorId ? 'CARE_ACTOR' : 'USER',
      role: record.authorRole,
      userId: record.createdByUserId,
      careActorId: record.createdByCareActorId,
      displayName: record.authorDisplayName,
    },
    content: record.content,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt.toISOString(),
  };
}

export function computeInternalNotePayloadHash(input: {
  subjectType: 'SERVICE_REQUEST' | 'UNLISTED_SERVICE_INTAKE_CASE';
  handymanRequestId: string | null;
  unlistedIntakeCaseId?: string | null;
  clientId: string;
  buildingId: string;
  content: string;
}): string {
  return createHash('sha256')
    .update(
      stableJson({
        subjectType: input.subjectType,
        handymanRequestId: input.handymanRequestId,
        unlistedIntakeCaseId: input.unlistedIntakeCaseId ?? null,
        clientId: input.clientId,
        buildingId: input.buildingId,
        content: input.content,
      }),
    )
    .digest('hex');
}

async function assertNotCustomerFacingActor(userId: string): Promise<void> {
  if (!userId) {
    throw authenticationRequiredError();
  }
  const isPic = await handymanInternalNotesRepository.isCustomerFacingTenantPicUser(
    undefined,
    userId,
  );
  if (isPic) {
    throw handymanInternalNoteForbiddenError(
      'Customer-facing actors cannot create or retrieve internal operational notes.',
    );
  }
}

async function resolveSessionWriteAuthorRole(
  actorUserId: string,
): Promise<HandymanInternalNoteAuthorRole> {
  await assertNotCustomerFacingActor(actorUserId);
  const user = await userRepository.findById(actorUserId);
  if (!user || user.status !== 'ACTIVE') {
    throw handymanInternalNoteForbiddenError();
  }
  const permissions = await permissionService.resolvePermissionsForUser(actorUserId);
  if (permissions.includes(HANDYMAN_CARE_BUILDING_PERMISSION)) {
    return 'CUSTOMER_CARE';
  }
  const hasOperationsWriteAuthority =
    permissions.includes('service_request.manage') ||
    permissions.includes('work_order.manage') ||
    (permissions.includes('tenant_company.manage') &&
      (permissions.includes('service_request.read') ||
        permissions.includes('work_order.read')));
  if (hasOperationsWriteAuthority) {
    return 'OPERATIONS';
  }
  throw handymanInternalNoteForbiddenError();
}

async function assertSessionReadAuthority(actorUserId: string): Promise<{
  isCareBuildingActor: boolean;
}> {
  await assertNotCustomerFacingActor(actorUserId);
  const user = await userRepository.findById(actorUserId);
  if (!user || user.status !== 'ACTIVE') {
    throw handymanInternalNoteForbiddenError();
  }
  const permissions = await permissionService.resolvePermissionsForUser(actorUserId);
  const canRead =
    permissions.includes(HANDYMAN_CARE_BUILDING_PERMISSION) ||
    permissions.includes('service_request.read') ||
    permissions.includes('work_order.read') ||
    permissions.includes('tenant_company.read');
  if (!canRead) {
    throw handymanInternalNoteForbiddenError();
  }
  return {
    isCareBuildingActor: permissions.includes(HANDYMAN_CARE_BUILDING_PERMISSION),
  };
}

async function recordAuthorizedInternalNoteInTransaction(
  tx: PoolClient,
  requestScope: {
    id: string;
    clientId: string;
    tenantCompanyId: string;
    buildingId: string;
    spaceId: string | null;
  },
  actor: {
    userId?: string;
    careActorId?: string;
    authorRole: HandymanInternalNoteAuthorRole;
  },
  parsed: CreateHandymanInternalNoteBody,
): Promise<PublicHandymanInternalNoteMutationResult> {
  const actorKey = actor.userId
    ? `user:${actor.userId}`
    : `care:${actor.careActorId ?? ''}`;

  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    'handyman_internal_note',
    `${actorKey}:${parsed.idempotencyKey}`,
  ]);

  const lockedParent = await tx.query<{
    id: string;
    clientId: string;
    tenantCompanyId: string;
    buildingId: string;
    spaceId: string | null;
  }>(
    `SELECT id,
            client_id AS "clientId",
            tenant_company_id AS "tenantCompanyId",
            building_id AS "buildingId",
            space_id AS "spaceId"
       FROM handyman_service_requests
      WHERE id = $1
      FOR KEY SHARE`,
    [requestScope.id],
  );
  const parent = lockedParent.rows[0];
  if (
    !parent ||
    parent.clientId !== requestScope.clientId ||
    parent.tenantCompanyId !== requestScope.tenantCompanyId ||
    parent.buildingId !== requestScope.buildingId ||
    parent.spaceId !== requestScope.spaceId
  ) {
    throw handymanServiceRequestNotFoundForInternalNoteError();
  }

  const payloadHash = computeInternalNotePayloadHash({
    subjectType: 'SERVICE_REQUEST',
    handymanRequestId: parent.id,
    clientId: parent.clientId,
    buildingId: parent.buildingId,
    content: parsed.content,
  });

  const existing =
    await handymanInternalNotesRepository.findByActorAndIdempotencyKey(
      tx,
      actor,
      parsed.idempotencyKey,
    );
  if (existing) {
    if (
      existing.payloadHash !== payloadHash ||
      existing.handymanRequestId !== parent.id ||
      existing.clientId !== parent.clientId ||
      existing.buildingId !== parent.buildingId
    ) {
      throw handymanInternalNoteIdempotencyConflictError();
    }
    return {
      ...toPublicHandymanInternalNote(existing),
      replayed: true,
    };
  }

  const created = await handymanInternalNotesRepository.insertInternalNote(tx, {
    clientId: parent.clientId,
    tenantCompanyId: parent.tenantCompanyId,
    buildingId: parent.buildingId,
    spaceId: parent.spaceId,
    subjectType: 'SERVICE_REQUEST',
    handymanRequestId: parent.id,
    unlistedIntakeCaseId: null,
    authorRole: actor.authorRole,
    createdByUserId: actor.userId ?? null,
    createdByCareActorId: actor.careActorId ?? null,
    content: parsed.content,
    idempotencyKey: parsed.idempotencyKey,
    payloadHash,
  });

  await recordOperationalEvent(
    {
      clientId: parent.clientId,
      eventType: 'HANDYMAN_INTERNAL_NOTE_RECORDED',
      entityType: 'HANDYMAN_SERVICE_REQUEST',
      entityId: parent.id,
      actorUserId: actor.userId ?? null,
      buildingId: parent.buildingId,
      summary: `Internal operational note recorded on Handyman service request (${actor.authorRole}).`,
      metadata: {
        internalNoteId: created.id,
        authorRole: created.authorRole,
        visibilityClassification: 'INTERNAL_ONLY',
        ...(actor.careActorId ? { careActorId: actor.careActorId } : {}),
      },
    },
    tx,
  );

  return {
    ...toPublicHandymanInternalNote(created),
    replayed: false,
  };
}

/**
 * Standalone Building Care surface:
 *   POST /api/v1/handyman/care/buildings/:buildingId/requests/:requestId/internal-notes
 */
export async function createBuildingCareInternalNote(input: {
  actorUserId: string;
  buildingId: string;
  requestId: string;
  body: unknown;
  headerIdempotencyKey?: string;
}): Promise<PublicHandymanInternalNoteMutationResult> {
  const buildingId = parseInternalNoteUuidParam(input.buildingId, 'buildingId');
  const requestId = parseInternalNoteUuidParam(input.requestId, 'requestId');
  await assertNotCustomerFacingActor(input.actorUserId);
  const authority = await resolveBuildingCareAuthority({
    actorUserId: input.actorUserId,
    buildingId,
  });
  const parsed = parseCreateHandymanInternalNoteBody(
    input.body,
    input.headerIdempotencyKey,
  );

  const request = await handymanServiceRequestRepository.findById(
    undefined,
    requestId,
  );
  if (!request) {
    throw handymanServiceRequestNotFoundForInternalNoteError();
  }
  if (
    request.clientId !== authority.scope.clientId ||
    request.buildingId !== authority.scope.buildingId
  ) {
    throw careAuthorityDeniedError();
  }

  return withTransaction((tx) =>
    recordAuthorizedInternalNoteInTransaction(
      tx,
      {
        id: request.id,
        clientId: request.clientId,
        tenantCompanyId: request.tenantCompanyId,
        buildingId: request.buildingId,
        spaceId: request.spaceId,
      },
      {
        userId: input.actorUserId,
        authorRole: 'CUSTOMER_CARE',
      },
      parsed,
    ),
  );
}

/**
 * Standalone Building Care surface:
 *   GET /api/v1/handyman/care/buildings/:buildingId/requests/:requestId/internal-notes
 */
export async function listBuildingCareInternalNotes(input: {
  actorUserId: string;
  buildingId: string;
  requestId: string;
}): Promise<PublicHandymanInternalNote[]> {
  const buildingId = parseInternalNoteUuidParam(input.buildingId, 'buildingId');
  const requestId = parseInternalNoteUuidParam(input.requestId, 'requestId');
  await assertNotCustomerFacingActor(input.actorUserId);
  const authority = await resolveBuildingCareAuthority({
    actorUserId: input.actorUserId,
    buildingId,
  });

  const request = await handymanServiceRequestRepository.findById(
    undefined,
    requestId,
  );
  if (!request) {
    throw handymanServiceRequestNotFoundForInternalNoteError();
  }
  if (
    request.clientId !== authority.scope.clientId ||
    request.buildingId !== authority.scope.buildingId
  ) {
    throw careAuthorityDeniedError();
  }

  const rows = await handymanInternalNotesRepository.listByServiceRequestScoped(
    undefined,
    {
      clientId: request.clientId,
      buildingId: request.buildingId,
      handymanRequestId: request.id,
    },
  );
  return rows.map(toPublicHandymanInternalNote);
}

/**
 * Care Workspace / Care Request surface:
 *   POST /api/v1/handyman/care/requests/:requestId/internal-notes
 *
 * Supports both BM Care Workspace tokens (`hcw_...`) and Backend Customer Care
 * sessions (`handyman.care.building` + exact Building assignment).
 */
export async function createCareWorkspaceInternalNote(input: {
  bearerToken: string;
  requestId: string;
  body: unknown;
  headerIdempotencyKey?: string;
}): Promise<PublicHandymanInternalNoteMutationResult> {
  if (!input.bearerToken) {
    throw workspaceUnauthorized();
  }
  const requestId = parseInternalNoteUuidParam(input.requestId, 'requestId');
  const parsed = parseCreateHandymanInternalNoteBody(
    input.body,
    input.headerIdempotencyKey,
  );

  if (input.bearerToken.startsWith('hcw_')) {
    const principal = await resolveCareWorkspacePrincipal(input.bearerToken);
    return withTransaction(async (tx) => {
      const request = await handymanServiceRequestRepository.findById(
        tx,
        requestId,
      );
      if (!request) {
        throw careCreateContextNotFound();
      }
      await authorizeCareCommercialRequest(tx, principal, {
        id: request.id,
        clientId: request.clientId,
        tenantCompanyId: request.tenantCompanyId,
        tenantPicId: request.tenantPicId,
        buildingId: request.buildingId,
        spaceId: request.spaceId,
      });
      return recordAuthorizedInternalNoteInTransaction(
        tx,
        {
          id: request.id,
          clientId: request.clientId,
          tenantCompanyId: request.tenantCompanyId,
          buildingId: request.buildingId,
          spaceId: request.spaceId,
        },
        {
          careActorId: principal.careActorId,
          authorRole: 'CUSTOMER_CARE',
        },
        parsed,
      );
    });
  }

  const session = await sessionService.resolveSessionContext(input.bearerToken);
  await assertNotCustomerFacingActor(session.userId);
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    requestId,
  );
  if (!request) {
    throw handymanServiceRequestNotFoundForInternalNoteError();
  }
  await resolveBuildingCareAuthority({
    actorUserId: session.userId,
    buildingId: request.buildingId,
    assertedClientId: request.clientId,
  });

  return withTransaction((tx) =>
    recordAuthorizedInternalNoteInTransaction(
      tx,
      {
        id: request.id,
        clientId: request.clientId,
        tenantCompanyId: request.tenantCompanyId,
        buildingId: request.buildingId,
        spaceId: request.spaceId,
      },
      {
        userId: session.userId,
        authorRole: 'CUSTOMER_CARE',
      },
      parsed,
    ),
  );
}

/**
 * Care Workspace / Care Request surface:
 *   GET /api/v1/handyman/care/requests/:requestId/internal-notes
 */
export async function listCareWorkspaceInternalNotes(input: {
  bearerToken: string;
  requestId: string;
  query?: unknown;
}): Promise<PublicHandymanInternalNote[]> {
  if (!input.bearerToken) {
    throw workspaceUnauthorized();
  }
  const requestId = parseInternalNoteUuidParam(input.requestId, 'requestId');
  const scopeFilter = parseOptionalCareWorkspaceScopeQuery(input.query);

  if (input.bearerToken.startsWith('hcw_')) {
    const principal = await resolveCareWorkspacePrincipal(input.bearerToken);
    return withTransaction(async (tx) => {
      const request = await handymanServiceRequestRepository.findById(
        tx,
        requestId,
      );
      if (!request) {
        throw careCreateContextNotFound();
      }
      if (
        (scopeFilter.tenantCompanyId !== undefined &&
          scopeFilter.tenantCompanyId !== request.tenantCompanyId) ||
        (scopeFilter.buildingId !== undefined &&
          scopeFilter.buildingId !== request.buildingId) ||
        (scopeFilter.spaceId !== undefined &&
          scopeFilter.spaceId !== request.spaceId)
      ) {
        throw careCreateContextNotFound();
      }
      if (scopeFilter.propertyId !== undefined) {
        const buildingRow = await tx.query<{ property_id: string }>(
          'SELECT property_id FROM buildings WHERE id = $1',
          [request.buildingId],
        );
        if (buildingRow.rows[0]?.property_id !== scopeFilter.propertyId) {
          throw careCreateContextNotFound();
        }
      }
      await authorizeCareCommercialRequest(tx, principal, {
        id: request.id,
        clientId: request.clientId,
        tenantCompanyId: request.tenantCompanyId,
        tenantPicId: request.tenantPicId,
        buildingId: request.buildingId,
        spaceId: request.spaceId,
      });
      const rows =
        await handymanInternalNotesRepository.listByServiceRequestScoped(tx, {
          clientId: request.clientId,
          buildingId: request.buildingId,
          handymanRequestId: request.id,
        });
      return rows.map(toPublicHandymanInternalNote);
    });
  }

  const session = await sessionService.resolveSessionContext(input.bearerToken);
  await assertNotCustomerFacingActor(session.userId);
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    requestId,
  );
  if (!request) {
    throw handymanServiceRequestNotFoundForInternalNoteError();
  }
  if (
    (scopeFilter.tenantCompanyId !== undefined &&
      scopeFilter.tenantCompanyId !== request.tenantCompanyId) ||
    (scopeFilter.buildingId !== undefined &&
      scopeFilter.buildingId !== request.buildingId) ||
    (scopeFilter.spaceId !== undefined &&
      scopeFilter.spaceId !== request.spaceId)
  ) {
    throw careAuthorityDeniedError();
  }
  if (scopeFilter.propertyId !== undefined) {
    const buildingRow = await getPool().query<{ property_id: string }>(
      'SELECT property_id FROM buildings WHERE id = $1',
      [request.buildingId],
    );
    if (buildingRow.rows[0]?.property_id !== scopeFilter.propertyId) {
      throw careAuthorityDeniedError();
    }
  }
  await resolveBuildingCareAuthority({
    actorUserId: session.userId,
    buildingId: request.buildingId,
    assertedClientId: request.clientId,
  });

  const rows = await handymanInternalNotesRepository.listByServiceRequestScoped(
    undefined,
    {
      clientId: request.clientId,
      buildingId: request.buildingId,
      handymanRequestId: request.id,
    },
  );
  return rows.map(toPublicHandymanInternalNote);
}

/**
 * Shared Service Request Internal Notes surface:
 *   POST /api/v1/handyman/requests/:handymanRequestId/internal-notes
 *
 * Accessible to Customer Care (session or workspace token) and authorized
 * Handyman Operations personnel within the request's exact Client/Building
 * scope. Customer-facing actors (Tenant PICs) are strictly denied.
 */
export async function createServiceRequestInternalNote(input: {
  bearerToken?: string;
  actorUserId?: string;
  handymanRequestId: string;
  body: unknown;
  headerIdempotencyKey?: string;
}): Promise<PublicHandymanInternalNoteMutationResult> {
  const handymanRequestId = parseInternalNoteUuidParam(
    input.handymanRequestId,
    'handymanRequestId',
  );

  if (input.bearerToken?.startsWith('hcw_')) {
    return createCareWorkspaceInternalNote({
      bearerToken: input.bearerToken,
      requestId: handymanRequestId,
      body: input.body,
      headerIdempotencyKey: input.headerIdempotencyKey,
    });
  }

  const actorUserId =
    input.actorUserId ??
    (input.bearerToken
      ? (await sessionService.resolveSessionContext(input.bearerToken)).userId
      : '');
  if (!actorUserId) {
    throw authenticationRequiredError();
  }

  const authorRole = await resolveSessionWriteAuthorRole(actorUserId);
  const parsed = parseCreateHandymanInternalNoteBody(
    input.body,
    input.headerIdempotencyKey,
  );

  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) {
    throw handymanServiceRequestNotFoundForInternalNoteError();
  }

  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: request.clientId,
    buildingId: request.buildingId,
  });

  return withTransaction((tx) =>
    recordAuthorizedInternalNoteInTransaction(
      tx,
      {
        id: request.id,
        clientId: request.clientId,
        tenantCompanyId: request.tenantCompanyId,
        buildingId: request.buildingId,
        spaceId: request.spaceId,
      },
      {
        userId: actorUserId,
        authorRole,
      },
      parsed,
    ),
  );
}

/**
 * Shared Service Request Internal Notes readback surface:
 *   GET /api/v1/handyman/requests/:handymanRequestId/internal-notes
 *
 * Accessible to Customer Care and Handyman Operations within their authorized
 * Client/Building scope without requiring `tenant_company.manage` or granting
 * broad Customer Care permissions to Operations. Customer-facing actors are
 * strictly denied.
 */
export async function listServiceRequestInternalNotes(input: {
  bearerToken?: string;
  actorUserId?: string;
  handymanRequestId: string;
  query?: unknown;
}): Promise<PublicHandymanInternalNote[]> {
  const handymanRequestId = parseInternalNoteUuidParam(
    input.handymanRequestId,
    'handymanRequestId',
  );

  if (input.bearerToken?.startsWith('hcw_')) {
    return listCareWorkspaceInternalNotes({
      bearerToken: input.bearerToken,
      requestId: handymanRequestId,
      query: input.query,
    });
  }

  const actorUserId =
    input.actorUserId ??
    (input.bearerToken
      ? (await sessionService.resolveSessionContext(input.bearerToken)).userId
      : '');
  if (!actorUserId) {
    throw authenticationRequiredError();
  }

  await assertSessionReadAuthority(actorUserId);

  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) {
    throw handymanServiceRequestNotFoundForInternalNoteError();
  }

  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: request.clientId,
    buildingId: request.buildingId,
  });

  const rows = await handymanInternalNotesRepository.listByServiceRequestScoped(
    undefined,
    {
      clientId: request.clientId,
      buildingId: request.buildingId,
      handymanRequestId: request.id,
    },
  );
  return rows.map(toPublicHandymanInternalNote);
}

export const handymanInternalNotesService = {
  createBuildingCareInternalNote,
  listBuildingCareInternalNotes,
  createCareWorkspaceInternalNote,
  listCareWorkspaceInternalNotes,
  createServiceRequestInternalNote,
  listServiceRequestInternalNotes,
  computeInternalNotePayloadHash,
  toPublicHandymanInternalNote,
};
