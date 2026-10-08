import { AppError } from '../../shared/errors';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanRequestDiagnosisRepository,
  handymanServiceRequestNotFoundError,
  handymanServiceRequestRepository,
} from '../handyman-requests';
import { handymanQuotationRepository } from './handyman-quotation.repository';
import {
  handymanQuotationAlreadyExistsError,
  handymanQuotationDiagnosisRequiredError,
  handymanQuotationNotFoundError,
  handymanQuotationScopeInsufficientError,
} from './handyman-quotation.errors';
import type {
  CreateHandymanQuotationInput,
  HandymanQuotationRecord,
  HandymanQuotationVersionRecord,
  PublicHandymanQuotation,
  PublicHandymanQuotationBundle,
  PublicHandymanQuotationVersion,
} from './handyman-quotation.types';

/**
 * CR-HM-06 PART 01 — Handyman quotation foundation service (FROZEN
 * Decision Freeze F1–F5). Bounded to: first-version quotation creation
 * (atomic root + version 1 DRAFT), DRAFT revision append (monotonic,
 * concurrency-safe), and an exact request-scoped read bundle.
 *
 * Lineage is SERVER-DERIVED from the CR-HM-02 request chain only (F1):
 * clientId/client scope/attribution/diagnosis authority NEVER come from
 * the caller. Quotation preparation requires the CR-HM-03 diagnosis
 * record to exist and its SERVER-DERIVED scope classification to be
 * Handyman-quotable (anything except OUT_OF_HANDYMAN_SCOPE) — the free
 * text `service_catalog.category` is never consulted. NO lifecycle
 * transitions (PART 03), lines (PART 02), approval (PART 04) or
 * execution scope (PART 05) exist here; NO FM/vendor quotation linkage.
 */

