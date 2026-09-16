import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  handymanRequestNotFoundError,
  handymanRequestRepository,
  handymanRequestStatusInvalidError,
} from '../handyman-requests';
import { handymanRequestTriageRepository } from '../handyman-request-governance';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanQuotationLinesRequiredError,
  handymanQuotationNotAllowedError,
  handymanQuotationRevisionDraftExistsError,
  handymanQuotationRevisionNotFoundError,
  handymanQuotationRevisionStateInvalidError,
  handymanQuotationStateInvalidError,
} from './handyman-quotation.errors';
import { handymanQuotationRepository } from './handyman-quotation.repository';
import { handymanQuotationRevisionRepository } from './handyman-quotation-revision.repository';
import { handymanQuotationLineRepository } from './handyman-quotation-line.repository';
import {
  loadQuotationOrThrow,
  toPublicHandymanQuotationRevision,
  totalsFromRows,
} from './handyman-quotation.service';
import type {
  CreateHandymanQuotationRevisionInput,
  HandymanQuotationRecord,
  HandymanQuotationRevisionRecord,
  PublicHandymanQuotationRevision,
} from './handyman-quotation.types';
import { HANDYMAN_QUOTATION_SENDABLE_STATUSES } from './handyman-quotation.types';

/**
 * CR-HM-BE-03 RUN 2 — Revision authority.
 *
 * DRAFT → SUBMITTED → SUPERSEDED. Revision numbers are server-authoritative
 * and sequential (max+1 under the locked envelope row); at most one DRAFT
 * revision per quotation (pre-check + the migration-0351 partial unique
 * index); SUBMITTED facts are immutable — a newer commercial position
 * SUPERSEDES the prior SUBMITTED revision instead of editing it.
 *
 * Run 2 note: the envelope has no approval binding yet, so no revision here
 * can be an approved-bound revision. Later runs must exclude an
 * approval-bound revision from supersede before shipping approvals.
 */

const UNIQUE_VIOLATION = '23505';
const ONE_DRAFT_CONSTRAINT = 'handyman_quotation_revisions_one_draft_unique';

function isOneDraftViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION &&
    (error as { constraint?: string }).constraint === ONE_DRAFT_CONSTRAINT
  );
}

function normalizeNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: 'Notes must be a string.' },
    ]);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 2000) {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: 'Notes must be at most 2000 characters.' },
    ]);
  }
  return trimmed;
}

function normalizeValidUntil(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'validUntil', message: 'validUntil must be a YYYY-MM-DD date.' },
    ]);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.validation('Request validation failed.', [
      { field: 'validUntil', message: 'validUntil must be a real calendar date.' },
    ]);
  }
  return value;
}

/**
 * Envelope states in which a new DRAFT revision may be opened: the
 * WITHDRAWN re-quote loop (governance correction #3 — same quotation
 * identity), the not-yet-sent DRAFT envelope (correcting a SUBMITTED
 * revision before it was ever sent), and — CR-HM-BE-03 RUN 3 — the
 * REJECTED envelope: a customer rejection returns to the commercial loop
 * under the SAME quotation identity (opening the revision performs the
 * governed reopen transition of the request). A SENT quotation must be
 * withdrawn first and an APPROVED quotation is final — sent/approved
 * commercial facts are never edited around.
 */
function assertRevisionCreatable(quotation: HandymanQuotationRecord): void {
  if (!(HANDYMAN_QUOTATION_SENDABLE_STATUSES as readonly string[]).includes(quotation.status)) {
    throw handymanQuotationStateInvalidError(
      quotation.status === 'SENT'
        ? 'Withdraw the SENT quotation before opening a new revision.'
        : 'A new revision cannot be opened in this quotation state.',
    );
  }
}

