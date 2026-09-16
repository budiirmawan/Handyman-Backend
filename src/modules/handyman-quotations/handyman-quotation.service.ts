import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import { isValidUuid } from '../clients';
import {
  handymanRequestNotFoundError,
  handymanRequestRepository,
  handymanRequestStatusInvalidError,
} from '../handyman-requests';
import {
  handymanInspectionRepository,
  handymanRequestTriageRepository,
  handymanServiceSelectionRepository,
} from '../handyman-request-governance';
import { isHandymanServiceCategory } from '../handyman-providers';
import { recordOperationalEvent } from '../operational-events';
import {
  PRICE_CATALOG_CURRENCIES,
  priceCatalogLookupService,
} from '../price-catalog-entries';
import type { PriceCatalogCurrency } from '../price-catalog-entries';
import {
  serviceCatalogNotFoundError,
  serviceCatalogNotActiveError,
  serviceCatalogRepository,
} from '../service-catalog';
import {
  handymanRequestServiceClientMismatchError,
  handymanRequestServiceNotHandymanError,
} from '../handyman-request-governance';
import {
  handymanQuotationIdempotencyConflictError,
  handymanQuotationLineServiceNotSelectedError,
  handymanQuotationNotAllowedError,
  handymanQuotationNotFoundError,
  handymanQuotationNumberAlreadyExistsError,
  handymanQuotationSendRevisionInvalidError,
  handymanQuotationStateInvalidError,
} from './handyman-quotation.errors';
import { handymanQuotationApprovalAlreadyExistsError } from './handyman-quotation-approval.errors';
import { handymanQuotationApprovalRepository } from './handyman-quotation-approval.repository';
import { toPublicHandymanQuotationApproval } from './handyman-quotation-approval.service';
import type { PublicHandymanQuotationApproval } from './handyman-quotation-approval.types';
import { handymanQuotationRepository } from './handyman-quotation.repository';
import { handymanQuotationRevisionRepository } from './handyman-quotation-revision.repository';
import { handymanQuotationLineRepository } from './handyman-quotation-line.repository';
import type {
  CreateHandymanQuotationInput,
  HandymanQuotationRecord,
  HandymanQuotationRevisionRecord,
  HandymanQuotationLineRecord,
  HandymanQuotationTotals,
  PublicHandymanQuotation,
  PublicHandymanQuotationLine,
  PublicHandymanQuotationRevision,
} from './handyman-quotation.types';
import { HANDYMAN_QUOTATION_SENDABLE_STATUSES } from './handyman-quotation.types';

/**
 * CR-HM-BE-03 RUN 2 — Quotation envelope authority.
 *
 * One quotation identity per commercial offer loop for a request: created
 * only from governed lifecycle states (TRIAGED / INSPECTION_COMPLETED with
 * an ACTIVE triage), frozen tenant/customer snapshot, server-generated
 * number (CR-HM-BE-01 idiom), BE-01 key+fingerprint idempotency. Sending
 * binds exactly one SUBMITTED revision, moves the request to
 * QUOTATION_PENDING through the guarded CR-HM-BE-01 transition, and
 * re-validates every LABOR line against the governed ACTIVE service
 * selections at send time. Withdrawal (the minimum transition the
 * commercial revision loop needs) returns the request to its triaged
 * lifecycle state and retains the sent facts as history.
 *
 * Deliberately absent: approval, secure links, notifications, provider
 * assignment, FX, discounts, BM fees, settlement, invoice semantics.
 */

const UNIQUE_VIOLATION = '23505';
const CLIENT_NUMBER_CONSTRAINT = 'handyman_quotations_client_number_unique';
const CLIENT_IDEMPOTENCY_CONSTRAINT =
  'handyman_quotations_client_idempotency_unique';

/** Request lifecycle states from which a quotation may be created/sent. */
const QUOTABLE_REQUEST_STATUSES = new Set(['TRIAGED', 'INSPECTION_COMPLETED']);

function isConstraintViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION &&
    (error as { constraint?: string }).constraint === constraint
  );
}

/** BE-01 fingerprint idiom over the caller-supplied command facts only. */
function computeQuotationFingerprint(input: {
  requestId: string;
  currency: string;
}): string {
  const canonical = JSON.stringify({
    currency: input.currency,
    requestId: input.requestId,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function parseIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'idempotencyKey', message: 'Idempotency key must be a string.' },
    ]);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 200) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'idempotencyKey',
        message: 'Idempotency key must be at most 200 characters.',
      },
    ]);
  }
  return trimmed;
}

