import { createHash } from 'node:crypto';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanServiceRequestRepository } from '../handyman-requests';
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

/** sha256-hex fingerprint of the canonical decision payload (F7). */
function decisionFingerprint(
  quotationVersionId: string,
  decision: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([quotationVersionId, decision]))
    .digest('hex');
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
export async function decideHandymanQuotation(
  quotationVersionId: string,
  input: DecideHandymanQuotationInput,
  actorUserId: string,
): Promise<PublicHandymanQuotationDecision> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');
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
  const fingerprint = decisionFingerprint(
    quotationVersionId,
    input.decision,
  );

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
    if (
      !(await contextAccessService.canAccessClient(
        actorUserId,
        quotation.clientId,
      ))
    ) {
      throw buildingAccessDeniedError();
    }

    // 2) One authoritative decision per version: replay or conflict.
    const existing = await handymanQuotationDecisionRepository
      .lockDecisionByVersion(tx, version.id);
    if (existing) {
      if (
        existing.idempotencyKey === idempotencyKey &&
        existing.requestFingerprint === fingerprint &&
        existing.decision === input.decision
      ) {
        return toPublicDecision(existing); // replay-safe identical result
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

    // 4) Customer context from the authoritative request lineage only.
    const request = await handymanServiceRequestRepository.findById(
      tx,
      quotation.handymanRequestId,
    );
    if (!request) throw handymanQuotationNotFoundError();

    // 5) Immutable decision insert + bounded lifecycle projection
    //    (ISSUED → APPROVED | REJECTED) — atomic, single transaction.
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
          decisionId: record.id,
          decision: input.decision,
          handymanRequestId: quotation.handymanRequestId,
          tenantCompanyId: request.tenantCompanyId,
          tenantPicId: request.tenantPicId,
        },
      },
      tx,
    );
    return toPublicDecision(record);
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
  if (
    !(await contextAccessService.canAccessClient(
      actorUserId,
      record.clientId,
    ))
  ) {
    throw buildingAccessDeniedError();
  }
  return toPublicDecision(record);
}
