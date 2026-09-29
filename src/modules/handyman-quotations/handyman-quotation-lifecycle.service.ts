import { AppError } from '../../shared/errors';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanQuotationRepository } from './handyman-quotation.repository';
import { handymanQuotationLineRepository } from './handyman-quotation-line.repository';
import {
  handymanQuotationInvalidTransitionError,
  handymanQuotationNoLinesError,
  handymanQuotationNotExpirableError,
  handymanQuotationNotFoundError,
  handymanQuotationValidityInvalidError,
  handymanQuotationVersionNotFoundError,
} from './handyman-quotation.errors';
import type {
  HandymanQuotationVersionRecord,
} from './handyman-quotation.types';
import type { PublicHandymanQuotationVersion } from './handyman-quotation.types';

/**
 * CR-HM-06 PART 03 — quotation version lifecycle (FROZEN F2/F3/F4).
 * Exactly three transitions exist:
 *
 *   DRAFT  → ISSUED      (lines >= 1; validUntil > server time; issuing
 *                         a replacement atomically SUPERSEDES the
 *                         thread's current ISSUED version, if any)
 *   ISSUED → EXPIRED     (only when server time >= validUntil)
 *   ISSUED → SUPERSEDED  (replacement issuance, or explicit supersede)
 *
 * APPROVED/REJECTED remain vocabulary only (PART 04 owns them). Only
 * PART 01's reserved lifecycle projection columns ever change; lines,
 * version identity, and commercial snapshots are immutable (0391/0392
 * triggers are the DB backstop). No line copying on revision, no
 * approval/execution-scope/payment/BAST/FM side effects. Journal is
 * audit-only; lifecycle authority lives in the row projections.
 */

function assertUuid(value: string | undefined, field: string): void {
  if (value === undefined || !isValidUuid(value)) {
    throw AppError.validation('Quotation lifecycle validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
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

async function requireAccessibleQuotation(
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
  quotationId: string,
  actorUserId: string,
) {
  const quotation = await handymanQuotationRepository.findQuotationById(
    tx as never,
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
  return quotation;
}

/**
 * DRAFT → ISSUED (+ atomic ISSUED → SUPERSEDED for the replaced
 * current version, when one exists). Issuing a replacement NEVER
 * touches APPROVED/REJECTED/EXPIRED versions; it does not copy lines.
 */
export async function issueHandymanQuotationVersion(
  quotationVersionId: string,
  input: { validUntil: string },
  actorUserId: string,
): Promise<PublicHandymanQuotationVersion> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');
  const validUntilMs = new Date(input.validUntil).getTime();
  if (!Number.isFinite(validUntilMs)) {
    throw handymanQuotationValidityInvalidError();
  }

  return withTransaction(async (tx) => {
    const version = await handymanQuotationRepository.lockVersionById(
      tx,
      quotationVersionId,
    );
    if (!version) throw handymanQuotationVersionNotFoundError();
    const quotation = await requireAccessibleQuotation(
      tx,
      version.quotationId,
      actorUserId,
    );
    if (version.status !== 'DRAFT') {
      throw handymanQuotationInvalidTransitionError();
    }
    const lines = await handymanQuotationLineRepository.listLines(
      tx,
      version.id,
    );
    if (lines.length < 1) throw handymanQuotationNoLinesError();
    if (!(validUntilMs > Date.now())) {
      throw handymanQuotationValidityInvalidError();
    }

    // Atomic replacement: supersede the thread's current ISSUED version
    // (if any) — only ISSUED versions are ever superseded here, and at
    // most one can exist (0393 partial unique index as DB backstop).
    const current = await handymanQuotationRepository.findCurrentIssued(
      tx,
      quotation.id,
    );
    if (current && current.id !== version.id) {
      await handymanQuotationRepository.updateVersionLifecycle(
        tx,
        current.id,
        'SUPERSEDED',
        undefined,
      );
      await recordOperationalEvent(
        {
          clientId: quotation.clientId,
          eventType: 'HANDYMAN_QUOTATION_SUPERSEDED',
          entityType: 'HANDYMAN_QUOTATION_VERSION',
          entityId: current.id,
          actorUserId,
          summary: `Handyman quotation version ${current.versionNumber} superseded by version ${version.versionNumber}.`,
          metadata: {
            quotationId: quotation.id,
            quotationVersionId: current.id,
            versionNumber: current.versionNumber,
            supersededByVersionId: version.id,
            supersededByVersionNumber: version.versionNumber,
          },
        },
        tx,
      );
    }

    const issued = await handymanQuotationRepository
      .updateVersionLifecycle(
        tx,
        version.id,
        'ISSUED',
        new Date(validUntilMs),
      );
    if (!issued) throw handymanQuotationVersionNotFoundError();
    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        eventType: 'HANDYMAN_QUOTATION_ISSUED',
        entityType: 'HANDYMAN_QUOTATION_VERSION',
        entityId: version.id,
        actorUserId,
        summary: `Handyman quotation version ${version.versionNumber} issued.`,
        metadata: {
          quotationId: quotation.id,
          quotationVersionId: version.id,
          versionNumber: version.versionNumber,
          validUntil: new Date(validUntilMs).toISOString(),
          lineCount: lines.length,
        },
      },
      tx,
    );
    return toPublicVersion(issued);
  });
}

/** ISSUED → EXPIRED, only at/after the server-authoritative validUntil. */
export async function expireHandymanQuotationVersion(
  quotationVersionId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationVersion> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');

  return withTransaction(async (tx) => {
    const version = await handymanQuotationRepository.lockVersionById(
      tx,
      quotationVersionId,
    );
    if (!version) throw handymanQuotationVersionNotFoundError();
    const quotation = await requireAccessibleQuotation(
      tx,
      version.quotationId,
      actorUserId,
    );
    if (version.status !== 'ISSUED') {
      throw handymanQuotationInvalidTransitionError();
    }
    if (!version.validUntil || version.validUntil.getTime() > Date.now()) {
      throw handymanQuotationNotExpirableError();
    }
    const expired = await handymanQuotationRepository
      .updateVersionLifecycle(tx, version.id, 'EXPIRED', undefined);
    if (!expired) throw handymanQuotationVersionNotFoundError();
    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        eventType: 'HANDYMAN_QUOTATION_EXPIRED',
        entityType: 'HANDYMAN_QUOTATION_VERSION',
        entityId: version.id,
        actorUserId,
        summary: `Handyman quotation version ${version.versionNumber} expired.`,
        metadata: {
          quotationId: quotation.id,
          quotationVersionId: version.id,
          versionNumber: version.versionNumber,
          validUntil: version.validUntil.toISOString(),
        },
      },
      tx,
    );
    return toPublicVersion(expired);
  });
}

