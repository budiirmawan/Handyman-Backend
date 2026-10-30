import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { hasCurrentUnitPartyRole } from '../apartment-master';
import { authenticationRequiredError, sessionService } from '../auth';
import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import {
  careAuthorityDeniedError,
  HANDYMAN_CARE_BUILDING_PERMISSION,
  resolveBuildingCareAuthority,
} from '../handyman-care-authority';
import { requireActiveAssignedBuilding } from '../handyman-care-standalone-discovery/handyman-care-standalone-discovery.service';
import { careCreateContextNotFound } from '../handyman-care-workspace/care-create-exchange.scope';
import {
  resolveCareWorkspacePrincipal,
  workspaceUnauthorized,
} from '../handyman-care-workspace/care-workspace.service';
import { createChannelAttribution } from '../handyman-channel-attributions';
import { authorizeCareCommercialRequest } from '../handyman-commercial-consent/commercial-consent.service';
import {
  handoffExchangeInvalidError,
  handoffRuntimeRepository,
  hashHandoffExchangeToken,
} from '../handyman-handoff';
import { bindCareHandoffExchangeInTransaction } from '../handyman-handoff/handoff-binding.service';
import { isCurrentCareRepresentation } from '../handyman-handoff/care-representation.service';
import {
  createBuildingCareUnlistedIntakeInternalNote,
  createCareWorkspaceUnlistedIntakeInternalNote,
  handymanInternalNotesRepository,
  toPublicHandymanInternalNote,
  type PublicHandymanInternalNote,
  type PublicHandymanInternalNoteMutationResult,
} from '../handyman-internal-notes';
import { handymanSchedulingReadinessTimezoneUnavailableError } from '../handyman-scheduling/handyman-scheduling.errors';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantCompanyRepository } from '../tenant-companies';
import { tenantVerificationRequiredError } from '../tenant-companies/tenant-company.errors';
import { userRepository } from '../users';
import {
  handymanUnlistedIntakeCaseNotFoundError,
  handymanUnlistedIntakeConversionAttributionConflictError,
  handymanUnlistedIntakeConversionIdempotencyConflictError,
  handymanUnlistedIntakeConversionNotEligibleError,
  handymanUnlistedIntakeConversionScopeUnverifiedError,
  handymanUnlistedIntakeForbiddenError,
  handymanUnlistedIntakeIdempotencyConflictError,
  handymanUnlistedIntakeTriageAlreadyRecordedError,
  handymanUnlistedIntakeTriageCatalogServiceInvalidError,
  handymanUnlistedIntakeTriageIdempotencyConflictError,
  handymanUnlistedIntakeTriageUomInvalidError,
} from './handyman-unlisted-intake.errors';
import {
  handymanUnlistedIntakeRepository,
  type HandymanUnlistedIntakeServiceRequestRow,
  type NewHandymanUnlistedIntakeTriageDecisionInput,
} from './handyman-unlisted-intake.repository';
import type {
  HandymanUnlistedIntakeCaseRecord,
  HandymanUnlistedIntakeListPage,
  HandymanUnlistedIntakeStatus,
  HandymanUnlistedIntakeTriageDecisionRecord,
  PublicHandymanUnlistedIntakeCase,
  PublicHandymanUnlistedIntakeMutationResult,
  PublicHandymanUnlistedIntakeConversionMutationResult,
  PublicHandymanUnlistedIntakeRequestConversion,
  PublicHandymanUnlistedIntakeTriageDecision,
  PublicHandymanUnlistedIntakeTriageMutationResult,
} from './handyman-unlisted-intake.types';
import {
  HANDYMAN_UNLISTED_INTAKE_REQUEST_INTAKE_SOURCE,
  HANDYMAN_UNLISTED_INTAKE_TRIAGE_ELIGIBLE_STATUSES,
  HANDYMAN_UNLISTED_INTAKE_TRIAGE_PROJECTION,
} from './handyman-unlisted-intake.types';
import {
  parseCreateBuildingCareUnlistedIntakeBody,
  parseCreateCareWorkspaceUnlistedIntakeBody,
  parseUnlistedIntakeConversionBody,
  parseUnlistedIntakeListQuery,
  parseUnlistedIntakeTriageBody,
  parseUnlistedIntakeUuidParam,
} from './handyman-unlisted-intake.validation';

