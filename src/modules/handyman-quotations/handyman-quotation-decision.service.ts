import { assertHandymanQuotationInspectionReady } from './handyman-quotation-inspection';
import { findQuotationDecisionOffer } from './handyman-quotation-document.service';
import { quotationDecisionFingerprint, careQuotationDecisionFingerprint } from './handyman-quotation-decision-fingerprint';
import { resolveCareWorkspacePrincipal } from '../handyman-care-workspace/care-workspace.service';
import { assertCareConsentWriteFresh, verifyCareCommercialConsent, type CareDecisionChannel } from '../handyman-commercial-consent/commercial-consent.service';
import { quotationCommercialTarget } from '../handyman-commercial-consent/commercial-consent.targets';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanServiceRequestRepository } from '../handyman-requests';
import { assertHandymanTenantDecisionActor }
  from '../handyman-tenant-decision-authority/handyman-tenant-decision-authority';
import { assertQuotationThreadBuildingAccess }
  from './handyman-quotation-access';
import { handymanExecutionScopeRepository }
  from './handyman-execution-scope.repository';
import {
  buildExecutionScopeInput,
  handymanExecutionScopeConflictError,
  toPublicExecutionScope,
} from './handyman-execution-scope.service';
import type { PublicHandymanExecutionScope }
  from './handyman-execution-scope.types';
import { handymanQuotationRepository } from './handyman-quotation.repository';
import { handymanQuotationDecisionRepository }
  from './handyman-quotation-decision.repository';
import {
  handymanQuotationInvalidTransitionError,
  handymanQuotationNotFoundError,
  handymanQuotationVersionNotFoundError,
} from './handyman-quotation.errors';
import {
  HANDYMAN_QUOTATION_DECISIONS,
  type DecideHandymanQuotationInput,
  type HandymanQuotationDecisionRecord,
  type PublicHandymanQuotationDecision,
} from './handyman-quotation-decision.types';

/**
 * CR-HM-06 PART 04 — customer approval / rejection service (FROZEN
 * F6/F7/F8). EXPLICIT version-bound decision against the exact ISSUED
 * version: lock version → verify ISSUED + server-time validity →
 * derive customer context from the request lineage (never caller) →
 * idempotency replay check (same key + same fingerprint = same result;
 * mismatch = 409) → immutable decision insert + lifecycle projection
 * (ISSUED → APPROVED | REJECTED) → audit journal, all ONE transaction.
 *
 * INTERMEDIATE RUNTIME: APPROVE does NOT create Execution Scope here —
 * PART 05 extends this approval transaction boundary so approval +
 * scope creation become atomic before CR-HM-06 certification.
 */

function assertUuid(value: string | undefined, field: string): void {
  if (value === undefined || !isValidUuid(value)) {
    throw AppError.validation('Quotation decision validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
}

function decisionConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_DECISION_CONFLICT,
    message:
      'Conflicting replay or a second different decision for this quotation version.',
    statusCode: 409,
  });
}

function decisionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_DECISION_NOT_FOUND,
    message: 'No decision exists for this quotation version.',
    statusCode: 404,
  });
}