function parseCurrency(value: unknown): PriceCatalogCurrency {
  if (
    typeof value !== 'string' ||
    !(PRICE_CATALOG_CURRENCIES as readonly string[]).includes(value)
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'currency',
        message: `Currency must be one of ${PRICE_CATALOG_CURRENCIES.join(', ')}.`,
      },
    ]);
  }
  return value as PriceCatalogCurrency;
}

async function generateNextQuotationNumber(
  clientId: string,
  date: Date,
  tx: Pick<PoolClient, 'query'>,
): Promise<string> {
  const year = date.getUTCFullYear();
  const prefix = `HMQ-${year}-`;
  const lastNumber = await handymanQuotationRepository.findLastQuotationNumber(
    clientId,
    prefix,
    tx,
  );

  let nextSequence = 1;
  if (lastNumber) {
    const match = lastNumber.match(new RegExp(`^HMQ-${year}-(\\d+)$`));
    if (match) {
      nextSequence = parseInt(match[1], 10) + 1;
    }
  }
  return `${prefix}${String(nextSequence).padStart(6, '0')}`;
}

export function toPublicHandymanQuotation(
  record: HandymanQuotationRecord,
): PublicHandymanQuotation {
  return {
    id: record.id,
    requestId: record.requestId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    quotationNumber: record.quotationNumber,
    currency: record.currency,
    status: record.status,
    tenantCompanyId: record.tenantCompanyId,
    tenantPicId: record.tenantPicId,
    customerName: record.customerName,
    customerPhone: record.customerPhone,
    customerEmail: record.customerEmail,
    sentRevisionId: record.sentRevisionId,
    sentAt: record.sentAt ? record.sentAt.toISOString() : null,
    withdrawnAt: record.withdrawnAt ? record.withdrawnAt.toISOString() : null,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function totalsFromRows(rows: {
  laborTotal: string;
  materialTotal: string;
  otherTotal: string;
  grandTotal: string;
}): HandymanQuotationTotals {
  return {
    laborTotal: Number(rows.laborTotal),
    materialTotal: Number(rows.materialTotal),
    otherTotal: Number(rows.otherTotal),
    grandTotal: Number(rows.grandTotal),
  };
}

export function toPublicHandymanQuotationRevision(
  record: HandymanQuotationRevisionRecord,
  totals: HandymanQuotationTotals,
): PublicHandymanQuotationRevision {
  return {
    id: record.id,
    quotationId: record.quotationId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    revisionNumber: record.revisionNumber,
    status: record.status,
    notes: record.notes,
    validUntil: record.validUntil,
    submittedAt: record.submittedAt ? record.submittedAt.toISOString() : null,
    submittedByUserId: record.submittedByUserId,
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
    supersededByUserId: record.supersededByUserId,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    totals,
  };
}

export function toPublicHandymanQuotationLine(
  record: HandymanQuotationLineRecord,
): PublicHandymanQuotationLine {
  return {
    id: record.id,
    quotationRevisionId: record.quotationRevisionId,
    quotationId: record.quotationId,
    lineNumber: record.lineNumber,
    lineType: record.lineType,
    serviceCatalogId: record.serviceCatalogId,
    inventoryItemId: record.inventoryItemId,
    uomId: record.uomId,
    quantity: record.quantity === null ? null : Number(record.quantity),
    subjectCode: record.subjectCode,
    subjectName: record.subjectName,
    uomCode: record.uomCode,
    description: record.description,
    unitPrice: Number(record.unitPrice),
    lineTotal: Number(record.lineTotal),
    referenceResolution: record.referenceResolution,
    referencePriceEntryId: record.referencePriceEntryId,
    referenceScopeTier: record.referenceScopeTier,
    referenceUnitPrice:
      record.referenceUnitPrice === null ? null : Number(record.referenceUnitPrice),
    referenceAsOf: record.referenceAsOf ? record.referenceAsOf.toISOString() : null,
    deviationNote: record.deviationNote,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Loads the envelope inside a transaction and enforces building access. */
export async function loadQuotationOrThrow(
  quotationId: string,
  actorUserId: string,
  tx: Pick<PoolClient, 'query'>,
  options: { forUpdate?: boolean } = {},
): Promise<HandymanQuotationRecord> {
  if (!isValidUuid(quotationId)) throw handymanQuotationNotFoundError();
  const quotation = options.forUpdate
    ? await handymanQuotationRepository.lockById(quotationId, tx)
    : await handymanQuotationRepository.findById(quotationId, tx);
  if (!quotation) throw handymanQuotationNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, quotation.buildingId);
  return quotation;
}

/**
 * Re-validates one LABOR subject against the governed foundations at send
 * time: an ACTIVE selection must still exist on the request AND the catalog
 * entry must still be a same-client ACTIVE HANDYMAN service. Selections can
 * be superseded between authoring and send; sending stale labor fails
 * closed instead of quoting an ungoverned service.
 */
export async function assertLaborLineStillGoverned(
  line: HandymanQuotationLineRecord,
  request: { id: string; clientId: string },
  tx: Pick<PoolClient, 'query'>,
): Promise<void> {
  const serviceCatalogId = line.serviceCatalogId;
  if (!serviceCatalogId) {
    throw handymanQuotationLineServiceNotSelectedError(
      'A LABOR line lost its governed service subject.',
    );
  }
  const selection =
    await handymanServiceSelectionRepository.findActiveByRequestAndService(
      request.id,
      serviceCatalogId,
      tx,
    );
  if (!selection) {
    throw handymanQuotationLineServiceNotSelectedError();
  }
  const service = await serviceCatalogRepository.findById(tx, serviceCatalogId);
  if (!service) throw serviceCatalogNotFoundError();
  if (service.status !== 'ACTIVE') throw serviceCatalogNotActiveError();
  if (service.clientId !== request.clientId) {
    throw handymanRequestServiceClientMismatchError();
  }
  if (!isHandymanServiceCategory(service.category)) {
    throw handymanRequestServiceNotHandymanError();
  }
}

export type CreateHandymanQuotationResult = {
  quotation: PublicHandymanQuotation;
  revision: PublicHandymanQuotationRevision;
  replayed: boolean;
};

export async function createHandymanQuotation(
  input: CreateHandymanQuotationInput,
  actorUserId: string,
): Promise<CreateHandymanQuotationResult> {
  if (!isValidUuid(input.requestId)) throw handymanRequestNotFoundError();
  const currency = parseCurrency(input.currency);
  const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
  const fingerprint = computeQuotationFingerprint({
    requestId: input.requestId,
    currency,
  });

  // Request existence + access + derived client scope (never caller-supplied).
  const requestContext = await handymanRequestRepository.findById(input.requestId);
  if (!requestContext) throw handymanRequestNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    requestContext.buildingId,
  );

  // Idempotency pre-check (BE-01 idiom): same key + same fingerprint replays
  // the stored envelope; same key + different command facts conflict.
  if (idempotencyKey) {
    const existing = await handymanQuotationRepository.findByIdempotencyKey(
      requestContext.clientId,
      idempotencyKey,
    );
    if (existing) {
      if (existing.idempotencyFingerprint !== fingerprint) {
        throw handymanQuotationIdempotencyConflictError();
      }
      return { ...(await toCreateResult(existing, true)), replayed: true };
    }
  }

  return withTransaction(async (tx) => {
    const request = await handymanRequestRepository.findById(input.requestId, tx);
    if (!request) throw handymanRequestNotFoundError();

    // Governed lifecycle gate: quotation authoring starts only from a
    // triaged (or inspection-completed) request with an ACTIVE triage.
    if (!QUOTABLE_REQUEST_STATUSES.has(request.status)) {
      throw handymanQuotationNotAllowedError();
    }
    const activeTriage = await handymanRequestTriageRepository.findActiveByRequest(
      request.id,
      tx,
    );
    if (!activeTriage) {
      throw handymanQuotationNotAllowedError(
        'A quotation requires an ACTIVE triage decision on the handyman request.',
      );
    }

    // In-transaction idempotency re-check (BE-01 race idiom).
    if (idempotencyKey) {
      const existing = await handymanQuotationRepository.findByIdempotencyKey(
        request.clientId,
        idempotencyKey,
        tx,
      );
      if (existing) {
        if (existing.idempotencyFingerprint !== fingerprint) {
          throw handymanQuotationIdempotencyConflictError();
        }
        return { ...(await toCreateResult(existing, true, tx)), replayed: true };
      }
    }

    // Serialize number allocation per client (BE-01 numbering idiom).
    await tx.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [
      request.clientId,
    ]);
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      'handyman_quotations',
      request.clientId,
    ]);
    const quotationNumber = await generateNextQuotationNumber(
      request.clientId,
      new Date(),
      tx,
    );

    let quotation: HandymanQuotationRecord;
    try {
      quotation = await handymanQuotationRepository.create(
        {
          requestId: request.id,
          clientId: request.clientId,
          buildingId: request.buildingId,
          quotationNumber,
          currency,
          // Frozen identity snapshot — taken from the request, never from
          // the caller.
          tenantCompanyId: request.tenantCompanyId,
          tenantPicId: request.tenantPicId,
          customerName: request.customerName,
          customerPhone: request.customerPhone,
          customerEmail: request.customerEmail,
          idempotencyKey,
          idempotencyFingerprint: idempotencyKey ? fingerprint : null,
          createdByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (isConstraintViolation(error, CLIENT_NUMBER_CONSTRAINT)) {
        throw handymanQuotationNumberAlreadyExistsError();
      }
      if (
        idempotencyKey &&
        isConstraintViolation(error, CLIENT_IDEMPOTENCY_CONSTRAINT)
      ) {
        const winner = await handymanQuotationRepository.findByIdempotencyKey(
          request.clientId,
          idempotencyKey,
          tx,
        );
        if (winner && winner.idempotencyFingerprint === fingerprint) {
          return { ...(await toCreateResult(winner, true, tx)), replayed: true };
        }
        throw handymanQuotationIdempotencyConflictError();
      }
      throw error;
    }

    // Revision 1 (DRAFT) is created with the envelope — the quotation is
    // never line-less structure; the commercial loop starts immediately.
    const revision = await handymanQuotationRevisionRepository.create(
      {
        quotationId: quotation.id,
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        revisionNumber: 1,
        notes: null,
        validUntil: null,
        createdByUserId: actorUserId,
      },
      tx,
    );

    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        eventType: 'HANDYMAN_QUOTATION_CREATED',
        entityType: 'HANDYMAN_QUOTATION',
        entityId: quotation.id,
        actorUserId,
        summary: `Quotation ${quotation.quotationNumber} created for handyman request ${request.requestNumber}.`,
        metadata: {
          quotationNumber: quotation.quotationNumber,
          requestId: request.id,
          requestNumber: request.requestNumber,
          currency: quotation.currency,
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
        },
      },
      tx,
    );

    const totals = totalsFromRows(
      await handymanQuotationLineRepository.totalsByRevision(revision.id, tx),
    );
    return {
      quotation: toPublicHandymanQuotation(quotation),
      revision: toPublicHandymanQuotationRevision(revision, totals),
      replayed: false,
    };
  });

  async function toCreateResult(
    quotation: HandymanQuotationRecord,
    replayed: boolean,
    tx?: Pick<PoolClient, 'query'>,
  ): Promise<{ quotation: PublicHandymanQuotation; revision: PublicHandymanQuotationRevision }> {
    const revisions = await handymanQuotationRevisionRepository.listByQuotation(
      quotation.id,
      tx ?? undefined,
    );
    const draft = revisions.find((candidate) => candidate.status === 'DRAFT');
    const revision = draft ?? revisions[0];
    if (!revision) {
      // Structurally impossible (revision 1 is created with the envelope),
      // but fail closed rather than invent a revision.
      throw handymanQuotationStateInvalidError(
        'The stored quotation has no revision history.',
      );
    }
    const totals = totalsFromRows(
      await handymanQuotationLineRepository.totalsByRevision(
        revision.id,
        tx ?? undefined,
      ),
    );
    return {
      quotation: toPublicHandymanQuotation(quotation),
      revision: toPublicHandymanQuotationRevision(revision, totals),
    };
  }
}