/**
 * CR-HM-BE-03 RUN 3 — minimum governed reopen transition: when the envelope
 * is REJECTED, opening the next DRAFT revision returns the request from
 * QUOTATION_REJECTED to its quotation-authoring phase (TRIAGED on the
 * QUOTATION path, INSPECTION_COMPLETED on the INSPECTION path) through the
 * guarded CR-HM-BE-01 transition, in the SAME transaction as the revision.
 * The rejected approval row is untouched immutable history.
 */
async function reopenRejectedQuotation(
  quotation: HandymanQuotationRecord,
  tx: Pick<PoolClient, 'query'>,
): Promise<string | null> {
  if (quotation.status !== 'REJECTED') return null;
  const request = await handymanRequestRepository.findById(quotation.requestId, tx);
  if (!request) throw handymanRequestNotFoundError();
  const activeTriage = await handymanRequestTriageRepository.findActiveByRequest(
    request.id,
    tx,
  );
  if (!activeTriage) {
    throw handymanQuotationNotAllowedError(
      'Reopening a rejected quotation requires an ACTIVE triage decision on the handyman request.',
    );
  }
  const targetStatus =
    activeTriage.path === 'INSPECTION' ? 'INSPECTION_COMPLETED' : 'TRIAGED';
  const moved = await handymanRequestRepository.updateStatusFrom(
    request.id,
    'QUOTATION_REJECTED',
    targetStatus,
    tx,
  );
  if (!moved) throw handymanRequestStatusInvalidError();
  return targetStatus;
}

async function loadRevisionOrThrow(
  revisionId: string,
  actorUserId: string,
  tx: Pick<PoolClient, 'query'>,
  options: { forUpdate?: boolean } = {},
): Promise<HandymanQuotationRevisionRecord> {
  if (!isValidUuid(revisionId)) throw handymanQuotationRevisionNotFoundError();
  const revision = options.forUpdate
    ? await handymanQuotationRevisionRepository.lockById(revisionId, tx)
    : await handymanQuotationRevisionRepository.findById(revisionId, tx);
  if (!revision) throw handymanQuotationRevisionNotFoundError();
  const quotation = await loadQuotationOrThrow(revision.quotationId, actorUserId, tx);
  void quotation;
  return revision;
}

export async function createHandymanQuotationRevision(
  input: CreateHandymanQuotationRevisionInput,
  actorUserId: string,
): Promise<PublicHandymanQuotationRevision> {
  const notes = normalizeNotes(input.notes);
  const validUntil = normalizeValidUntil(input.validUntil);

  return withTransaction(async (tx) => {
    const quotation = await loadQuotationOrThrow(
      input.quotationId,
      actorUserId,
      tx,
      { forUpdate: true },
    );
    assertRevisionCreatable(quotation);

    // RUN 3: opening a revision on a REJECTED envelope performs the governed
    // reopen transition of the request in the same transaction.
    const reopenedRequestStatus = await reopenRejectedQuotation(quotation, tx);

    // One-DRAFT rule: pre-check under the envelope lock; the partial unique
    // index is the structural backstop for any residual race.
    const existingDraft =
      await handymanQuotationRevisionRepository.findDraftByQuotation(
        quotation.id,
        tx,
      );
    if (existingDraft) throw handymanQuotationRevisionDraftExistsError();

    const revisionNumber =
      (await handymanQuotationRevisionRepository.findMaxRevisionNumber(
        quotation.id,
        tx,
      )) + 1;

    let revision: HandymanQuotationRevisionRecord;
    try {
      revision = await handymanQuotationRevisionRepository.create(
        {
          quotationId: quotation.id,
          clientId: quotation.clientId,
          buildingId: quotation.buildingId,
          revisionNumber,
          notes,
          validUntil,
          createdByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (isOneDraftViolation(error)) {
        throw handymanQuotationRevisionDraftExistsError();
      }
      throw error;
    }

    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        eventType: 'HANDYMAN_QUOTATION_REVISION_CREATED',
        entityType: 'HANDYMAN_QUOTATION_REVISION',
        entityId: revision.id,
        actorUserId,
        summary: `Quotation ${quotation.quotationNumber} revision ${revision.revisionNumber} opened.`,
        metadata: {
          quotationId: quotation.id,
          quotationNumber: quotation.quotationNumber,
          revisionNumber: revision.revisionNumber,
          reopenedFromRejected: reopenedRequestStatus !== null,
          requestStatus: reopenedRequestStatus,
        },
      },
      tx,
    );

    const totals = totalsFromRows(
      await handymanQuotationLineRepository.totalsByRevision(revision.id, tx),
    );
    return toPublicHandymanQuotationRevision(revision, totals);
  });
}