function isValidIanaTimezone(tz: string | null | undefined): tz is string {
  if (typeof tz !== 'string') return false;
  const trimmed = tz.trim();
  if (trimmed.length < 1 || trimmed.length > 120) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

async function resolveBuildingTimezoneForPreferredWindow(
  executor: Pick<PoolClient, 'query'>,
  buildingId: string,
): Promise<string> {
  const row = await executor.query<{ timezone: string | null }>(
    'SELECT timezone FROM buildings WHERE id = $1',
    [buildingId],
  );
  const tz = row.rows[0]?.timezone;
  if (!isValidIanaTimezone(tz)) {
    throw handymanSchedulingReadinessTimezoneUnavailableError();
  }
  return tz.trim();
}

/**
 * Append-only Operations triage decision fact, projected for internal
 * (Operations / Customer Care) surfaces. The payload deliberately carries NO
 * price: the manual branch stores a requirement (summary / quantity / UOM)
 * that PART 02 turns into real quotation lines under the existing quotation
 * and customer-approval authorities.
 */
export function toPublicHandymanUnlistedIntakeTriageDecision(
  record: HandymanUnlistedIntakeTriageDecisionRecord,
): PublicHandymanUnlistedIntakeTriageDecision {
  return {
    id: record.id,
    intakeCaseId: record.intakeCaseId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    tenantCompanyId: record.tenantCompanyId,
    decision: record.decision,
    statusAfter: record.statusAfter,
    justification: record.justification,
    clarificationRequest: record.clarificationRequest,
    catalogServiceId: record.catalogServiceId,
    customServiceName: record.customServiceName,
    customServiceNotes: record.customServiceNotes,
    manualQuoteSummary: record.manualQuoteSummary,
    manualQuoteQuantity: record.manualQuoteQuantity,
    manualQuoteUomId: record.manualQuoteUomId,
    manualQuotationRequired:
      record.decision === 'ONE_TIME_MANUAL_QUOTATION_REQUIRED',
    triagedByUserId: record.triagedByUserId,
    triagedByDisplayName: record.triagedByDisplayName,
    triagedAt: record.triagedAt.toISOString(),
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toPublicHandymanUnlistedIntakeCase(
  record: HandymanUnlistedIntakeCaseRecord,
  internalNotes: PublicHandymanInternalNote[] = [],
  triage: {
    triage: HandymanUnlistedIntakeTriageDecisionRecord | null;
    triageHistory: HandymanUnlistedIntakeTriageDecisionRecord[];
  } = { triage: null, triageHistory: [] },
): PublicHandymanUnlistedIntakeCase {
  const preferredWindowStart = record.preferredWindowStart
    ? record.preferredWindowStart.toISOString()
    : null;
  const preferredWindowEnd = record.preferredWindowEnd
    ? record.preferredWindowEnd.toISOString()
    : null;
  const preferredWindowTimezone = record.preferredWindowTimezone ?? null;

  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    spaceId: record.spaceId,
    tenantCompanyId: record.tenantCompanyId,
    tenantPicId: record.tenantPicId,
    approvalTenantCompanyId: record.approvalTenantCompanyId,
    costResponsibleTenantCompanyId: record.costResponsibleTenantCompanyId,
    channelAttributionId: record.channelAttributionId,
    originChannel: record.originChannel,
    originReference: record.originReference,
    requestedServiceName: record.requestedServiceName,
    description: record.description,
    preferredWindowStart,
    preferredWindowEnd,
    preferredWindowTimezone,
    preferredWindow:
      preferredWindowStart && preferredWindowEnd && preferredWindowTimezone
        ? {
            preferredWindowStart,
            preferredWindowEnd,
            timezone: preferredWindowTimezone,
          }
        : null,
    status: record.status,
    triageDecisionId: record.triageDecisionId,
    triagedAt: record.triagedAt ? record.triagedAt.toISOString() : null,
    convertedRequestId: record.convertedRequestId,
    convertedAt: record.convertedAt ? record.convertedAt.toISOString() : null,
    triage: triage.triage ? toPublicHandymanUnlistedIntakeTriageDecision(triage.triage) : null,
    triageHistory: triage.triageHistory.map(
      toPublicHandymanUnlistedIntakeTriageDecision,
    ),
    createdByUserId: record.createdByUserId,
    createdByCareActorId: record.createdByCareActorId,
    createdByDisplayName: record.createdByDisplayName,
    createdBy: {
      actorType: record.createdByCareActorId ? 'CARE_ACTOR' : 'USER',
      userId: record.createdByUserId,
      careActorId: record.createdByCareActorId,
      displayName: record.createdByDisplayName,
    },
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    internalNotes,
  };
}

export function computeUnlistedIntakePayloadHash(input: {
  clientId: string;
  buildingId: string;
  spaceId: string | null;
  tenantCompanyId: string;
  tenantPicId: string | null;
  approvalTenantCompanyId: string;
  costResponsibleTenantCompanyId: string;
  requestedServiceName: string;
  description: string;
  preferredWindowStart: string | null;
  preferredWindowEnd: string | null;
}): string {
  return createHash('sha256')
    .update(
      stableJson({
        clientId: input.clientId,
        buildingId: input.buildingId,
        spaceId: input.spaceId,
        tenantCompanyId: input.tenantCompanyId,
        tenantPicId: input.tenantPicId,
        approvalTenantCompanyId: input.approvalTenantCompanyId,
        costResponsibleTenantCompanyId: input.costResponsibleTenantCompanyId,
        requestedServiceName: input.requestedServiceName,
        description: input.description,
        preferredWindowStart: input.preferredWindowStart,
        preferredWindowEnd: input.preferredWindowEnd,
      }),
    )
    .digest('hex');
}

async function assertNotCustomerFacingIntakeActor(
  userId: string,
): Promise<void> {
  if (!userId) {
    throw authenticationRequiredError();
  }
  const isPic =
    await handymanInternalNotesRepository.isCustomerFacingTenantPicUser(
      undefined,
      userId,
    );
  if (isPic) {
    throw handymanUnlistedIntakeForbiddenError(
      'Customer-facing Tenant PIC accounts cannot create or access internal unlisted service intake cases.',
    );
  }
}

async function assertOperationsOrCareReadSessionAuthority(
  actorUserId: string,
): Promise<void> {
  await assertNotCustomerFacingIntakeActor(actorUserId);
  const user = await userRepository.findById(actorUserId);
  if (!user || user.status !== 'ACTIVE') {
    throw handymanUnlistedIntakeForbiddenError();
  }
  const permissions =
    await permissionService.resolvePermissionsForUser(actorUserId);
  const canRead =
    permissions.includes(HANDYMAN_CARE_BUILDING_PERMISSION) ||
    permissions.includes('service_request.read') ||
    permissions.includes('work_order.read') ||
    permissions.includes('tenant_company.read');
  if (!canRead) {
    throw handymanUnlistedIntakeForbiddenError();
  }
}

function isEffectiveNow(record: {
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
}): boolean {
  const now = Date.now();
  if (record.effectiveFrom && record.effectiveFrom.getTime() > now) {
    return false;
  }
  if (record.effectiveUntil && record.effectiveUntil.getTime() < now) {
    return false;
  }
  return true;
}

async function resolveBuildingCareUnlistedCreateScope(input: {
  actorUserId: string;
  buildingId: string;
  tenantCompanyId: string;
  spaceId: string | null;
  approvalTenantCompanyId?: string;
  costResponsibleTenantCompanyId?: string;
}) {
  const { authority, lineage } = await requireActiveAssignedBuilding(
    input.actorUserId,
    input.buildingId,
  );
  if (
    !lineage ||
    lineage.clientId !== authority.scope.clientId ||
    lineage.propertyId !== authority.scope.propertyId
  ) {
    throw careAuthorityDeniedError();
  }

  const company = await tenantCompanyRepository.findById(input.tenantCompanyId);
  const context = company
    ? await tenantBuildingContextRepository.findActive(
        company.id,
        authority.scope.buildingId,
      )
    : null;
  if (
    !company ||
    company.status !== 'ACTIVE' ||
    company.clientId !== authority.scope.clientId ||
    !context ||
    !isEffectiveNow(context)
  ) {
    throw careAuthorityDeniedError();
  }

  const approval = input.approvalTenantCompanyId ?? input.tenantCompanyId;
  const costResponsibility =
    input.costResponsibleTenantCompanyId ?? input.tenantCompanyId;

  for (const partyId of new Set([approval, costResponsibility])) {
    const designated = await tenantCompanyRepository.findById(partyId);
    if (designated && designated.verificationStatus !== 'VERIFIED') {
      throw tenantVerificationRequiredError();
    }
    if (partyId === input.tenantCompanyId) continue;

    if (
      !designated ||
      designated.status !== 'ACTIVE' ||
      designated.clientId !== authority.scope.clientId
    ) {
      throw careAuthorityDeniedError();
    }

    if (input.spaceId !== null) {
      const holdsUnitRole = await hasCurrentUnitPartyRole({
        clientId: authority.scope.clientId,
        buildingId: authority.scope.buildingId,
        unitId: input.spaceId,
        tenantCompanyId: partyId,
      });
      if (!holdsUnitRole) throw careAuthorityDeniedError();
    } else {
      const partyContext = await tenantBuildingContextRepository.findActive(
        partyId,
        authority.scope.buildingId,
      );
      if (!partyContext || !isEffectiveNow(partyContext)) {
        throw careAuthorityDeniedError();
      }
    }
  }

  return {
    authority,
    approvalTenantCompanyId: approval,
    costResponsibleTenantCompanyId: costResponsibility,
  };
}

/**
 * Shared read projection for one intake case: its append-only internal notes
 * AND its Operations triage decision(s). Both are scoped by the authoritative
 * case row (Client + exact Building), never by a caller-supplied scope.
 */
async function loadCaseProjection(
  executor: Pick<PoolClient, 'query'>,
  record: HandymanUnlistedIntakeCaseRecord,
): Promise<{
  internalNotes: PublicHandymanInternalNote[];
  triage: HandymanUnlistedIntakeTriageDecisionRecord | null;
  triageHistory: HandymanUnlistedIntakeTriageDecisionRecord[];
}> {
  const [internalNotes, triageHistory] = await Promise.all([
    loadInternalNotesForCase(executor, record),
    handymanUnlistedIntakeRepository.listTriageDecisionsByCase(executor, {
      clientId: record.clientId,
      buildingId: record.buildingId,
      intakeCaseId: record.id,
    }),
  ]);
  return {
    internalNotes,
    triage:
      triageHistory.find((row) => row.id === record.triageDecisionId) ??
      null,
    triageHistory,
  };
}

async function loadInternalNotesForCase(
  executor: Pick<PoolClient, 'query'>,
  record: HandymanUnlistedIntakeCaseRecord,
): Promise<PublicHandymanInternalNote[]> {
  const rows =
    await handymanInternalNotesRepository.listByUnlistedIntakeCaseScoped(
      executor,
      {
        clientId: record.clientId,
        buildingId: record.buildingId,
        unlistedIntakeCaseId: record.id,
      },
    );
  return rows.map(toPublicHandymanInternalNote);
}

function normalizeInlineInternalNoteBody(
  rawInternalNote: unknown,
  intakeIdempotencyKey: string,
): Record<string, unknown> {
  if (typeof rawInternalNote === 'string') {
    return {
      content: rawInternalNote,
      idempotencyKey: `${intakeIdempotencyKey}:note`,
    };
  }
  if (
    rawInternalNote &&
    typeof rawInternalNote === 'object' &&
    !Array.isArray(rawInternalNote)
  ) {
    const obj = rawInternalNote as Record<string, unknown>;
    return {
      ...obj,
      ...(obj.idempotencyKey === undefined
        ? { idempotencyKey: `${intakeIdempotencyKey}:note` }
        : {}),
    };
  }
  return { content: rawInternalNote, idempotencyKey: `${intakeIdempotencyKey}:note` };
}

function attachCommittedIntakeCaseToNoteError(
  error: unknown,
  intakeCase: PublicHandymanUnlistedIntakeCase,
): never {
  if (error instanceof AppError) {
    throw new AppError({
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      resource: {
        type: 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CASE',
        id: intakeCase.id,
      },
      details: [
        ...(error.details ?? []),
        {
          intakeCaseId: intakeCase.id,
          status: intakeCase.status,
          noteRetryable: true,
        },
      ],
    });
  }
  throw error;
}

/**
 * Standalone Building Customer Care:
 *   POST /api/v1/handyman/care/buildings/:buildingId/unlisted-intake-cases
 */
export async function createBuildingCareUnlistedIntakeCase(input: {
  actorUserId: string;
  buildingId: string;
  body: unknown;
  headerIdempotencyKey?: string;
}): Promise<PublicHandymanUnlistedIntakeMutationResult> {
  await assertNotCustomerFacingIntakeActor(input.actorUserId);
  const parsed = parseCreateBuildingCareUnlistedIntakeBody(
    input.body,
    input.buildingId,
    input.headerIdempotencyKey,
  );

  const {
    authority,
    approvalTenantCompanyId,
    costResponsibleTenantCompanyId,
  } = await resolveBuildingCareUnlistedCreateScope({
    actorUserId: input.actorUserId,
    buildingId: parsed.buildingId,
    tenantCompanyId: parsed.tenantCompanyId,
    spaceId: parsed.spaceId,
    approvalTenantCompanyId: parsed.approvalTenantCompanyId,
    costResponsibleTenantCompanyId: parsed.costResponsibleTenantCompanyId,
  });

  const payloadHash = computeUnlistedIntakePayloadHash({
    clientId: authority.scope.clientId,
    buildingId: authority.scope.buildingId,
    spaceId: parsed.spaceId,
    tenantCompanyId: parsed.tenantCompanyId,
    tenantPicId: parsed.tenantPicId,
    approvalTenantCompanyId,
    costResponsibleTenantCompanyId,
    requestedServiceName: parsed.requestedServiceName,
    description: parsed.description,
    preferredWindowStart: parsed.preferredWindowStart ?? null,
    preferredWindowEnd: parsed.preferredWindowEnd ?? null,
  });

  const committed = await withTransaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      'handyman_unlisted_intake',
      `user:${input.actorUserId}:${parsed.idempotencyKey}`,
    ]);

    const existing =
      await handymanUnlistedIntakeRepository.findByActorAndIdempotencyKey(
        tx,
        { userId: input.actorUserId },
        parsed.idempotencyKey,
      );
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw handymanUnlistedIntakeIdempotencyConflictError();
      }
      const projection = await loadCaseProjection(tx, existing);
      return {
        intakeCase: toPublicHandymanUnlistedIntakeCase(existing, projection.internalNotes, projection),
        replayed: true,
      };
    }

    let preferredWindowTimezone: string | null = null;
    if (parsed.preferredWindowStart && parsed.preferredWindowEnd) {
      preferredWindowTimezone = await resolveBuildingTimezoneForPreferredWindow(
        tx,
        authority.scope.buildingId,
      );
    }

    const attribution = await createChannelAttribution(
      {
        tenantCompanyId: parsed.tenantCompanyId,
        buildingId: authority.scope.buildingId,
        originChannel: 'CUSTOMER_CARE_BACKEND',
        createdByUserId: input.actorUserId,
        ...(parsed.tenantPicId ? { tenantPicId: parsed.tenantPicId } : {}),
        ...(parsed.spaceId ? { spaceId: parsed.spaceId } : {}),
      },
      tx,
    );

    const created =
      await handymanUnlistedIntakeRepository.insertUnlistedIntakeCase(tx, {
        clientId: attribution.clientId,
        buildingId: attribution.buildingId,
        spaceId: attribution.spaceId,
        tenantCompanyId: attribution.tenantCompanyId,
        tenantPicId: attribution.tenantPicId,
        approvalTenantCompanyId,
        costResponsibleTenantCompanyId,
        channelAttributionId: attribution.id,
        originChannel: 'CUSTOMER_CARE_BACKEND',
        originReference: attribution.originReference,
        requestedServiceName: parsed.requestedServiceName,
        description: parsed.description,
        preferredWindowStart: parsed.preferredWindowStart ?? null,
        preferredWindowEnd: parsed.preferredWindowEnd ?? null,
        preferredWindowTimezone,
        createdByUserId: input.actorUserId,
        createdByCareActorId: null,
        idempotencyKey: parsed.idempotencyKey,
        payloadHash,
      });

    await recordOperationalEvent(
      {
        clientId: created.clientId,
        eventType: 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CREATED',
        entityType: 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CASE',
        entityId: created.id,
        actorUserId: input.actorUserId,
        buildingId: created.buildingId,
        summary: `Unlisted service intake case created in PENDING_TRIAGE (${created.requestedServiceName}).`,
        metadata: {
          intakeCaseId: created.id,
          requestedServiceName: created.requestedServiceName,
          status: created.status,
          originChannel: created.originChannel,
          tenantCompanyId: created.tenantCompanyId,
          spaceId: created.spaceId,
        },
      },
      tx,
    );

    return {
      intakeCase: toPublicHandymanUnlistedIntakeCase(created, []),
      replayed: false,
    };
  });

  let createdNote: PublicHandymanInternalNoteMutationResult | undefined;
  if (parsed.rawInternalNote !== undefined) {
    try {
      createdNote = await createBuildingCareUnlistedIntakeInternalNote({
        actorUserId: input.actorUserId,
        buildingId: committed.intakeCase.buildingId,
        intakeCaseId: committed.intakeCase.id,
        body: normalizeInlineInternalNoteBody(
          parsed.rawInternalNote,
          parsed.idempotencyKey,
        ),
      });
    } catch (error) {
      attachCommittedIntakeCaseToNoteError(error, committed.intakeCase);
    }
  }

  const finalNotes = createdNote
    ? (
        await handymanInternalNotesRepository.listByUnlistedIntakeCaseScoped(
          undefined,
          {
            clientId: committed.intakeCase.clientId,
            buildingId: committed.intakeCase.buildingId,
            unlistedIntakeCaseId: committed.intakeCase.id,
          },
        )
      ).map(toPublicHandymanInternalNote)
    : committed.intakeCase.internalNotes;

  return {
    ...committed.intakeCase,
    internalNotes: finalNotes,
    replayed: committed.replayed,
    ...(createdNote ? { internalNote: createdNote } : {}),
  };
}