export async function getHandymanQuotation(
  quotationId: string,
  actorUserId: string,
): Promise<{
  quotation: PublicHandymanQuotation;
  revisions: PublicHandymanQuotationRevision[];
}> {
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
    return { quotation: toPublicHandymanQuotation(quotation), revisions };
  });
}

export async function listHandymanQuotationsByRequest(
  requestId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotation[]> {
  if (!isValidUuid(requestId)) throw handymanRequestNotFoundError();
  const request = await handymanRequestRepository.findById(requestId);
  if (!request) throw handymanRequestNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, request.buildingId);
  const records = await handymanQuotationRepository.listByRequest(request.id);
  return records.map(toPublicHandymanQuotation);
}

export type SendHandymanQuotationInput = {
  quotationId: string;
  revisionId: string;
};

export async function sendHandymanQuotation(
  input: SendHandymanQuotationInput,
  actorUserId: string,
): Promise<{
  quotation: PublicHandymanQuotation;
  revision: PublicHandymanQuotationRevision;
  approval: PublicHandymanQuotationApproval;
}> {
  if (!isValidUuid(input.revisionId)) {
    throw handymanQuotationSendRevisionInvalidError();
  }

  return withTransaction(async (tx) => {
    const quotation = await loadQuotationOrThrow(
      input.quotationId,
      actorUserId,
      tx,
      { forUpdate: true },
    );
    if (
      !(HANDYMAN_QUOTATION_SENDABLE_STATUSES as readonly string[]).includes(
        quotation.status,
      )
    ) {
      throw handymanQuotationStateInvalidError(
        quotation.status === 'SENT'
          ? 'The quotation is already SENT; withdraw it before sending a new revision.'
          : undefined,
      );
    }

    const revision = await handymanQuotationRevisionRepository.lockById(
      input.revisionId,
      tx,
    );
    if (!revision) throw handymanQuotationSendRevisionInvalidError();
    if (
      revision.quotationId !== quotation.id ||
      revision.status !== 'SUBMITTED'
    ) {
      throw handymanQuotationSendRevisionInvalidError();
    }

    const lines = await handymanQuotationLineRepository.listByRevision(
      revision.id,
      tx,
    );
    if (lines.length === 0) {
      throw handymanQuotationStateInvalidError(
        'A sent revision must carry at least one governed line.',
      );
    }

    const request = await handymanRequestRepository.findById(quotation.requestId, tx);
    if (!request) throw handymanRequestNotFoundError();
    const activeTriage = await handymanRequestTriageRepository.findActiveByRequest(
      request.id,
      tx,
    );
    if (!activeTriage) {
      throw handymanQuotationNotAllowedError(
        'Sending requires an ACTIVE triage decision on the handyman request.',
      );
    }
    // Inspection-path defense in depth: the INSPECTION lifecycle must have a
    // completed inspection before the request can reach the quotation phase.
    if (activeTriage.path === 'INSPECTION') {
      const completed = await handymanInspectionRepository.countCompletedByRequest(
        request.id,
        tx,
      );
      if (completed === 0) {
        throw handymanQuotationNotAllowedError(
          'The inspection path requires a completed inspection before sending a quotation.',
        );
      }
    }
    if (!QUOTABLE_REQUEST_STATUSES.has(request.status)) {
      throw handymanQuotationNotAllowedError();
    }

    // LABOR authority re-validation at send time (governed selections only).
    for (const line of lines) {
      if (line.lineType === 'LABOR') {
        await assertLaborLineStillGoverned(line, request, tx);
      }
    }

    // Guarded envelope transition: exactly one concurrent send can win.
    const sent = await handymanQuotationRepository.markSentFrom(
      quotation.id,
      revision.id,
      HANDYMAN_QUOTATION_SENDABLE_STATUSES,
      tx,
    );
    if (!sent) {
      throw handymanQuotationStateInvalidError(
        'A concurrent command already moved this quotation out of its sendable state.',
      );
    }

    // Guarded request transition into the quotation phase.
    const movedRequest = await handymanRequestRepository.updateStatusFrom(
      request.id,
      request.status,
      'QUOTATION_PENDING',
      tx,
    );
    if (!movedRequest) {
      throw handymanRequestStatusInvalidError();
    }

    const totals = totalsFromRows(
      await handymanQuotationLineRepository.totalsByRevision(revision.id, tx),
    );

    // CR-HM-BE-03 RUN 3 — approval composition: a successful send creates
    // exactly one PENDING approval for the exact sent revision in the SAME
    // transaction (send concurrency/idempotency guarantees are preserved —
    // only the guarded-send winner reaches this point). Any stale PENDING
    // approval from an earlier send cycle is expired first so at most one
    // PENDING approval exists per quotation.
    const expiredApprovalIds =
      await handymanQuotationApprovalRepository.expirePendingByQuotation(
        quotation.id,
        tx,
      );
    let approval;
    try {
      approval = await handymanQuotationApprovalRepository.createPending(
        {
          quotationId: quotation.id,
          quotationRevisionId: revision.id,
          clientId: quotation.clientId,
          buildingId: quotation.buildingId,
          createdByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error as { code?: string }).code === '23505' &&
        (error as { constraint?: string }).constraint ===
          'handyman_quotation_approvals_one_pending_per_revision'
      ) {
        throw handymanQuotationApprovalAlreadyExistsError();
      }
      throw error;
    }

    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        eventType: 'HANDYMAN_QUOTATION_SENT',
        entityType: 'HANDYMAN_QUOTATION',
        entityId: quotation.id,
        actorUserId,
        summary: `Quotation ${quotation.quotationNumber} revision ${revision.revisionNumber} sent for handyman request ${request.requestNumber}.`,
        metadata: {
          quotationNumber: quotation.quotationNumber,
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          requestId: request.id,
          requestNumber: request.requestNumber,
          totals,
        },
      },
      tx,
    );

    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        eventType: 'HANDYMAN_QUOTATION_APPROVAL_CREATED',
        entityType: 'HANDYMAN_QUOTATION_APPROVAL',
        entityId: approval.id,
        actorUserId,
        summary: `Pending customer approval created for quotation ${quotation.quotationNumber} revision ${revision.revisionNumber}.`,
        metadata: {
          approvalId: approval.id,
          quotationId: quotation.id,
          quotationNumber: quotation.quotationNumber,
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          requestId: request.id,
          requestNumber: request.requestNumber,
          expiredApprovalIds,
        },
      },
      tx,
    );

    return {
      quotation: toPublicHandymanQuotation(sent),
      revision: toPublicHandymanQuotationRevision(revision, totals),
      approval: toPublicHandymanQuotationApproval(approval),
    };
  });
}

