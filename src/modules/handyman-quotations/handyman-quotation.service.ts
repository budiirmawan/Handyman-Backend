import { assertHandymanQuotationInspectionReady } from './handyman-quotation-inspection';
import { AppError } from '../../shared/errors';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanRequestDiagnosisRepository,
  handymanServiceRequestNotFoundError,
  handymanServiceRequestRepository,
} from '../handyman-requests';
import { assertQuotationThreadBuildingAccess }
  from './handyman-quotation-access';
import { handymanQuotationRepository } from './handyman-quotation.repository';
import { handymanQuotationLineRepository } from './handyman-quotation-line.repository';
import {
  handymanQuotationAlreadyExistsError,
  handymanQuotationDiagnosisRequiredError,
  handymanQuotationNotFoundError,
  handymanQuotationRevisionAfterApprovalError,
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
    dpRequired: row.dpRequired ?? false,
    dpPercentage: row.dpPercentage ?? null,
    dpAmount: row.dpAmount ?? null,
    dpTermsNotes: row.dpTermsNotes ?? null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeDraftDpTerms(input?: {
  dpRequired?: boolean;
  dpPercentage?: number | null;
  dpAmount?: number | null;
  dpTermsNotes?: string | null;
}): {
  dpRequired: boolean;
  dpPercentage: number | null;
  dpAmount: number | null;
  dpTermsNotes: string | null;
} {
  const dpRequired = Boolean(input?.dpRequired);
  const dpTermsNotes =
    typeof input?.dpTermsNotes === 'string' && input.dpTermsNotes.trim().length > 0
      ? input.dpTermsNotes.trim()
      : null;
  if (dpTermsNotes && dpTermsNotes.length > 500) {
    throw AppError.validation('Quotation DP terms validation failed.', [
      { field: 'dpTermsNotes', message: 'dpTermsNotes must be at most 500 characters.' },
    ]);
  }
  if (!dpRequired) {
    return {
      dpRequired: false,
      dpPercentage: null,
      dpAmount: null,
      dpTermsNotes,
    };
  }
  const dpPercentage =
    input?.dpPercentage === undefined || input?.dpPercentage === null
      ? null
      : Number(input.dpPercentage);
  const dpAmount =
    input?.dpAmount === undefined || input?.dpAmount === null
      ? null
      : Number(input.dpAmount);
  if (
    dpPercentage !== null &&
    (!Number.isFinite(dpPercentage) || dpPercentage <= 0 || dpPercentage > 100)
  ) {
    throw AppError.validation('Quotation DP terms validation failed.', [
      { field: 'dpPercentage', message: 'dpPercentage must be > 0 and <= 100.' },
    ]);
  }
  if (dpAmount !== null && (!Number.isFinite(dpAmount) || dpAmount <= 0)) {
    throw AppError.validation('Quotation DP terms validation failed.', [
      { field: 'dpAmount', message: 'dpAmount must be > 0.' },
    ]);
  }
  return {
    dpRequired: true,
    dpPercentage: dpPercentage !== null ? Number(dpPercentage.toFixed(2)) : null,
    dpAmount: dpAmount !== null ? Number(dpAmount.toFixed(2)) : null,
    dpTermsNotes,
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

    await assertHandymanQuotationInspectionReady(tx, request.id);

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
    const dpTerms = normalizeDraftDpTerms(input);
    const version = await handymanQuotationRepository.insertVersion(tx, {
      quotationId: quotation.id,
      versionNumber: 1,
      status: 'DRAFT',
      validUntil: null,
      ...dpTerms,
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

/** DP keys a caller may declare on a revision (presence = explicit policy). */
const DP_TERM_KEYS = [
  'dpRequired',
  'dpPercentage',
  'dpAmount',
  'dpTermsNotes',
] as const;

function declaresDpTerms(
  input: Record<string, unknown> | undefined,
): boolean {
  return input !== undefined && DP_TERM_KEYS.some((key) => key in input);
}

/**
 * CR-HM-MANUAL-QUOTATION-01 PART 03B — DP inheritance.
 *
 * A revision must not silently drop the customer's money terms, so the
 * previous version's DP policy is carried forward unless the caller states its
 * own. A PERCENTAGE policy is carried as a percentage and its amount is left
 * to be re-derived against the REVISED total (the existing issue-time
 * authority `resolveIssueDpTerms` performs that derivation and rounding); an
 * amount that is NOT that derived value is a deliberate fixed-DP policy and is
 * carried verbatim. Notes travel because they are contract text.
 */
async function inheritDpTermsFrom(
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
  previous: HandymanQuotationVersionRecord,
): Promise<{
  dpRequired: boolean;
  dpPercentage: number | null;
  dpAmount: number | null;
  dpTermsNotes: string | null;
} | undefined> {
  if (!previous.dpRequired) return undefined;
  const sums = await handymanQuotationLineRepository.sumLines(tx, previous.id);
  const previousTotal = sums.labor + sums.material;
  const percentage = previous.dpPercentage;
  const amount = previous.dpAmount;
  const derivedAmount =
    percentage === null || previousTotal <= 0
      ? null
      : Number(((previousTotal * percentage) / 100).toFixed(2));
  // Exactly ONE component travels, so the other re-derives on the REVISED
  // total under the existing issue-time rules: a percentage when the stored
  // amount is simply that percentage of the old total (i.e. derived), and the
  // fixed amount when the policy was an explicit money figure.
  const carryPercentage =
    amount === null ||
    (percentage !== null && amount === derivedAmount);
  return {
    dpRequired: true,
    dpPercentage: carryPercentage ? percentage : null,
    dpAmount: carryPercentage ? null : amount,
    dpTermsNotes: previous.dpTermsNotes,
  };
}

/**
 * Bounded later-DRAFT revision (F2): appends the next immutable DRAFT
 * version under the quotation root row lock. Prior versions are NEVER
 * rewritten (0391 trigger is the DB backstop); NO SUPERSEDED projection
 * happens here — that is PART 03 lifecycle.
 *
 * PART 03B adds exactly two bounded behaviors:
 *   1. on a manual-origin thread an ordinary revision may never fork or amend
 *      an APPROVED quotation (post-approval change stays the existing Scope
 *      Variation lane); the catalog lane's documented post-approval re-quote
 *      behavior is untouched;
 *   2. a manual-origin (unlisted-intake) thread carries its predecessor's
 *      immutable lines into the new DRAFT — ALL of them by default, or exactly
 *      the `carryForwardLineIds` subset the operator selects. That selection is
 *      how a line is REMOVED (nothing is deleted; the new snapshot omits it)
 *      while additions keep using the existing DRAFT line API. The catalog lane
 *      keeps re-deriving its lines from its request items, so it can neither
 *      lose nor double-count anything, and a carry-forward declaration there is
 *      refused. DP terms are inherited unless the caller declares them.
 */
export async function createHandymanQuotationRevision(
  quotationId: string,
  actorUserId: string,
  dpTermsInput?: {
    dpRequired?: boolean;
    dpPercentage?: number | null;
    dpAmount?: number | null;
    dpTermsNotes?: string | null;
  },
  options: { carryForwardLineIds?: string[] } = {},
): Promise<PublicHandymanQuotationVersion> {
  assertUuid(quotationId, 'quotationId');
  assertUuid(actorUserId, 'actorUserId');
  const explicitSelection = options.carryForwardLineIds !== undefined;
  if (explicitSelection && !Array.isArray(options.carryForwardLineIds)) {
    throw AppError.validation('Quotation revision validation failed.', [
      {
        field: 'carryForwardLineIds',
        message:
          'carryForwardLineIds must be an array of predecessor line ids.',
      },
    ]);
  }

  return withTransaction(async (tx) => {
    const quotation = await handymanQuotationRepository.lockQuotationById(
      tx,
      quotationId,
    );
    if (!quotation) throw handymanQuotationNotFoundError();
    // CR-HM-SEC-01 PART 02: building-scope authority traced to the parent
    // request's building_id (BE-02G; no same-Client shortcut).
    await assertQuotationThreadBuildingAccess(tx as never, quotation, actorUserId);

    const previous = await handymanQuotationRepository.findLatestVersion(
      tx,
      quotation.id,
    );
    const lane = await handymanQuotationLineRepository.findRequestOriginContext(
      tx,
      quotation.handymanRequestId,
      quotation.clientId,
    );
    if (!lane) throw handymanQuotationNotFoundError();
    const isManualOrigin = lane.intakeSource === 'UNLISTED_TRIAGE';

    // (1) Consent law, scoped to the lane this PART opens: on a manual-origin
    //     thread an ordinary revision IS the whole re-pricing mechanism, so
    //     once the customer approved a version the thread is closed for
    //     hand-made revisions — carrying a consented snapshot forward would fork
    //     the approval instead of going through the authorized post-approval
    //     pathway. A catalog thread keeps its documented post-approval re-quote
    //     lane (its lines are re-derived from request items and reconciled with
    //     the variation ledger), which this PART must not change.
    if (
      isManualOrigin &&
      (await handymanQuotationRepository.existsVersionWithStatus(
        tx,
        quotation.id,
        ['APPROVED'],
      ))
    ) {
      throw handymanQuotationRevisionAfterApprovalError();
    }

    if (explicitSelection && !isManualOrigin) {
      throw AppError.validation('Quotation revision validation failed.', [
        {
          field: 'carryForwardLineIds',
          message:
            'carryForwardLineIds is only valid on a manual-origin (unlisted-intake) quotation thread; a catalog thread re-derives its lines from its request items.',
        },
      ]);
    }

    // (2) DP terms: a declared policy wins; otherwise inherit the
    //     predecessor's policy (a percentage re-derives on the new total).
    const dpTerms = declaresDpTerms(dpTermsInput)
      ? normalizeDraftDpTerms(dpTermsInput)
      : previous
        ? normalizeDraftDpTerms(await inheritDpTermsFrom(tx, previous))
        : normalizeDraftDpTerms(dpTermsInput);

    const nextNumber =
      (await handymanQuotationRepository.maxVersionNumber(tx, quotation.id))
      + 1;
    const version = await handymanQuotationRepository.insertVersion(tx, {
      quotationId: quotation.id,
      versionNumber: nextNumber,
      status: 'DRAFT',
      validUntil: null,
      ...dpTerms,
      createdByUserId: actorUserId,
    });

    // (3) Carry the immutable manual-line snapshot forward: the database
    //     copies every commercial fact, so a carried line cannot drift, be
    //     re-authored, or be silently lost.
    let carriedLineIds: string[] = [];
    let omittedLineCount = 0;
    if (isManualOrigin && previous) {
      const predecessorIds = await handymanQuotationLineRepository.listLineIds(
        tx,
        previous.id,
      );
      let selected = predecessorIds;
      if (explicitSelection) {
        const wanted = (options.carryForwardLineIds ?? []).map((value) =>
          typeof value === 'string' ? value.trim().toLowerCase() : '',
        );
        const seen = new Set<string>();
        for (const id of wanted) {
          if (!isValidUuid(id)) {
            throw AppError.validation('Quotation revision validation failed.', [
              {
                field: 'carryForwardLineIds',
                message: 'every carryForwardLineIds entry must be a UUID.',
              },
            ]);
          }
          if (seen.has(id)) {
            throw AppError.validation('Quotation revision validation failed.', [
              {
                field: 'carryForwardLineIds',
                message:
                  'carryForwardLineIds must not repeat a line: a repeated id would duplicate the carried snapshot line.',
              },
            ]);
          }
          seen.add(id);
          if (!predecessorIds.includes(id)) {
            throw AppError.validation('Quotation revision validation failed.', [
              {
                field: 'carryForwardLineIds',
                message:
                  'carryForwardLineIds may only reference lines of the immediately previous version of this quotation thread.',
              },
            ]);
          }
        }
        const wantedSet = new Set(wanted);
        selected = predecessorIds.filter((id) => wantedSet.has(id));
        omittedLineCount = predecessorIds.length - selected.length;
      }
      if (selected.length > 0) {
        const copy = await handymanQuotationLineRepository.copyLinesIntoVersion(
          tx,
          {
            sourceVersionId: previous.id,
            targetVersionId: version.id,
            lineIds: selected,
            actorUserId,
          },
        );
        // A short copy means a selected line vanished mid-transaction.
        if (copy.copiedCount !== selected.length) {
          throw AppError.validation('Quotation revision failed.', [
            {
              field: 'carryForwardLineIds',
              message:
                'Every selected predecessor line must be carried; the revision was rolled back.',
            },
          ]);
        }
        carriedLineIds = copy.copied.map((line) => line.id);
      }
    }

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
          sourceVersionId: previous?.id ?? null,
          sourceVersionNumber: previous?.versionNumber ?? null,
          carriedForwardLineIds: carriedLineIds,
          omittedCarryForwardLineCount: omittedLineCount,
          dpTermsInherited:
            !declaresDpTerms(dpTermsInput) && (previous?.dpRequired ?? false),
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
  // CR-HM-SEC-01 PART 02: building-scope authority traced to the parent
  // request's building_id (BE-02G; no same-Client shortcut).
  await assertQuotationThreadBuildingAccess(
    undefined as never,
    quotation,
    actorUserId,
  );
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