/**
 * Standalone Building Customer Care:
 *   GET /api/v1/handyman/care/buildings/:buildingId/unlisted-intake-cases/:intakeCaseId
 */
export async function getBuildingCareUnlistedIntakeCase(input: {
  actorUserId: string;
  buildingId: string;
  intakeCaseId: string;
}): Promise<PublicHandymanUnlistedIntakeCase> {
  const buildingId = parseUnlistedIntakeUuidParam(
    input.buildingId,
    'buildingId',
  );
  const intakeCaseId = parseUnlistedIntakeUuidParam(
    input.intakeCaseId,
    'intakeCaseId',
  );
  await assertNotCustomerFacingIntakeActor(input.actorUserId);
  const authority = await resolveBuildingCareAuthority({
    actorUserId: input.actorUserId,
    buildingId,
  });

  const record = await handymanUnlistedIntakeRepository.findById(
    undefined,
    intakeCaseId,
  );
  if (!record) {
    throw handymanUnlistedIntakeCaseNotFoundError();
  }
  if (
    record.clientId !== authority.scope.clientId ||
    record.buildingId !== authority.scope.buildingId
  ) {
    throw careAuthorityDeniedError();
  }

  const projection = await loadCaseProjection(getPool(), record);
  return toPublicHandymanUnlistedIntakeCase(record, projection.internalNotes, projection);
}

/**
 * Standalone Building Customer Care:
 *   GET /api/v1/handyman/care/buildings/:buildingId/unlisted-intake-cases
 */
export async function listBuildingCareUnlistedIntakeCases(input: {
  actorUserId: string;
  buildingId: string;
  query?: unknown;
}): Promise<HandymanUnlistedIntakeListPage> {
  const buildingId = parseUnlistedIntakeUuidParam(
    input.buildingId,
    'buildingId',
  );
  await assertNotCustomerFacingIntakeActor(input.actorUserId);
  const authority = await resolveBuildingCareAuthority({
    actorUserId: input.actorUserId,
    buildingId,
  });
  const q = parseUnlistedIntakeListQuery(input.query);
  if (q.buildingId && q.buildingId !== authority.scope.buildingId) {
    throw careAuthorityDeniedError();
  }
  if (q.clientId && q.clientId !== authority.scope.clientId) {
    throw careAuthorityDeniedError();
  }

  const rows = await handymanUnlistedIntakeRepository.listByBuildingScoped(
    undefined,
    {
      clientId: authority.scope.clientId,
      buildingId: authority.scope.buildingId,
      tenantCompanyId: q.tenantCompanyId,
      spaceId: q.spaceId,
      status: q.status,
      limit: q.limit + 1,
      offset: q.offset,
    },
  );
  const hasMore = rows.length > q.limit;
  const sliced = rows.slice(0, q.limit);
  const items: PublicHandymanUnlistedIntakeCase[] = [];
  for (const row of sliced) {
    const projection = await loadCaseProjection(getPool(), row);
    items.push(toPublicHandymanUnlistedIntakeCase(row, projection.internalNotes, projection));
  }

  return {
    items,
    pagination: {
      limit: q.limit,
      offset: q.offset,
      nextOffset: hasMore ? q.offset + q.limit : null,
    },
  };
}

/**
 * Care Workspace / Care Unlisted Intake:
 *   POST /api/v1/handyman/care/unlisted-intake-cases
 */