function toPublicDecision(
  row: HandymanQuotationDecisionRecord,
): PublicHandymanQuotationDecision {
  return {
    id: row.id,
    clientId: row.clientId,
    quotationId: row.quotationId,
    quotationVersionId: row.quotationVersionId,
    decision: row.decision,
    tenantCompanyId: row.tenantCompanyId,
    tenantPicId: row.tenantPicId,
    decidedByUserId: row.decidedByUserId,
    ...(row.decidedByCareActorId ? { decidedByCareActorId: row.decidedByCareActorId, commercialConsentId: row.commercialConsentId } : {}),
    ...(row.offerDocumentId ? { offerDocumentId: row.offerDocumentId, offerSourceSha256: row.offerSourceSha256,
      offerPdfSha256: row.offerPdfSha256 } : {}),
    idempotencyKey: row.idempotencyKey,
    decidedAt: row.decidedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Explicit customer decision (APPROVE | REJECT) against the exact
 * ISSUED version. One authoritative decision per version, ever.
 */
/**
 * PART 05 extension of the PART 04 approval boundary (FROZEN F8/F9):
 * the first successful APPROVE creates the Execution Scope INSIDE this
 * same transaction (any failure rolls back decision + projection +
 * scope + journal together). REJECT never creates a scope. Replay
 * returns the existing decision AND the existing scope — additively
 * widened result keeps the PART 04 decision contract intact.
 */
export type HandymanQuotationDecisionResult =
  PublicHandymanQuotationDecision & {
    executionScope: PublicHandymanExecutionScope | null;
  };

export async function decideHandymanQuotation(
  quotationVersionId: string,
  input: DecideHandymanQuotationInput,
  actor: string | CareDecisionChannel,
): Promise<HandymanQuotationDecisionResult> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  const actorUserId = typeof actor === 'string' ? actor : null;
  if (actorUserId !== null) assertUuid(actorUserId, 'actorUserId');
  if (
    !(HANDYMAN_QUOTATION_DECISIONS as readonly string[]).includes(
      input.decision,
    )
  ) {
    throw AppError.validation('Quotation decision validation failed.', [
      { field: 'decision', message: 'decision must be APPROVE or REJECT.' },
    ]);
  }
  const idempotencyKey =
    typeof input.idempotencyKey === 'string'
      ? input.idempotencyKey.trim()
      : '';
  if (idempotencyKey.length < 1 || idempotencyKey.length > 200) {
    throw AppError.validation('Quotation decision validation failed.', [
      {
        field: 'idempotencyKey',
        message: 'idempotencyKey is required (1-200 characters).',
      },
    ]);
  }
  // Authenticate before aggregate locks; live authority is rechecked and held
  // on the SAME transaction below (no nested session transaction/deadlock).
  const carePrincipal = typeof actor === 'string' ? null : await resolveCareWorkspacePrincipal(actor.workspaceToken);
  return withTransaction(async (tx) => {
    // 1) Exact version lock (F7) + lineage authority.
    const version = await handymanQuotationRepository.lockVersionById(
      tx,
      quotationVersionId,
    );
    if (!version) throw handymanQuotationVersionNotFoundError();
    const quotation = await handymanQuotationRepository.findQuotationById(
      tx,
      version.quotationId,
    );
    if (!quotation) throw handymanQuotationNotFoundError();
    // CR-HM-SEC-01 PART 02: building-scope authority traced to the parent
    // request's building_id (BE-02G; no same-Client shortcut).
    if (actorUserId !== null) await assertQuotationThreadBuildingAccess(tx as never, quotation, actorUserId);

    // Bind authority inside the same version-lock transaction and before
    // replay handling. Revocation therefore takes effect even for a retry;
    // an unrelated actor cannot use a known idempotency key to retrieve the
    // original decision.
    const request = await handymanServiceRequestRepository.findById(
      tx,
      quotation.handymanRequestId,
    );
    if (!request) throw handymanQuotationNotFoundError();
    if (actorUserId !== null) await assertHandymanTenantDecisionActor(tx, {
      actorUserId, handymanRequestId: request.id, clientId: request.clientId,
      tenantCompanyId: request.tenantCompanyId, buildingId: request.buildingId,
    });
    const offer = await findQuotationDecisionOffer(tx, version.id);
    if (actorUserId !== null && offer) {
      if (!isValidUuid(input.offerDocumentId ?? '') || typeof input.offerPdfSha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(input.offerPdfSha256)) {
        throw AppError.validation('The exact offerDocumentId and lowercase offerPdfSha256 are required for this decision.');
      }
      if (input.offerDocumentId!.toLowerCase() !== offer.id || input.offerPdfSha256 !== offer.pdfSha256) throw decisionConflictError();
    } else if (actorUserId !== null && !offer && (input.offerDocumentId !== undefined || input.offerPdfSha256 !== undefined)) {
      throw AppError.validation('Historical offers cannot be represented as a new price-basis disclosure.');
    }
    const consent = typeof actor === 'string' ? null : await verifyCareCommercialConsent(
      tx, actor, request, quotationCommercialTarget(version.id, request, offer), input.decision === 'APPROVE' ? 'ACCEPT' : 'REJECT', carePrincipal!,
    );
    const personalFingerprint = quotationDecisionFingerprint(version.id, input.decision, offer);
    const fingerprint = consent ? careQuotationDecisionFingerprint(personalFingerprint, consent.careActorId, consent.id) : personalFingerprint;

    // 2) One authoritative decision per version: replay or conflict.
    const existing = await handymanQuotationDecisionRepository
      .lockDecisionByVersion(tx, version.id);
    if (existing) {
      if (
        existing.idempotencyKey === idempotencyKey &&
        existing.requestFingerprint === fingerprint &&
        existing.decision === input.decision &&
        existing.decidedByUserId === actorUserId &&
        (existing.decidedByCareActorId ?? null) === (consent?.careActorId ?? null) &&
        (existing.commercialConsentId ?? null) === (consent?.id ?? null)
      ) {
        // Replay-safe: the ORIGINAL authoritative facts, nothing new.
        const priorScope = await handymanExecutionScopeRepository
          .findScopeByApprovedVersion(tx, version.id);
        return {
          ...toPublicDecision(existing),
          executionScope: priorScope
            ? toPublicExecutionScope(priorScope)
            : null,
        };
      }
      throw decisionConflictError();
    }

    // 3) Eligibility: presentation state is server-authoritative.
    if (version.status !== 'ISSUED') {
      throw handymanQuotationInvalidTransitionError();
    }
    if (!version.validUntil || version.validUntil.getTime() <= Date.now()) {
      throw handymanQuotationInvalidTransitionError();
    }

    if (input.decision === 'APPROVE') await assertHandymanQuotationInspectionReady(tx, request.id);

    // 4/5) Immutable decision insert + bounded lifecycle projection
    //    (ISSUED → APPROVED | REJECTED) — atomic, single transaction.
    if (consent) await assertCareConsentWriteFresh(tx, consent, carePrincipal!);
    let record: HandymanQuotationDecisionRecord;
    try {
      record = await handymanQuotationDecisionRepository
      .insertDecision(tx, {
        clientId: quotation.clientId,
        quotationId: quotation.id,
        quotationVersionId: version.id,
        decision: input.decision,
        tenantCompanyId: request.tenantCompanyId,
        tenantPicId: request.tenantPicId,
        decidedByUserId: actorUserId,
        decidedByCareActorId: consent?.careActorId ?? null,
        commercialConsentId: consent?.id ?? null,
        offerDocumentId: offer?.id ?? null,
        offerSourceSha256: offer?.sourceSha256 ?? null,
        offerPdfSha256: offer?.pdfSha256 ?? null,
        idempotencyKey,
        requestFingerprint: fingerprint,
      });
    } catch (error) {
      // UNIQUE(version)/UNIQUE(idempotency_key) race: concurrent first
      // decision or cross-version key reuse → conflict (F7).
      if ((error as { code?: string }).code === '23505') {
        throw decisionConflictError();
      }
      throw error;
    }
    const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const projection = await handymanQuotationRepository
      .updateVersionLifecycle(tx, version.id, status, undefined);
    if (!projection) throw handymanQuotationVersionNotFoundError();

    // PART 05 (F8/F9): APPROVE-only Execution Scope creation, same
    // transaction. REJECT never reaches this branch. Location and all
    // authority fields are server-derived; scope creation failure
    // rolls back decision + projection + scope + events together.
    let scope: PublicHandymanExecutionScope | null = null;
    if (input.decision === 'APPROVE') {
      const scopeInput = await buildExecutionScopeInput({
        clientId: quotation.clientId,
        handymanRequestId: request.id,
        channelAttributionId: request.channelAttributionId,
        quotationId: quotation.id,
        approvedQuotationVersionId: version.id,
        quotationDecisionId: record.id,
        tenantCompanyId: request.tenantCompanyId,
        tenantPicId: request.tenantPicId,
        derivedBuildingId: request.buildingId,
        derivedSpaceId: request.spaceId,
        createdByUserId: actorUserId,
        createdByCareActorId: consent?.careActorId ?? null,
      });
      let scopeRow;
      try {
        scopeRow = await handymanExecutionScopeRepository.insertScope(
          tx,
          scopeInput,
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw handymanExecutionScopeConflictError();
        }
        throw error;
      }
      scope = toPublicExecutionScope(scopeRow);
      await recordOperationalEvent(
        {
          clientId: quotation.clientId,
          eventType: 'HANDYMAN_EXECUTION_SCOPE_CREATED',
          entityType: 'HANDYMAN_EXECUTION_SCOPE',
          entityId: scopeRow.id,
          actorUserId,
          summary: `Handyman execution scope created for quotation version ${version.versionNumber}.`,
          metadata: {
            ...(consent ? { recordedByCareActorId: consent.careActorId, commercialConsentId: consent.id } : {}),
            executionScopeId: scopeRow.id,
            quotationId: quotation.id,
            quotationVersionId: version.id,
            versionNumber: version.versionNumber,
            decisionId: record.id,
            handymanRequestId: request.id,
            tenantCompanyId: request.tenantCompanyId,
            buildingId: scopeRow.buildingId,
            spaceId: scopeRow.spaceId,
          },
        },
        tx,
      );
    }

    // 6) Audit-only journal.
    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        eventType:
          input.decision === 'APPROVE'
            ? 'HANDYMAN_QUOTATION_APPROVED'
            : 'HANDYMAN_QUOTATION_REJECTED',
        entityType: 'HANDYMAN_QUOTATION_VERSION',
        entityId: version.id,
        actorUserId,
        summary: `Handyman quotation version ${version.versionNumber} ${status.toLowerCase()} by customer decision.`,
        metadata: {
          quotationId: quotation.id,
          quotationVersionId: version.id,
          versionNumber: version.versionNumber,
          ...(consent ? { recordedByCareActorId: consent.careActorId, commercialConsent: consent } : {}),
          decisionId: record.id,
          decision: input.decision,
          handymanRequestId: quotation.handymanRequestId,
          tenantCompanyId: request.tenantCompanyId,
          tenantPicId: request.tenantPicId,
        },
      },
      tx,
    );
    return { ...toPublicDecision(record), executionScope: scope };
  });
}

/** Exact read of the immutable decision for a version (404 when none). */
export async function getHandymanQuotationDecision(
  quotationVersionId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationDecision> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');
  const record = await handymanQuotationDecisionRepository
    .findDecisionByVersion(undefined, quotationVersionId);
  if (!record) throw decisionNotFoundError();
  // CR-HM-SEC-01 PART 02: building-scope authority traced through the
  // decision's quotation thread to the parent request's building_id
  // (BE-02G; no same-Client shortcut). A missing thread root is denied
  // exactly like an inaccessible Building (no existence leak).
  const quotation = await handymanQuotationRepository.findQuotationById(
    undefined,
    record.quotationId,
  );
  if (!quotation) throw buildingAccessDeniedError();
  await assertQuotationThreadBuildingAccess(
    undefined as never,
    quotation,
    actorUserId,
  );
  return toPublicDecision(record);
}