/** Explicit ISSUED → SUPERSEDED (replacement withdrawal before expiry). */
export async function supersedeHandymanQuotationVersion(
  quotationVersionId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationVersion> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');

  return withTransaction(async (tx) => {
    const version = await handymanQuotationRepository.lockVersionById(
      tx,
      quotationVersionId,
    );
    if (!version) throw handymanQuotationVersionNotFoundError();
    const quotation = await requireAccessibleQuotation(
      tx,
      version.quotationId,
      actorUserId,
    );
    if (version.status !== 'ISSUED') {
      throw handymanQuotationInvalidTransitionError();
    }
    const superseded = await handymanQuotationRepository
      .updateVersionLifecycle(tx, version.id, 'SUPERSEDED', undefined);
    if (!superseded) throw handymanQuotationVersionNotFoundError();
    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        eventType: 'HANDYMAN_QUOTATION_SUPERSEDED',
        entityType: 'HANDYMAN_QUOTATION_VERSION',
        entityId: version.id,
        actorUserId,
        summary: `Handyman quotation version ${version.versionNumber} superseded.`,
        metadata: {
          quotationId: quotation.id,
          quotationVersionId: version.id,
          versionNumber: version.versionNumber,
        },
      },
      tx,
    );
    return toPublicVersion(superseded);
  });
}

/**
 * Bounded read: the single current customer-presentable ISSUED version
 * for a quotation thread (by request lineage). DRAFTs are never
 * customer-presentable; at most one ISSUED version exists per thread.
 */
export async function getCurrentHandymanIssuedQuotationVersion(
  handymanRequestId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationVersion | null> {
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
  const txless = undefined as never;
  const current = await handymanQuotationRepository.findCurrentIssued(
    txless,
    quotation.id,
  );
  return current ? toPublicVersion(current) : null;
}