export async function createCareWorkspaceUnlistedIntakeCase(input: {
  bearerToken?: string;
  body: unknown;
  headerIdempotencyKey?: string;
}): Promise<PublicHandymanUnlistedIntakeMutationResult> {
  const parsed = parseCreateCareWorkspaceUnlistedIntakeBody(
    input.body,
    input.headerIdempotencyKey,
  );

  // Mode 1: Attested single-use Care exchangeToken in body
  if (parsed.exchangeToken) {
    const tokenHash = hashHandoffExchangeToken(parsed.exchangeToken);
    const existingExchange =
      await handoffRuntimeRepository.findExchangeByTokenHash(tokenHash);
    if (!existingExchange || !existingExchange.careActorId) {
      throw handoffExchangeInvalidError();
    }

    const expectedApproval =
      parsed.approvalTenantCompanyId ?? existingExchange.tenantCompanyId;
    const expectedCost =
      parsed.costResponsibleTenantCompanyId ?? existingExchange.tenantCompanyId;
    const payloadHash = computeUnlistedIntakePayloadHash({
      clientId: existingExchange.clientId,
      buildingId: existingExchange.buildingId,
      spaceId: existingExchange.spaceId,
      tenantCompanyId: existingExchange.tenantCompanyId,
      tenantPicId: existingExchange.tenantPicId,
      approvalTenantCompanyId: expectedApproval,
      costResponsibleTenantCompanyId: expectedCost,
      requestedServiceName: parsed.requestedServiceName,
      description: parsed.description,
      preferredWindowStart: parsed.preferredWindowStart ?? null,
      preferredWindowEnd: parsed.preferredWindowEnd ?? null,
    });

    const committed = await withTransaction(async (tx) => {
      await tx.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [
          'handyman_unlisted_intake',
          `care:${existingExchange.careActorId}:${parsed.idempotencyKey}`,
        ],
      );

      const prior =
        await handymanUnlistedIntakeRepository.findByActorAndIdempotencyKey(
          tx,
          { careActorId: existingExchange.careActorId! },
          parsed.idempotencyKey,
        );
      if (prior) {
        if (prior.payloadHash !== payloadHash) {
          throw handymanUnlistedIntakeIdempotencyConflictError();
        }
        const projection = await loadCaseProjection(tx, prior);
        return {
          intakeCase: toPublicHandymanUnlistedIntakeCase(prior, projection.internalNotes, projection),
          replayed: true,
          careActorId: existingExchange.careActorId!,
        };
      }

      const { attribution, exchange } =
        await bindCareHandoffExchangeInTransaction(parsed.exchangeToken!, tx);
      if (
        attribution.actorType !== 'CUSTOMER_CARE' ||
        !attribution.careActorId ||
        attribution.createdByUserId !== null ||
        attribution.careActorId !== exchange.careActorId ||
        !(await isCurrentCareRepresentation(exchange, tx))
      ) {
        throw handoffExchangeInvalidError();
      }

      if (
        (parsed.buildingId && parsed.buildingId !== attribution.buildingId) ||
        (parsed.tenantCompanyId &&
          parsed.tenantCompanyId !== attribution.tenantCompanyId) ||
        (parsed.spaceId !== null && parsed.spaceId !== attribution.spaceId)
      ) {
        throw handoffExchangeInvalidError();
      }

      let preferredWindowTimezone: string | null = null;
      if (parsed.preferredWindowStart && parsed.preferredWindowEnd) {
        preferredWindowTimezone =
          await resolveBuildingTimezoneForPreferredWindow(
            tx,
            attribution.buildingId,
          );
      }

      const created =
        await handymanUnlistedIntakeRepository.insertUnlistedIntakeCase(tx, {
          clientId: attribution.clientId,
          buildingId: attribution.buildingId,
          spaceId: attribution.spaceId,
          tenantCompanyId: attribution.tenantCompanyId,
          tenantPicId: attribution.tenantPicId,
          approvalTenantCompanyId: expectedApproval,
          costResponsibleTenantCompanyId: expectedCost,
          channelAttributionId: attribution.id,
          originChannel: 'BM_SUPER_APP',
          originReference: attribution.originReference,
          requestedServiceName: parsed.requestedServiceName,
          description: parsed.description,
          preferredWindowStart: parsed.preferredWindowStart ?? null,
          preferredWindowEnd: parsed.preferredWindowEnd ?? null,
          preferredWindowTimezone,
          createdByUserId: null,
          createdByCareActorId: attribution.careActorId,
          idempotencyKey: parsed.idempotencyKey,
          payloadHash,
        });

      await recordOperationalEvent(
        {
          clientId: created.clientId,
          eventType: 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CREATED',
          entityType: 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CASE',
          entityId: created.id,
          actorUserId: null,
          buildingId: created.buildingId,
          summary: `Unlisted service intake case created in PENDING_TRIAGE (${created.requestedServiceName}).`,
          metadata: {
            intakeCaseId: created.id,
            requestedServiceName: created.requestedServiceName,
            status: created.status,
            originChannel: created.originChannel,
            careActorId: attribution.careActorId,
            tenantCompanyId: created.tenantCompanyId,
            spaceId: created.spaceId,
          },
        },
        tx,
      );

      return {
        intakeCase: toPublicHandymanUnlistedIntakeCase(created, []),
        replayed: false,
        careActorId: attribution.careActorId,
      };
    });

    let createdNote: PublicHandymanInternalNoteMutationResult | undefined;
    if (parsed.rawInternalNote !== undefined && input.bearerToken) {
      try {
        createdNote = await createCareWorkspaceUnlistedIntakeInternalNote({
          bearerToken: input.bearerToken,
          intakeCaseId: committed.intakeCase.id,
          body: normalizeInlineInternalNoteBody(
            parsed.rawInternalNote,
            parsed.idempotencyKey,
          ),
        });
      } catch (error) {
        attachCommittedIntakeCaseToNoteError(error, committed.intakeCase);
      }
    }

    const finalNotes = createdNote
      ? (
          await handymanInternalNotesRepository.listByUnlistedIntakeCaseScoped(
            undefined,
            {
              clientId: committed.intakeCase.clientId,
              buildingId: committed.intakeCase.buildingId,
              unlistedIntakeCaseId: committed.intakeCase.id,
            },
          )
        ).map(toPublicHandymanInternalNote)
      : committed.intakeCase.internalNotes;

    return {
      ...committed.intakeCase,
      internalNotes: finalNotes,
      replayed: committed.replayed,
      ...(createdNote ? { internalNote: createdNote } : {}),
    };
  }

  // Mode 2 & 3: Bearer hcw_... workspace token or Care staff session
  if (!input.bearerToken) {
    throw workspaceUnauthorized();
  }

  if (!input.bearerToken.startsWith('hcw_')) {
    const session = await sessionService.resolveSessionContext(
      input.bearerToken,
    );
    return createBuildingCareUnlistedIntakeCase({
      actorUserId: session.userId,
      buildingId: parsed.buildingId!,
      body: input.body,
      headerIdempotencyKey: input.headerIdempotencyKey,
    });
  }

  const principal = await resolveCareWorkspacePrincipal(input.bearerToken);
  const buildingId = parsed.buildingId!;
  const tenantCompanyId = parsed.tenantCompanyId!;
  const expectedApproval = parsed.approvalTenantCompanyId ?? tenantCompanyId;
  const expectedCost = parsed.costResponsibleTenantCompanyId ?? tenantCompanyId;

  const committed = await withTransaction(async (tx) => {
    const bldgRow = await tx.query<{ client_id: string; property_id: string }>(
      `SELECT p.client_id, b.property_id
         FROM buildings b
         JOIN properties p ON p.id = b.property_id
        WHERE b.id = $1`,
      [buildingId],
    );
    const bldg = bldgRow.rows[0];
    if (
      !bldg ||
      (parsed.propertyId !== undefined &&
        parsed.propertyId !== bldg.property_id)
    ) {
      throw careCreateContextNotFound();
    }

    const { integrationCode } = await authorizeCareCommercialRequest(
      tx,
      principal,
      {
        id: randomUUID(),
        clientId: bldg.client_id,
        tenantCompanyId,
        tenantPicId: parsed.tenantPicId,
        buildingId,
        spaceId: parsed.spaceId,
      },
    );

    const payloadHash = computeUnlistedIntakePayloadHash({
      clientId: bldg.client_id,
      buildingId,
      spaceId: parsed.spaceId,
      tenantCompanyId,
      tenantPicId: parsed.tenantPicId,
      approvalTenantCompanyId: expectedApproval,
      costResponsibleTenantCompanyId: expectedCost,
      requestedServiceName: parsed.requestedServiceName,
      description: parsed.description,
      preferredWindowStart: parsed.preferredWindowStart ?? null,
      preferredWindowEnd: parsed.preferredWindowEnd ?? null,
    });

    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      'handyman_unlisted_intake',
      `care:${principal.careActorId}:${parsed.idempotencyKey}`,
    ]);

    const prior =
      await handymanUnlistedIntakeRepository.findByActorAndIdempotencyKey(
        tx,
        { careActorId: principal.careActorId },
        parsed.idempotencyKey,
      );
    if (prior) {
      if (prior.payloadHash !== payloadHash) {
        throw handymanUnlistedIntakeIdempotencyConflictError();
      }
      const projection = await loadCaseProjection(tx, prior);
      return {
        intakeCase: toPublicHandymanUnlistedIntakeCase(prior, projection.internalNotes, projection),
        replayed: true,
      };
    }

    let preferredWindowTimezone: string | null = null;
    if (parsed.preferredWindowStart && parsed.preferredWindowEnd) {
      preferredWindowTimezone = await resolveBuildingTimezoneForPreferredWindow(
        tx,
        buildingId,
      );
    }

    const actorRow = await tx.query<{ actor_reference: string }>(
      'SELECT actor_reference FROM handyman_handoff_care_actors WHERE id = $1',
      [principal.careActorId],
    );
    const actorReference =
      actorRow.rows[0]?.actor_reference ?? principal.careActorId;

    const attribution = await createChannelAttribution(
      {
        tenantCompanyId,
        buildingId,
        ...(parsed.tenantPicId ? { tenantPicId: parsed.tenantPicId } : {}),
        ...(parsed.spaceId ? { spaceId: parsed.spaceId } : {}),
        originChannel: 'BM_SUPER_APP',
        originReference: `bm-care-unlisted:${integrationCode}:${randomUUID()}`,
        actorType: 'CUSTOMER_CARE',
        careActorId: principal.careActorId,
        actorReference,
      },
      tx,
    );

    const created =
      await handymanUnlistedIntakeRepository.insertUnlistedIntakeCase(tx, {
        clientId: attribution.clientId,
        buildingId: attribution.buildingId,
        spaceId: attribution.spaceId,
        tenantCompanyId: attribution.tenantCompanyId,
        tenantPicId: attribution.tenantPicId,
        approvalTenantCompanyId: expectedApproval,
        costResponsibleTenantCompanyId: expectedCost,
        channelAttributionId: attribution.id,
        originChannel: 'BM_SUPER_APP',
        originReference: attribution.originReference,
        requestedServiceName: parsed.requestedServiceName,
        description: parsed.description,
        preferredWindowStart: parsed.preferredWindowStart ?? null,
        preferredWindowEnd: parsed.preferredWindowEnd ?? null,
        preferredWindowTimezone,
        createdByUserId: null,
        createdByCareActorId: principal.careActorId,
        idempotencyKey: parsed.idempotencyKey,
        payloadHash,
      });

    await recordOperationalEvent(
      {
        clientId: created.clientId,
        eventType: 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CREATED',
        entityType: 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CASE',
        entityId: created.id,
        actorUserId: null,
        buildingId: created.buildingId,
        summary: `Unlisted service intake case created in PENDING_TRIAGE (${created.requestedServiceName}).`,
        metadata: {
          intakeCaseId: created.id,
          requestedServiceName: created.requestedServiceName,
          status: created.status,
          originChannel: created.originChannel,
          careActorId: principal.careActorId,
          tenantCompanyId: created.tenantCompanyId,
          spaceId: created.spaceId,
        },
      },
      tx,
    );

    return {
      intakeCase: toPublicHandymanUnlistedIntakeCase(created, []),
      replayed: false,
    };
  });

  let createdNote: PublicHandymanInternalNoteMutationResult | undefined;
  if (parsed.rawInternalNote !== undefined) {
    try {
      createdNote = await createCareWorkspaceUnlistedIntakeInternalNote({
        bearerToken: input.bearerToken,
        intakeCaseId: committed.intakeCase.id,
        body: normalizeInlineInternalNoteBody(
          parsed.rawInternalNote,
          parsed.idempotencyKey,
        ),
      });
    } catch (error) {
      attachCommittedIntakeCaseToNoteError(error, committed.intakeCase);
    }
  }

  const finalNotes = createdNote
    ? (
        await handymanInternalNotesRepository.listByUnlistedIntakeCaseScoped(
          undefined,
          {
            clientId: committed.intakeCase.clientId,
            buildingId: committed.intakeCase.buildingId,
            unlistedIntakeCaseId: committed.intakeCase.id,
          },
        )
      ).map(toPublicHandymanInternalNote)
    : committed.intakeCase.internalNotes;

  return {
    ...committed.intakeCase,
    internalNotes: finalNotes,
    replayed: committed.replayed,
    ...(createdNote ? { internalNote: createdNote } : {}),
  };
}