export type SubmitHandymanQuotationRevisionResult = {
  revision: PublicHandymanQuotationRevision;
  supersededRevisionIds: string[];
};

export async function submitHandymanQuotationRevision(
  revisionId: string,
  actorUserId: string,
): Promise<SubmitHandymanQuotationRevisionResult> {
  return withTransaction(async (tx) => {
    const revision = await loadRevisionOrThrow(revisionId, actorUserId, tx, {
      forUpdate: true,
    });
    const quotation = await handymanQuotationRepository.lockById(
      revision.quotationId,
      tx,
    );
    if (!quotation) throw handymanQuotationRevisionStateInvalidError();
    assertRevisionCreatable(quotation);

    const { lineCount } = await handymanQuotationLineRepository.totalsByRevision(
      revision.id,
      tx,
    );
    if (lineCount === 0) throw handymanQuotationLinesRequiredError();

    const submitted = await handymanQuotationRevisionRepository.submitFromDraft(
      revision.id,
      actorUserId,
      tx,
    );
    if (!submitted) {
      throw handymanQuotationRevisionStateInvalidError(
        'A concurrent command already moved this revision out of DRAFT.',
      );
    }

    const supersededRevisionIds =
      await handymanQuotationRevisionRepository.supersedeSubmittedExcept(
        quotation.id,
        submitted.id,
        actorUserId,
        tx,
      );

    const totals = totalsFromRows(
      await handymanQuotationLineRepository.totalsByRevision(submitted.id, tx),
    );

    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        eventType: 'HANDYMAN_QUOTATION_REVISION_SUBMITTED',
        entityType: 'HANDYMAN_QUOTATION_REVISION',
        entityId: submitted.id,
        actorUserId,
        summary: `Quotation ${quotation.quotationNumber} revision ${submitted.revisionNumber} submitted.`,
        metadata: {
          quotationId: quotation.id,
          quotationNumber: quotation.quotationNumber,
          revisionNumber: submitted.revisionNumber,
          totals,
          supersededRevisionIds,
        },
      },
      tx,
    );

    return {
      revision: toPublicHandymanQuotationRevision(submitted, totals),
      supersededRevisionIds,
    };
  });
}

export async function getHandymanQuotationRevision(
  revisionId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationRevision> {
  return withTransaction(async (tx) => {
    const revision = await loadRevisionOrThrow(revisionId, actorUserId, tx);
    const totals = totalsFromRows(
      await handymanQuotationLineRepository.totalsByRevision(revision.id, tx),
    );
    return toPublicHandymanQuotationRevision(revision, totals);
  });
}

export async function listHandymanQuotationRevisions(
  quotationId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationRevision[]> {
  return withTransaction(async (tx) => {
    const quotation = await loadQuotationOrThrow(quotationId, actorUserId, tx);
    const records = await handymanQuotationRevisionRepository.listByQuotation(
      quotation.id,
      tx,
    );
    const revisions: PublicHandymanQuotationRevision[] = [];
    for (const record of records) {
      const totals = totalsFromRows(
        await handymanQuotationLineRepository.totalsByRevision(record.id, tx),
      );
      revisions.push(toPublicHandymanQuotationRevision(record, totals));
    }
    return revisions;
  });
}

export const handymanQuotationRevisionService = {
  createHandymanQuotationRevision,
  submitHandymanQuotationRevision,
  getHandymanQuotationRevision,
  listHandymanQuotationRevisions,
};