export async function withdrawHandymanQuotation(
  quotationId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotation> {
  return withTransaction(async (tx) => {
    const quotation = await loadQuotationOrThrow(quotationId, actorUserId, tx, {
      forUpdate: true,
    });
    const withdrawn = await handymanQuotationRepository.markWithdrawnFromSent(
      quotation.id,
      tx,
    );
    if (!withdrawn) {
      throw handymanQuotationStateInvalidError(
        'Only a SENT quotation can be withdrawn.',
      );
    }

    // CR-HM-BE-03 RUN 3: withdrawing a SENT quotation expires its PENDING
    // approval (expiration is never a decision) so exactly one PENDING
    // approval can exist per quotation and only for a live sent revision.
    const expiredApprovalIds =
      await handymanQuotationApprovalRepository.expirePendingByQuotation(
        quotation.id,
        tx,
      );

    // Return the request to its triaged lifecycle state so the SAME
    // quotation identity can carry a fresh revision (re-quote loop).
    const request = await handymanRequestRepository.findById(quotation.requestId, tx);
    if (!request) throw handymanRequestNotFoundError();
    const activeTriage = await handymanRequestTriageRepository.findActiveByRequest(
      request.id,
      tx,
    );
    if (!activeTriage) {
      throw handymanQuotationNotAllowedError(
        'Withdrawal requires an ACTIVE triage decision on the handyman request.',
      );
    }
    const targetStatus =
      activeTriage.path === 'INSPECTION' ? 'INSPECTION_COMPLETED' : 'TRIAGED';
    const movedRequest = await handymanRequestRepository.updateStatusFrom(
      request.id,
      'QUOTATION_PENDING',
      targetStatus,
      tx,
    );
    if (!movedRequest) {
      throw handymanRequestStatusInvalidError();
    }

    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        eventType: 'HANDYMAN_QUOTATION_WITHDRAWN',
        entityType: 'HANDYMAN_QUOTATION',
        entityId: quotation.id,
        actorUserId,
        summary: `Quotation ${quotation.quotationNumber} withdrawn for handyman request ${request.requestNumber}.`,
        metadata: {
          quotationNumber: quotation.quotationNumber,
          sentRevisionId: quotation.sentRevisionId,
          requestId: request.id,
          requestNumber: request.requestNumber,
          requestStatus: targetStatus,
          expiredApprovalIds,
        },
      },
      tx,
    );

    return toPublicHandymanQuotation(withdrawn);
  });
}

export const handymanQuotationService = {
  createHandymanQuotation,
  getHandymanQuotation,
  listHandymanQuotationsByRequest,
  sendHandymanQuotation,
  withdrawHandymanQuotation,
};