/**
 * Care Workspace / Care Unlisted Intake detail read:
 *   GET /api/v1/handyman/care/unlisted-intake-cases/:intakeCaseId
 */
export async function getCareWorkspaceUnlistedIntakeCase(input: {
  bearerToken: string;
  intakeCaseId: string;
  query?: unknown;
}): Promise<PublicHandymanUnlistedIntakeCase> {
  if (!input.bearerToken) {
    throw workspaceUnauthorized();
  }
  const intakeCaseId = parseUnlistedIntakeUuidParam(
    input.intakeCaseId,
    'intakeCaseId',
  );
  const q = parseUnlistedIntakeListQuery(input.query);

  if (input.bearerToken.startsWith('hcw_')) {
    const principal = await resolveCareWorkspacePrincipal(input.bearerToken);
    return withTransaction(async (tx) => {
      const record = await handymanUnlistedIntakeRepository.findById(
        tx,
        intakeCaseId,
      );
      if (!record) {
        throw careCreateContextNotFound();
      }
      if (
        (q.tenantCompanyId && q.tenantCompanyId !== record.tenantCompanyId) ||
        (q.buildingId && q.buildingId !== record.buildingId) ||
        (q.spaceId && q.spaceId !== record.spaceId)
      ) {
        throw careCreateContextNotFound();
      }
      if (q.propertyId) {
        const bldgRow = await tx.query<{ property_id: string }>(
          'SELECT property_id FROM buildings WHERE id = $1',
          [record.buildingId],
        );
        if (bldgRow.rows[0]?.property_id !== q.propertyId) {
          throw careCreateContextNotFound();
        }
      }
      await authorizeCareCommercialRequest(tx, principal, {
        id: record.id,
        clientId: record.clientId,
        tenantCompanyId: record.tenantCompanyId,
        tenantPicId: record.tenantPicId,
        buildingId: record.buildingId,
        spaceId: record.spaceId,
      });
      const projection = await loadCaseProjection(tx, record);
      return toPublicHandymanUnlistedIntakeCase(record, projection.internalNotes, projection);
    });
  }

  const session = await sessionService.resolveSessionContext(input.bearerToken);
  await assertNotCustomerFacingIntakeActor(session.userId);
  const record = await handymanUnlistedIntakeRepository.findById(
    undefined,
    intakeCaseId,
  );
  if (!record) {
    throw handymanUnlistedIntakeCaseNotFoundError();
  }
  await resolveBuildingCareAuthority({
    actorUserId: session.userId,
    buildingId: record.buildingId,
    assertedClientId: record.clientId,
  });
  const projection = await loadCaseProjection(getPool(), record);
  return toPublicHandymanUnlistedIntakeCase(record, projection.internalNotes, projection);
}

/**
 * Care Workspace / Care Unlisted Intake list:
 *   GET /api/v1/handyman/care/unlisted-intake-cases
 */
export async function listCareWorkspaceUnlistedIntakeCases(input: {
  bearerToken: string;
  query?: unknown;
}): Promise<HandymanUnlistedIntakeListPage> {
  if (!input.bearerToken) {
    throw workspaceUnauthorized();
  }
  const q = parseUnlistedIntakeListQuery(input.query);

  if (input.bearerToken.startsWith('hcw_')) {
    const principal = await resolveCareWorkspacePrincipal(input.bearerToken);
    const rows =
      await handymanUnlistedIntakeRepository.listForCareWorkspaceScoped(
        undefined,
        {
          careActorId: principal.careActorId,
          propertyId: q.propertyId,
          buildingId: q.buildingId,
          tenantCompanyId: q.tenantCompanyId,
          spaceId: q.spaceId,
          status: q.status,
          limit: q.limit + 1,
          offset: q.offset,
        },
      );
    const hasMore = rows.length > q.limit;
    const sliced = rows.slice(0, q.limit);
    const items: PublicHandymanUnlistedIntakeCase[] = [];
    for (const row of sliced) {
      const projection = await loadCaseProjection(getPool(), row);
      items.push(toPublicHandymanUnlistedIntakeCase(row, projection.internalNotes, projection));
    }
    return {
      items,
      pagination: {
        limit: q.limit,
        offset: q.offset,
        nextOffset: hasMore ? q.offset + q.limit : null,
      },
    };
  }

  const session = await sessionService.resolveSessionContext(input.bearerToken);
  await assertNotCustomerFacingIntakeActor(session.userId);
  if (q.buildingId) {
    return listBuildingCareUnlistedIntakeCases({
      actorUserId: session.userId,
      buildingId: q.buildingId,
      query: input.query,
    });
  }
  return listOperationsUnlistedIntakeCases({
    actorUserId: session.userId,
    query: input.query,
  });
}

/**
 * Operations Unlisted Intake Triage Queue:
 *   GET /api/v1/handyman/operations/unlisted-intake-cases
 *
 * Lists pending (`PENDING_TRIAGE` by default) unlisted service intake cases
 * within the authorized Operations actor's Client/Building scope (BE-02G).
 */
