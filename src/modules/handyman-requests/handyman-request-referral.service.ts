import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanServiceRequestRepository } from './handyman-service-request.repository';
import { handymanRequestDiagnosisRepository } from './handyman-request-diagnosis.repository';
import { handymanRequestReferralRepository } from './handyman-request-referral.repository';
import {
  handymanReferralNotEligibleError,
  handymanServiceRequestAlreadyReferredError,
} from './handyman-request-referral.errors';
import { handymanServiceRequestNotFoundError } from './handyman-request-triage.errors';
import { SCOPE_CLASS_TO_REQUEST_STATUS } from './handyman-request-diagnosis.types';
import {
  CLASSIFICATION_TO_REFERRAL_TYPE,
  isReferralEligibleClassification,
  type CreateHandymanReferralInput,
  type HandymanRequestReferralRecord,
  type PublicHandymanRequestReferral,
} from './handyman-request-referral.types';

/**
 * CR-HM-03 PART 04 — Handyman referral record service
 * (FROZEN F4/F5/F6/F7/F9).
 *
 * Source authority is the immutable PART 03 diagnosis ONLY: eligibility,
 * referral type and the target discipline are all derived from it (never
 * from free-text service_catalog.category; the caller can never override
 * them). Request state is UNCHANGED in PART 04: SPECIALIST_REQUIRED
 * requests remain READY_FOR_NEXT_STEP and OUT_OF_HANDYMAN_SCOPE requests
 * remain REFERRED (terminal under CR-HM-03).
 *
 * Boundaries: a specialist escalation is NOT provider/vendor matching,
 * worker/crew assignment, a work order, or a quotation; an out-of-scope
 * referral is NOT an FM request/conversion/work order/execution/provider
 * assignment. The referral row is the handoff fact only.
 */

const REFERRAL_UNIQUE_CONSTRAINT = 'handyman_request_referrals_request_unique';

function isReferralUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    (candidate?.constraint === REFERRAL_UNIQUE_CONSTRAINT ||
      candidate?.constraint === 'handyman_request_referrals_diagnosis_unique')
  );
}

function toPublic(
  record: HandymanRequestReferralRecord,
): PublicHandymanRequestReferral {
  return { ...record, referredAt: record.referredAt.toISOString() };
}