function assertUuid(value: string | undefined, field: string): void {
  if (value === undefined || !isValidUuid(value)) {
    throw AppError.validation('Quotation validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
}

/** Scope classifications that support quotation preparation (CR-HM-03). */
const QUOTABLE_SCOPE_CLASSES = new Set(['GENERAL_HANDYMAN', 'SPECIALIST']);

function toPublicQuotation(
  row: HandymanQuotationRecord,
): PublicHandymanQuotation {
  return {
    id: row.id,
    clientId: row.clientId,
    handymanRequestId: row.handymanRequestId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPublicVersion(
  row: HandymanQuotationVersionRecord,
): PublicHandymanQuotationVersion {
  return {
    id: row.id,
    quotationId: row.quotationId,
    versionNumber: row.versionNumber,
    status: row.status,
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** First quotation thread: root + version 1 DRAFT, atomically (F1/F2). */
export async function createHandymanQuotation(
  input: CreateHandymanQuotationInput,
  actorUserId: string,
): Promise<PublicHandymanQuotationBundle> {
  assertUuid(input.handymanRequestId, 'handymanRequestId');
  assertUuid(actorUserId, 'actorUserId');

  return withTransaction(async (tx) => {
    // 1) Parent authority: the CR-HM-02 request must exist; lock it so
    //    first-version creation serializes on the source request.
    const request = await handymanServiceRequestRepository.lockById(
      tx,
      input.handymanRequestId,
    );
    if (!request) throw handymanServiceRequestNotFoundError();

    // 2) Realm authority (CR-HM-SEC-01 PART 01): the request is a
    //    BUILDING-scoped resource (`handyman_service_requests.building_id
    //    UUID NOT NULL`, server-derived). Per BE-02G, authority is the
    //    actor's explicit ACTIVE assignment to the request's exact
    //    Building — one assignment under the Client is NOT client-wide
    //    privilege (no same-Client shortcut), and no existing role/scope
    //    contract grants client-wide access. Never caller-shaped context.
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: request.clientId,
      buildingId: request.buildingId,
    });

    // 3) CR-HM-03 sufficiency gate: an authoritative diagnosis/scope
    //    record must exist and be quotable (server-derived snapshot).
    const diagnosis = await handymanRequestDiagnosisRepository
      .findByRequest(tx, request.id);
    if (!diagnosis) throw handymanQuotationDiagnosisRequiredError();
    if (!QUOTABLE_SCOPE_CLASSES.has(diagnosis.scopeClassification)) {
      throw handymanQuotationScopeInsufficientError();
    }

    // 4) One quotation thread per request (server-side check + UNIQUE).
    const existing = await handymanQuotationRepository.findQuotationByRequest(
      tx,
      request.id,
    );
    if (existing) throw handymanQuotationAlreadyExistsError();

    // 5) Atomic root + immutable version 1 DRAFT (+ audit-only journal).
    const quotation = await handymanQuotationRepository.insertQuotation(tx, {
      clientId: request.clientId,
      handymanRequestId: request.id,
      createdByUserId: actorUserId,
    });
    const version = await handymanQuotationRepository.insertVersion(tx, {
      quotationId: quotation.id,
      versionNumber: 1,
      status: 'DRAFT',
      validUntil: null,
      createdByUserId: actorUserId,
    });
    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        eventType: 'HANDYMAN_QUOTATION_VERSION_CREATED',
        entityType: 'HANDYMAN_QUOTATION',
        entityId: quotation.id,
        actorUserId,
        summary: 'Handyman quotation created (version 1, DRAFT).',
        metadata: {
          quotationId: quotation.id,
          quotationVersionId: version.id,
          versionNumber: version.versionNumber,
          handymanRequestId: request.id,
          handymanDiagnosisId: diagnosis.id,
        },
      },
      tx,
    );
    return {
      quotation: toPublicQuotation(quotation),
      versions: [toPublicVersion(version)],
    };
  });
}

/**
 * Bounded later-DRAFT revision (F2): appends the next immutable DRAFT
 * version under the quotation root row lock. Prior versions are NEVER
 * rewritten (0391 trigger is the DB backstop); NO SUPERSEDED projection
 * happens here — that is PART 03 lifecycle.
 */
export async function createHandymanQuotationRevision(
  quotationId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationVersion> {
  assertUuid(quotationId, 'quotationId');
  assertUuid(actorUserId, 'actorUserId');

  return withTransaction(async (tx) => {
    const quotation = await handymanQuotationRepository.lockQuotationById(
      tx,
      quotationId,
    );
    if (!quotation) throw handymanQuotationNotFoundError();
    if (
      !(await contextAccessService.canAccessClient(
        actorUserId,
        quotation.clientId,
      ))
    ) {
      throw buildingAccessDeniedError();
    }

    const nextNumber =
      (await handymanQuotationRepository.maxVersionNumber(tx, quotation.id))
      + 1;
    const version = await handymanQuotationRepository.insertVersion(tx, {
      quotationId: quotation.id,
      versionNumber: nextNumber,
      status: 'DRAFT',
      validUntil: null,
      createdByUserId: actorUserId,
    });
    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        eventType: 'HANDYMAN_QUOTATION_VERSION_CREATED',
        entityType: 'HANDYMAN_QUOTATION',
        entityId: quotation.id,
        actorUserId,
        summary: `Handyman quotation revision created (version ${nextNumber}, DRAFT).`,
        metadata: {
          quotationId: quotation.id,
          quotationVersionId: version.id,
          versionNumber: version.versionNumber,
          handymanRequestId: quotation.handymanRequestId,
        },
      },
      tx,
    );
    return toPublicVersion(version);
  });
}

/** Exact request-scoped read: quotation root + immutable version thread. */
export async function getHandymanQuotation(
  handymanRequestId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationBundle> {
  assertUuid(handymanRequestId, 'handymanRequestId');
  assertUuid(actorUserId, 'actorUserId');

  const quotation = await handymanQuotationRepository.findQuotationByRequest(
    undefined,
    handymanRequestId,
  );
  if (!quotation) throw handymanQuotationNotFoundError();
  if (
    !(await contextAccessService.canAccessClient(
      actorUserId,
      quotation.clientId,
    ))
  ) {
    throw buildingAccessDeniedError();
  }
  const versions = await handymanQuotationRepository.listVersions(
    undefined,
    quotation.id,
  );
  return {
    quotation: toPublicQuotation(quotation),
    versions: versions.map(toPublicVersion),
  };
}

export const handymanQuotationService = {
  createHandymanQuotation,
  createHandymanQuotationRevision,
  getHandymanQuotation,
};