export async function listOperationsUnlistedIntakeCases(input: {
  actorUserId: string;
  query?: unknown;
}): Promise<HandymanUnlistedIntakeListPage> {
  await assertOperationsOrCareReadSessionAuthority(input.actorUserId);
  const q = parseUnlistedIntakeListQuery(input.query);

  if (q.buildingId) {
    const bldgClient = await getPool().query<{ client_id: string }>(
      `SELECT p.client_id
         FROM buildings b
         JOIN properties p ON p.id = b.property_id
        WHERE b.id = $1`,
      [q.buildingId],
    );
    const resolvedClientId = bldgClient.rows[0]?.client_id;
    if (
      !resolvedClientId ||
      (q.clientId && q.clientId !== resolvedClientId)
    ) {
      throw buildingAccessDeniedError();
    }
    await assertBuildingScopedResourceAccess(input.actorUserId, {
      clientId: resolvedClientId,
      buildingId: q.buildingId,
    });
  } else if (q.clientId) {
    if (
      !(await contextAccessService.canAccessClient(
        input.actorUserId,
        q.clientId,
      ))
    ) {
      throw buildingAccessDeniedError();
    }
  }

  const rows =
    await handymanUnlistedIntakeRepository.listForOperationsTriageScoped(
      undefined,
      {
        actorUserId: input.actorUserId,
        clientId: q.clientId,
        buildingId: q.buildingId,
        tenantCompanyId: q.tenantCompanyId,
        spaceId: q.spaceId,
        status: q.status ?? 'PENDING_TRIAGE',
        limit: q.limit + 1,
        offset: q.offset,
      },
    );

  const hasMore = rows.length > q.limit;
  const sliced = rows.slice(0, q.limit);
  const items: PublicHandymanUnlistedIntakeCase[] = [];
  for (const row of sliced) {
    const projection = await loadCaseProjection(getPool(), row);
    items.push(toPublicHandymanUnlistedIntakeCase(row, projection.internalNotes, projection));
  }

  return {
    items,
    pagination: {
      limit: q.limit,
      offset: q.offset,
      nextOffset: hasMore ? q.offset + q.limit : null,
    },
  };
}

/**
 * Shared Operations & Customer Care Unlisted Intake detail read:
 *   GET /api/v1/handyman/unlisted-intake-cases/:intakeCaseId
 */
export async function getUnlistedIntakeCase(input: {
  bearerToken?: string;
  actorUserId?: string;
  intakeCaseId: string;
  query?: unknown;
}): Promise<PublicHandymanUnlistedIntakeCase> {
  const intakeCaseId = parseUnlistedIntakeUuidParam(
    input.intakeCaseId,
    'intakeCaseId',
  );

  if (input.bearerToken?.startsWith('hcw_')) {
    return getCareWorkspaceUnlistedIntakeCase({
      bearerToken: input.bearerToken,
      intakeCaseId,
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

  await assertOperationsOrCareReadSessionAuthority(actorUserId);

  const record = await handymanUnlistedIntakeRepository.findById(
    undefined,
    intakeCaseId,
  );
  if (!record) {
    throw handymanUnlistedIntakeCaseNotFoundError();
  }

  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: record.clientId,
    buildingId: record.buildingId,
  });

  const projection = await loadCaseProjection(getPool(), record);
  return toPublicHandymanUnlistedIntakeCase(record, projection.internalNotes, projection);
}

export const handymanUnlistedIntakeService = {
  createBuildingCareUnlistedIntakeCase,
  getBuildingCareUnlistedIntakeCase,
  listBuildingCareUnlistedIntakeCases,
  createCareWorkspaceUnlistedIntakeCase,
  getCareWorkspaceUnlistedIntakeCase,
  listCareWorkspaceUnlistedIntakeCases,
  listOperationsUnlistedIntakeCases,
  getUnlistedIntakeCase,
  computeUnlistedIntakePayloadHash,
  toPublicHandymanUnlistedIntakeCase,
  computeUnlistedIntakeTriagePayloadHash,
  recordUnlistedIntakeTriageDecision,
  listUnlistedIntakeTriageDecisions,
  computeUnlistedIntakeConversionPayloadHash,
  convertUnlistedIntakeCaseToServiceRequest,
  toPublicHandymanUnlistedIntakeTriageDecision,
};

// ==========================================================================
// CR-HM-MANUAL-QUOTATION-01 PART 01 — authorized Operations triage.
//
// One append-only decision per case, projected into exactly one governed
// status. Nothing here creates a `service_catalog` row, a quotation, an
// execution scope, an assignment or a customer approval: `MATCH_EXISTING_
// CATALOG_SERVICE` only anchors an ALREADY-EXISTING ACTIVE entry of THIS
// Client, and `ONE_TIME_MANUAL_QUOTATION_REQUIRED` only records the
// requirement PART 02 quotes against. Triage is therefore a classification
// fact, never a commercial commitment.
// ==========================================================================

export function computeUnlistedIntakeTriagePayloadHash(input: {
  intakeCaseId: string;
  decision: string;
  statusAfter: HandymanUnlistedIntakeStatus;
  justification: string;
  clarificationRequest: string | null;
  catalogServiceId: string | null;
  customServiceName: string | null;
  customServiceNotes: string | null;
  manualQuoteSummary: string | null;
  manualQuoteQuantity: string | null;
  manualQuoteUomId: string | null;
}): string {
  return createHash('sha256')
    .update(stableJson(input))
    .digest('hex');
}

async function assertOperationsTriageAuthority(
  actorUserId: string,
  actionLabel = 'record an unlisted intake triage decision',
): Promise<void> {
  await assertNotCustomerFacingIntakeActor(actorUserId);
  const user = await userRepository.findById(actorUserId);
  if (!user || user.status !== 'ACTIVE') {
    throw handymanUnlistedIntakeForbiddenError();
  }
  const permissions =
    await permissionService.resolvePermissionsForUser(actorUserId);
  // Triage is a management write on Handyman commercial intake: the SAME
  // governed vocabulary as every other Handyman quotation write. Care
  // mediation authority (`handyman.care.building`) is deliberately NOT
  // sufficient — the Care actor never classifies its own intake.
  if (!permissions.includes('tenant_company.manage')) {
    throw handymanUnlistedIntakeForbiddenError(
      `Only authorized Handyman Operations personnel may ${actionLabel}.`,
    );
  }
}

/**
 * POST /api/v1/handyman/operations/unlisted-intake-cases/:intakeCaseId/triage-decisions
 */
export async function recordUnlistedIntakeTriageDecision(input: {
  actorUserId: string;
  intakeCaseId: string;
  body: unknown;
  headerIdempotencyKey?: string;
}): Promise<PublicHandymanUnlistedIntakeTriageMutationResult> {
  const intakeCaseId = parseUnlistedIntakeUuidParam(
    input.intakeCaseId,
    'intakeCaseId',
  );
  const parsed = parseUnlistedIntakeTriageBody(
    input.body,
    input.headerIdempotencyKey,
  );
  await assertOperationsTriageAuthority(input.actorUserId);

  const statusAfter: HandymanUnlistedIntakeStatus =
    HANDYMAN_UNLISTED_INTAKE_TRIAGE_PROJECTION[parsed.decision];

  const payloadHash = computeUnlistedIntakeTriagePayloadHash({
    intakeCaseId,
    decision: parsed.decision,
    statusAfter,
    justification: parsed.justification,
    clarificationRequest: parsed.clarificationRequest,
    catalogServiceId: parsed.catalogServiceId,
    customServiceName: parsed.customServiceName,
    customServiceNotes: parsed.customServiceNotes,
    manualQuoteSummary: parsed.manualQuoteSummary,
    manualQuoteQuantity: parsed.manualQuoteQuantity,
    manualQuoteUomId: parsed.manualQuoteUomId,
  });

  return withTransaction(async (tx) => {
    // Per-case serialization: a concurrent second decision on the same case
    // waits here, then observes the committed projection and is refused.
    await tx.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['handyman_unlisted_intake_triage', intakeCaseId],
    );

    const caseRow =
      await handymanUnlistedIntakeRepository.findCaseForTriageLock(
        tx,
        intakeCaseId,
      );
    if (!caseRow) {
      throw handymanUnlistedIntakeCaseNotFoundError();
    }
    await assertBuildingScopedResourceAccess(input.actorUserId, {
      clientId: caseRow.clientId,
      buildingId: caseRow.buildingId,
    });

    const replayed =
      await handymanUnlistedIntakeRepository.findTriageDecisionByCaseAndIdempotencyKey(
        tx,
        intakeCaseId,
        parsed.idempotencyKey,
      );
    if (replayed) {
      if (replayed.payloadHash !== payloadHash) {
        throw handymanUnlistedIntakeTriageIdempotencyConflictError();
      }
      const refreshed = await handymanUnlistedIntakeRepository.findById(
        tx,
        intakeCaseId,
      );
      if (!refreshed) throw handymanUnlistedIntakeCaseNotFoundError();
      const projection = await loadCaseProjection(tx, refreshed);
      return {
        replayed: true,
        decision: toPublicHandymanUnlistedIntakeTriageDecision(replayed),
        intakeCase: toPublicHandymanUnlistedIntakeCase(
          refreshed,
          projection.internalNotes,
          projection,
        ),
      };
    }

    const history =
      await handymanUnlistedIntakeRepository.listTriageDecisionsByCase(tx, {
        clientId: caseRow.clientId,
        buildingId: caseRow.buildingId,
        intakeCaseId,
      });
    const hasEffectiveDecision =
      caseRow.hasEffectiveDecision ||
      history.some(
        (row) => row.decision !== 'REQUEST_MORE_INFORMATION_OR_INSPECTION',
      );
    if (
      !(
        HANDYMAN_UNLISTED_INTAKE_TRIAGE_ELIGIBLE_STATUSES as readonly string[]
      ).includes(caseRow.status) ||
      hasEffectiveDecision
    ) {
      throw handymanUnlistedIntakeTriageAlreadyRecordedError(caseRow.status);
    }
    // Exactly one clarification round is permitted: it keeps
    // REQUEST_MORE_INFORMATION_OR_INSPECTION a real lane (the case returns to
    // the Operations queue after Care/tenant answers) without letting an
    // unlisted case live in an open question forever.
    if (
      parsed.decision === 'REQUEST_MORE_INFORMATION_OR_INSPECTION' &&
      history.length > 0
    ) {
      throw handymanUnlistedIntakeTriageAlreadyRecordedError(
        caseRow.status,
        'An unlisted service intake case may request more information or an inspection only once before it is classified.',
      );
    }

    if (parsed.catalogServiceId !== null) {
      const anchored =
        await handymanUnlistedIntakeRepository.findCatalogServiceForTriage(
          tx,
          caseRow.clientId,
          parsed.catalogServiceId,
        );
      if (!anchored) {
        throw handymanUnlistedIntakeTriageCatalogServiceInvalidError();
      }
    }
    if (parsed.manualQuoteUomId !== null) {
      const uom = await handymanUnlistedIntakeRepository.findActiveUomForTriage(
        tx,
        parsed.manualQuoteUomId,
      );
      if (!uom) {
        throw handymanUnlistedIntakeTriageUomInvalidError();
      }
    }

    const decisionInput: NewHandymanUnlistedIntakeTriageDecisionInput = {
      clientId: caseRow.clientId,
      buildingId: caseRow.buildingId,
      tenantCompanyId: caseRow.tenantCompanyId,
      intakeCaseId,
      decision: parsed.decision,
      statusAfter,
      justification: parsed.justification,
      clarificationRequest: parsed.clarificationRequest,
      catalogServiceId: parsed.catalogServiceId,
      customServiceName: parsed.customServiceName,
      customServiceNotes: parsed.customServiceNotes,
      manualQuoteSummary: parsed.manualQuoteSummary,
      manualQuoteQuantity: parsed.manualQuoteQuantity,
      manualQuoteUomId: parsed.manualQuoteUomId,
      triagedByUserId: input.actorUserId,
      idempotencyKey: parsed.idempotencyKey,
      payloadHash,
    };

    const decision =
      await handymanUnlistedIntakeRepository.insertTriageDecision(
        tx,
        decisionInput,
      );
    await handymanUnlistedIntakeRepository.projectCaseTriageState(tx, {
      intakeCaseId,
      // A clarification round records the immutable question without becoming
      // the case's effective decision.
      decisionId:
        parsed.decision === 'REQUEST_MORE_INFORMATION_OR_INSPECTION'
          ? null
          : decision.id,
      status: statusAfter,
    });

    await recordOperationalEvent(
      {
        clientId: caseRow.clientId,
        buildingId: caseRow.buildingId,
        actorUserId: input.actorUserId,
        eventType: 'HANDYMAN_UNLISTED_SERVICE_INTAKE_TRIAGED',
        entityType: 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CASE',
        entityId: intakeCaseId,
        summary: `Unlisted service intake case triaged by Operations (${parsed.decision} -> ${statusAfter}).`,
        metadata: {
          intakeCaseId,
          triageDecisionId: decision.id,
          decision: parsed.decision,
          statusAfter,
          manualQuotationRequired:
            parsed.decision === 'ONE_TIME_MANUAL_QUOTATION_REQUIRED',
          catalogServiceId: parsed.catalogServiceId,
        },
      },
      tx,
    );

    const updated = await handymanUnlistedIntakeRepository.findById(
      tx,
      intakeCaseId,
    );
    if (!updated) throw handymanUnlistedIntakeCaseNotFoundError();
    const projection = await loadCaseProjection(tx, updated);

    return {
      replayed: false,
      decision: toPublicHandymanUnlistedIntakeTriageDecision(decision),
      intakeCase: toPublicHandymanUnlistedIntakeCase(
        updated,
        projection.internalNotes,
        projection,
      ),
    };
  });
}