/** Append the derived referral for a diagnosed request (state preserved). */
export async function recordHandymanReferral(
  input: CreateHandymanReferralInput,
  actorUserId: string,
): Promise<PublicHandymanRequestReferral> {
  if (!isValidUuid(input.handymanRequestId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  if (!isValidUuid(actorUserId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'actorUserId', message: 'actorUserId must be a valid local user UUID.' },
    ]);
  }
  const referralNote =
    typeof input.referralNote === 'string' ? input.referralNote.trim() : '';
  if (referralNote.length < 1 || referralNote.length > 1000) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'referralNote',
        message: 'referralNote is required (1-1000 characters).',
      },
    ]);
  }

  try {
    return await withTransaction(async (tx) => {
      // 1) Lock the parent for the decision chain.
      const request = await handymanServiceRequestRepository.lockById(
        tx,
        input.handymanRequestId,
      );
      if (!request) throw handymanServiceRequestNotFoundError();

      // 2) Realm authority: BE-02G exact-Building check on the
      //    locked request's authoritative {clientId, buildingId}
      //    (PART 06J), replacing the client-level canAccessClient
      //    shortcut: a same-Client sibling Building assignment must
      //    not record a referral. The denial vocabulary (403
      //    BUILDING_ACCESS_DENIED — the guard's own thrower) and the
      //    wall's position (after the request lock/404, before
      //    eligibility, the uniqueness pre-check and mutation) are
      //    unchanged.
      await assertBuildingScopedResourceAccess(actorUserId, {
        clientId: request.clientId,
        buildingId: request.buildingId,
      });

      // 3) F5/F9 eligibility: the immutable diagnosis is the ONLY source.
      const diagnosis = await handymanRequestDiagnosisRepository.findByRequest(
        tx,
        request.id,
      );
      if (
        !diagnosis ||
        !isReferralEligibleClassification(diagnosis.scopeClassification)
      ) {
        throw handymanReferralNotEligibleError();
      }
      const referralType =
        CLASSIFICATION_TO_REFERRAL_TYPE[diagnosis.scopeClassification];

      // 4) State consistency: PART 03 guarantees the matching projection;
      //    no request mutation happens here by contract.
      const expectedStatus =
        SCOPE_CLASS_TO_REQUEST_STATUS[
          diagnosis.scopeClassification === 'SPECIALIST_REQUIRED'
            ? 'SPECIALIST'
            : 'OUT_OF_HANDYMAN_SCOPE'
        ];
      if (request.status !== expectedStatus) {
        throw handymanReferralNotEligibleError();
      }

      // 5) F2 pre-check; UNIQUE constrains races to the SAME 409 contract.
      const existing = await handymanRequestReferralRepository.findByRequest(
        tx,
        request.id,
      );
      if (existing) throw handymanServiceRequestAlreadyReferredError();

      // 6) Append the derived referral handoff fact (target verbatim from
      //    the diagnosis authority — ELECTRICAL/AC stay targets only).
      const record = await handymanRequestReferralRepository.insertReferral(
        tx,
        {
          clientId: request.clientId,
          handymanRequestId: request.id,
          channelAttributionId: request.channelAttributionId,
          buildingId: request.buildingId,
          handymanDiagnosisId: diagnosis.id,
          referralType,
          handymanDisciplineId: diagnosis.handymanDisciplineId,
          disciplineCode: diagnosis.disciplineCode,
          referralNote,
          referredByUserId: actorUserId,
        },
      );

      // 7) FROZEN F6 journal row — SAME executor; history only. The
      //    request state projection is deliberately NOT touched.
      await recordOperationalEvent(
        {
          clientId: request.clientId,
          eventType: 'HANDYMAN_REFERRAL_CREATED',
          entityType: 'HANDYMAN_SERVICE_REQUEST',
          entityId: request.id,
          actorUserId,
          buildingId: request.buildingId,
          summary: `Handyman referral created: ${referralType} (${diagnosis.disciplineCode}).`,
          metadata: {
            referralId: record.id,
            diagnosisId: diagnosis.id,
            referralType,
            disciplineCode: diagnosis.disciplineCode,
          },
        },
        tx,
      );

      return toPublic(record);
    });
  } catch (error) {
    if (isReferralUniqueViolation(error)) {
      throw handymanServiceRequestAlreadyReferredError();
    }
    throw error;
  }
}

/** Bounded read of the immutable F2 referral record for one request. */
/**
 * Bounded read. CR-HM-03 PART 05A (FROZEN F8): with an authenticated
 * actor supplied (HTTP), the BE-02G exact-Building scope is enforced
 * server-side against the request-derived {clientId, buildingId}
 * (PART 06J).
 */
export async function getHandymanRequestReferral(
  handymanRequestId: string,
  actorUserId?: string,
): Promise<PublicHandymanRequestReferral> {
  if (!isValidUuid(handymanRequestId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  if (actorUserId !== undefined) {
    if (!isValidUuid(actorUserId)) {
      throw AppError.validation('Request validation failed.', [
        { field: 'actorUserId', message: 'actorUserId must be a valid UUID.' },
      ]);
    }
    const request = await handymanServiceRequestRepository.findById(
      undefined,
      handymanRequestId,
    );
    if (!request) throw handymanServiceRequestNotFoundError();
    // CR-HM-SEC-01 PART 06J — BE-02G exact-Building check on the
    // request's authoritative {clientId, buildingId}, replacing the
    // client-level canAccessClient shortcut: a same-Client sibling
    // Building assignment must not read the referral record. The
    // denial vocabulary (403 BUILDING_ACCESS_DENIED — the guard's
    // own thrower) and the wall's position (after the request 404,
    // before the referral lookup) are unchanged. The actor-optional
    // distinction is preserved: the wall runs only when an
    // authenticated actor is supplied (HTTP); actor-less internal
    // reads keep their contract.
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: request.clientId,
      buildingId: request.buildingId,
    });
  }
  const record = await handymanRequestReferralRepository.findByRequest(
    undefined,
    handymanRequestId,
  );
  if (!record) {
    throw AppError.notFound('Handyman request referral record not found.');
  }
  return toPublic(record);
}

export const handymanServiceRequestReferralService = {
  recordHandymanReferral,
  getHandymanRequestReferral,
};