/**
 * GET /api/v1/handyman/operations/unlisted-intake-cases/:intakeCaseId/triage-decisions
 * — the full append-only triage history (clarification rounds included).
 */
export async function listUnlistedIntakeTriageDecisions(input: {
  actorUserId: string;
  intakeCaseId: string;
}): Promise<PublicHandymanUnlistedIntakeTriageDecision[]> {
  const intakeCaseId = parseUnlistedIntakeUuidParam(
    input.intakeCaseId,
    'intakeCaseId',
  );
  await assertOperationsOrCareReadSessionAuthority(input.actorUserId);

  const record = await handymanUnlistedIntakeRepository.findById(
    undefined,
    intakeCaseId,
  );
  if (!record) {
    throw handymanUnlistedIntakeCaseNotFoundError();
  }
  await assertBuildingScopedResourceAccess(input.actorUserId, {
    clientId: record.clientId,
    buildingId: record.buildingId,
  });

  const rows =
    await handymanUnlistedIntakeRepository.listTriageDecisionsByCase(
      undefined,
      {
        clientId: record.clientId,
        buildingId: record.buildingId,
        intakeCaseId,
      },
    );
  return rows.map(toPublicHandymanUnlistedIntakeTriageDecision);
}


// ==========================================================================
// CR-HM-MANUAL-QUOTATION-01 PART 02 — one triaged case -> one formal request.
//
// Only a case whose effective triage decision is
// ONE_TIME_MANUAL_QUOTATION_READY (status TRIAGED_MANUAL_QUOTATION_READY) may
// be converted, and it may be converted exactly ONCE: the binding is written
// onto the same 0487 state row that anchors the decision, so the request and
// the case name each other and neither can be re-pointed. The created request
// is a REAL handyman_service_requests row with `service_catalog_id`/
// `service_variant_id` structurally NULL (0488 refuses any value there), which
// is precisely what keeps this from fabricating a catalog entry. Quotation
// pricing and customer approval are untouched: the request is born in
// 'INTAKE' and must still earn an approved quotation version before any
// execution scope or assignment can exist.
// ==========================================================================

export function computeUnlistedIntakeConversionPayloadHash(input: {
  intakeCaseId: string;
  clientId: string;
  buildingId: string;
  spaceId: string | null;
  tenantCompanyId: string;
  tenantPicId: string | null;
  channelAttributionId: string | null;
  originChannel: string;
  originReference: string | null;
  description: string;
  triageDecisionId: string;
}): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

/**
 * Re-proves, inside the conversion transaction, the exact identity/scope law
 * the intake case had to satisfy when it was created (0486 + Care authority).
 * A conversion never relaxes it: if the verified Customer, the effective
 * Building context or the Client lineage has gone, the request is refused.
 */
async function assertUnlistedIntakeConversionScopeVerified(
  tx: Pick<PoolClient, 'query'>,
  caseRow: NonNullable<
    Awaited<
      ReturnType<
        typeof handymanUnlistedIntakeRepository.findCaseForConversionLock
      >
    >
  >,
): Promise<void> {
  const buildingClientId =
    await handymanUnlistedIntakeRepository.findBuildingClientId(
      tx,
      caseRow.buildingId,
    );
  if (!buildingClientId || buildingClientId !== caseRow.clientId) {
    throw handymanUnlistedIntakeConversionScopeUnverifiedError(
      'BUILDING_CLIENT_LINEAGE',
    );
  }

  const company = await tenantCompanyRepository.findById(caseRow.tenantCompanyId);
  const context = company
    ? await tenantBuildingContextRepository.findActive(
        company.id,
        caseRow.buildingId,
      )
    : null;
  if (
    !company ||
    company.status !== 'ACTIVE' ||
    company.clientId !== caseRow.clientId ||
    !context ||
    !isEffectiveNow(context)
  ) {
    throw handymanUnlistedIntakeConversionScopeUnverifiedError(
      'TENANT_BUILDING_CONTEXT',
    );
  }

  for (const partyId of new Set([
    caseRow.approvalTenantCompanyId,
    caseRow.costResponsibleTenantCompanyId,
  ])) {
    const party = await tenantCompanyRepository.findById(partyId);
    if (!party) {
      throw handymanUnlistedIntakeConversionScopeUnverifiedError(
        'COMMERCIAL_PARTY_MISSING',
      );
    }
    if (party.verificationStatus !== 'VERIFIED') {
      throw tenantVerificationRequiredError();
    }
    if (partyId === caseRow.tenantCompanyId) continue;
    if (party.status !== 'ACTIVE' || party.clientId !== caseRow.clientId) {
      throw handymanUnlistedIntakeConversionScopeUnverifiedError(
        'COMMERCIAL_PARTY_SCOPE',
      );
    }
  }

  if (caseRow.tenantPicId !== null) {
    // The preserved complaint identity must still be a PIC OF THIS Tenant; a
    // silently re-pointed PIC would put another Customer's request on file.
    const picScope = await tx.query<{ tenant_company_id: string }>(
      `SELECT tenant_company_id FROM tenant_pics WHERE id = $1`,
      [caseRow.tenantPicId],
    );
    if (picScope.rows[0]?.tenant_company_id !== caseRow.tenantCompanyId) {
      throw handymanUnlistedIntakeConversionScopeUnverifiedError(
        'TENANT_PIC_SCOPE',
      );
    }
  }
}

function toPublicHandymanUnlistedIntakeRequestConversion(
  row: HandymanUnlistedIntakeServiceRequestRow,
  convertedAt: Date,
): PublicHandymanUnlistedIntakeRequestConversion {
  return {
    requestId: row.id,
    intakeCaseId: row.unlistedIntakeCaseId,
    clientId: row.clientId,
    buildingId: row.buildingId,
    spaceId: row.spaceId,
    tenantCompanyId: row.tenantCompanyId,
    tenantPicId: row.tenantPicId,
    intakeSource: HANDYMAN_UNLISTED_INTAKE_REQUEST_INTAKE_SOURCE,
    serviceCatalogId: null,
    serviceVariantId: null,
    channelAttributionId: row.channelAttributionId,
    originChannel: row.originChannel,
    originReference: row.originReference,
    description: row.description,
    status: row.status,
    convertedAt: convertedAt.toISOString(),
  };
}

/**
 * POST /api/v1/handyman/operations/unlisted-intake-cases/:intakeCaseId/service-request
 */
export async function convertUnlistedIntakeCaseToServiceRequest(input: {
  actorUserId: string;
  intakeCaseId: string;
  body: unknown;
  headerIdempotencyKey?: string;
}): Promise<PublicHandymanUnlistedIntakeConversionMutationResult> {
  const intakeCaseId = parseUnlistedIntakeUuidParam(
    input.intakeCaseId,
    'intakeCaseId',
  );
  const parsed = parseUnlistedIntakeConversionBody(
    input.body,
    input.headerIdempotencyKey,
  );
  await assertOperationsTriageAuthority(
    input.actorUserId,
    'convert an unlisted intake case into a formal service request',
  );

  return withTransaction(async (tx) => {
    // A separate lock namespace from triage: the conversion command mutates the
    // state row the triage command produced, never the decision facts.
    await tx.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['handyman_unlisted_intake_conversion', intakeCaseId],
    );

    const caseRow =
      await handymanUnlistedIntakeRepository.findCaseForConversionLock(
        tx,
        intakeCaseId,
      );
    if (!caseRow) {
      throw handymanUnlistedIntakeCaseNotFoundError();
    }
    await assertBuildingScopedResourceAccess(input.actorUserId, {
      clientId: caseRow.clientId,
      buildingId: caseRow.buildingId,
    });

    const state =
      await handymanUnlistedIntakeRepository.lockTriageStateForConversion(
        tx,
        intakeCaseId,
      );

    const payloadHash = computeUnlistedIntakeConversionPayloadHash({
      intakeCaseId,
      clientId: caseRow.clientId,
      buildingId: caseRow.buildingId,
      spaceId: caseRow.spaceId,
      tenantCompanyId: caseRow.tenantCompanyId,
      tenantPicId: caseRow.tenantPicId,
      channelAttributionId: caseRow.channelAttributionId,
      originChannel: caseRow.originChannel,
      originReference: caseRow.originReference,
      description: caseRow.description,
      triageDecisionId: state?.triageDecisionId ?? '',
    });

    if (state?.convertedRequestId) {
      // Exactly-once conversion: only the command that owns the recorded key
      // and the identical derived payload replays. Anything else on an already
      // converted case is a refusal, never a second request.
      if (
        state.conversionIdempotencyKey !== parsed.idempotencyKey ||
        state.conversionPayloadHash !== payloadHash
      ) {
        throw handymanUnlistedIntakeConversionIdempotencyConflictError();
      }
      const existing =
        await handymanUnlistedIntakeRepository.findManualOriginRequestById(
          tx,
          state.convertedRequestId,
        );
      const refreshed = await handymanUnlistedIntakeRepository.findById(
        tx,
        intakeCaseId,
      );
      if (!existing || !refreshed) {
        throw handymanUnlistedIntakeCaseNotFoundError();
      }
      const projection = await loadCaseProjection(tx, refreshed);
      return {
        replayed: true,
        conversion: toPublicHandymanUnlistedIntakeRequestConversion(
          existing,
          refreshed.convertedAt ?? new Date(),
        ),
        intakeCase: toPublicHandymanUnlistedIntakeCase(
          refreshed,
          projection.internalNotes,
          projection,
        ),
      };
    }

    // Only the manual-quotation-ready branch converts, and only through its own
    // anchored decision — never because a caller asked nicely.
    if (
      caseRow.status !== 'TRIAGED_MANUAL_QUOTATION_READY' ||
      !state ||
      caseRow.anchorDecision !== 'ONE_TIME_MANUAL_QUOTATION_REQUIRED'
    ) {
      throw handymanUnlistedIntakeConversionNotEligibleError(
        caseRow.existingRequestCount > 0
          ? 'ALREADY_CONVERTED'
          : 'MANUAL_QUOTATION_READINESS_REQUIRED',
      );
    }

    await assertUnlistedIntakeConversionScopeVerified(tx, caseRow);

    if (caseRow.channelAttributionId !== null) {
      const used =
        await handymanUnlistedIntakeRepository.countRequestsUsingAttribution(
          tx,
          caseRow.channelAttributionId,
        );
      if (used > 0) {
        throw handymanUnlistedIntakeConversionAttributionConflictError();
      }
    }

    const requestId = randomUUID();
    const request =
      await handymanUnlistedIntakeRepository.insertManualOriginServiceRequest(
        tx,
        {
          id: requestId,
          clientId: caseRow.clientId,
          buildingId: caseRow.buildingId,
          spaceId: caseRow.spaceId,
          tenantCompanyId: caseRow.tenantCompanyId,
          tenantPicId: caseRow.tenantPicId,
          channelAttributionId: caseRow.channelAttributionId,
          originChannel: caseRow.originChannel,
          originReference: caseRow.originReference,
          description: caseRow.description,
          intakeCaseId,
          createdByUserId: input.actorUserId,
        },
      );
    await handymanUnlistedIntakeRepository.projectCaseConversion(tx, {
      intakeCaseId,
      requestId,
      idempotencyKey: parsed.idempotencyKey,
      payloadHash,
    });

    await recordOperationalEvent(
      {
        clientId: caseRow.clientId,
        buildingId: caseRow.buildingId,
        actorUserId: input.actorUserId,
        eventType: 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CONVERTED',
        entityType: 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CASE',
        entityId: intakeCaseId,
        summary:
          'Unlisted service intake case converted by Operations into one manual-origin service request.',
        metadata: {
          intakeCaseId,
          handymanRequestId: requestId,
          triageDecisionId: state.triageDecisionId,
          intakeSource: HANDYMAN_UNLISTED_INTAKE_REQUEST_INTAKE_SOURCE,
          serviceCatalogId: null,
          channelAttributionId: caseRow.channelAttributionId,
        },
      },
      tx,
    );

    const updated = await handymanUnlistedIntakeRepository.findById(
      tx,
      intakeCaseId,
    );
    if (!updated) throw handymanUnlistedIntakeCaseNotFoundError();
    const projection = await loadCaseProjection(tx, updated);

    return {
      replayed: false,
      conversion: toPublicHandymanUnlistedIntakeRequestConversion(
        request,
        updated.convertedAt ?? new Date(),
      ),
      intakeCase: toPublicHandymanUnlistedIntakeCase(
        updated,
        projection.internalNotes,
        projection,
      ),
    };
  });
}
