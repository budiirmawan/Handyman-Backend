import { assertHandymanQuotationInspectionReady } from './handyman-quotation-inspection';
import { createIssuedQuotationDocument } from './handyman-quotation-document.service';
import { permissionRepository } from '../permissions';
import { AppError } from '../../shared/errors';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { emitHandymanDomainNotificationIntent } from '../handyman-notifications/handyman-domain-notification.producer';
import { recordOperationalEvent } from '../operational-events';
import {
  assertHandymanQuotationPricingAuthority,
  assertQuotationThreadBuildingAccess,
} from './handyman-quotation-access';
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
    dpRequired: row.dpRequired ?? false,
    dpPercentage: row.dpPercentage ?? null,
    dpAmount: row.dpAmount ?? null,
    dpTermsNotes: row.dpTermsNotes ?? null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function resolveIssuedDpTerms(
  version: HandymanQuotationVersionRecord,
  totalAmount: number,
  input: {
    dpRequired?: boolean;
    dpPercentage?: number | null;
    dpAmount?: number | null;
    dpTermsNotes?: string | null;
  },
): {
  dpRequired: boolean;
  dpPercentage: number | null;
  dpAmount: number | null;
  dpTermsNotes: string | null;
} {
  const dpRequired =
    input.dpRequired !== undefined ? Boolean(input.dpRequired) : version.dpRequired;
  const dpTermsNotes =
    input.dpTermsNotes !== undefined
      ? typeof input.dpTermsNotes === 'string' && input.dpTermsNotes.trim().length > 0
        ? input.dpTermsNotes.trim()
        : null
      : version.dpTermsNotes;
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
  let dpPercentage =
    input.dpPercentage !== undefined
      ? input.dpPercentage === null
        ? null
        : Number(input.dpPercentage)
      : version.dpPercentage;
  let dpAmount =
    input.dpAmount !== undefined
      ? input.dpAmount === null
        ? null
        : Number(input.dpAmount)
      : version.dpAmount;

  if (dpPercentage === null && dpAmount === null) {
    throw AppError.validation('Quotation DP terms validation failed.', [
      {
        field: 'dpPercentage',
        message: 'dpPercentage or dpAmount is required when dpRequired is true.',
      },
    ]);
  }
  if (
    dpPercentage !== null &&
    (!Number.isFinite(dpPercentage) || dpPercentage <= 0 || dpPercentage > 100)
  ) {
    throw AppError.validation('Quotation DP terms validation failed.', [
      { field: 'dpPercentage', message: 'dpPercentage must be > 0 and <= 100.' },
    ]);
  }
  if (
    dpAmount !== null &&
    (!Number.isFinite(dpAmount) || dpAmount <= 0 || dpAmount > totalAmount)
  ) {
    throw AppError.validation('Quotation DP terms validation failed.', [
      {
        field: 'dpAmount',
        message: 'dpAmount must be > 0 and at most the quotation total amount.',
      },
    ]);
  }
  if (dpPercentage !== null && dpAmount === null) {
    dpAmount = Number(((totalAmount * dpPercentage) / 100).toFixed(2));
  } else if (dpAmount !== null && dpPercentage === null && totalAmount > 0) {
    dpPercentage = Number(((dpAmount / totalAmount) * 100).toFixed(2));
  }
  return {
    dpRequired: true,
    dpPercentage: dpPercentage !== null ? Number(dpPercentage.toFixed(2)) : null,
    dpAmount: dpAmount !== null ? Number(dpAmount.toFixed(2)) : null,
    dpTermsNotes,
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
  // CR-HM-SEC-01 PART 02: building-scope authority traced to the parent
  // request's building_id (BE-02G; no same-Client shortcut). This helper
  // guards issue / expire / supersede.
  await assertQuotationThreadBuildingAccess(tx as never, quotation, actorUserId);
  // PART 03E: issuance (and any later presentation change) is an Operations
  // commercial act, so the thread's customer side is refused here too — the
  // customer's own commercial act is the decision, which stays PIC-personal.
  await assertHandymanQuotationPricingAuthority(
    {
      clientId: quotation.clientId,
      handymanRequestId: quotation.handymanRequestId,
      actorUserId,
    },
    tx,
  );
  return quotation;
}

/**
 * DRAFT → ISSUED (+ atomic ISSUED → SUPERSEDED for the replaced
 * current version, when one exists). Issuing a replacement NEVER
 * touches APPROVED/REJECTED/EXPIRED versions; it does not copy lines.
 */
export async function issueHandymanQuotationVersion(
  quotationVersionId: string,
  input: {
    validUntil: string;
    dpRequired?: boolean;
    dpPercentage?: number | null;
    dpAmount?: number | null;
    dpTermsNotes?: string | null;
    documentLanguage?: 'id' | 'en';
  },
  actorUserId: string,
): Promise<PublicHandymanQuotationVersion> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');
  const validUntilMs = new Date(input.validUntil).getTime();
  if (!Number.isFinite(validUntilMs)) {
    throw handymanQuotationValidityInvalidError();
  }

  return withTransaction(async (tx) => {
    // The ISSUE and its document read one consistent source view.
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
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
    const permissions = await permissionRepository.listActivePermissionCodesForUser(actorUserId, tx);
    const actor = (await tx.query<{ status: string }>('SELECT status FROM users WHERE id=$1', [actorUserId])).rows[0];
    if (actor?.status !== 'ACTIVE' || !permissions.includes('handyman.commercial.manage')) {
      throw new AppError({ statusCode: 403, code: 'PERMISSION_DENIED',
        message: 'Issuing an official quotation requires Handyman commercial authority.' });
    }
    await assertHandymanQuotationInspectionReady(tx, quotation.handymanRequestId);
    const lines = await handymanQuotationLineRepository.listLines(
      tx,
      version.id,
    );
    if (lines.length < 1) throw handymanQuotationNoLinesError();
    const basisCount = await tx.query<{ n: string }>(`SELECT count(*)::text AS n
      FROM handyman_quotation_line_price_bases WHERE quotation_version_id=$1`, [version.id]);
    if (Number(basisCount.rows[0]?.n) !== lines.length) {
      throw new AppError({ code: 'HANDYMAN_QUOTATION_PRICE_BASIS_REQUIRED', statusCode: 409,
        message: 'Explicit commercial tax price basis is required for every quotation line before issue.' });
    }
    if (!(validUntilMs > Date.now())) {
      throw handymanQuotationValidityInvalidError();
    }
    const totalAmount = lines.reduce(
      (sum, line) => sum + Number(line.lineTotal),
      0,
    );
    const resolvedDpTerms = resolveIssuedDpTerms(version, totalAmount, input);

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
      // CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the notification
      // REACTION to the occurred supersession, on the SAME transaction. The
      // notification entity is the SUPERSEDED VERSION (the occurrence), so
      // two supersessions of the same quotation never collapse into one.
      await emitHandymanDomainNotificationIntent(
        {
          eventType: 'HANDYMAN_QUOTATION_SUPERSEDED',
          clientId: quotation.clientId,
          entityId: current.id,
          variables: {
            quotationId: quotation.id,
            quotationVersionId: current.id,
            versionNumber: current.versionNumber,
            supersededByVersionId: version.id,
            supersededByVersionNumber: version.versionNumber,
          },
        },
        { executor: tx },
      );
    }

    const issued = await handymanQuotationRepository
      .updateVersionLifecycle(
        tx,
        version.id,
        'ISSUED',
        new Date(validUntilMs),
        resolvedDpTerms,
      );
    if (!issued) throw handymanQuotationVersionNotFoundError();
    // The transition, frozen source, number and PDF are one commit. Any
    // renderer, master-data or storage failure rolls the transition back.
    await createIssuedQuotationDocument(tx, quotation, issued, actorUserId, input.documentLanguage);
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
      // CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the notification
      // REACTION to the occurred issuance, on the SAME transaction. The
      // notification entity is the ISSUED VERSION (the occurrence).
      await emitHandymanDomainNotificationIntent(
        {
          eventType: 'HANDYMAN_QUOTATION_ISSUED',
          clientId: quotation.clientId,
          entityId: version.id,
          variables: {
            quotationId: quotation.id,
            quotationVersionId: version.id,
            versionNumber: version.versionNumber,
            validUntil: new Date(validUntilMs).toISOString(),
          },
        },
        { executor: tx },
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
    // CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the notification REACTION
    // to the occurred expiry, on the SAME transaction.
    await emitHandymanDomainNotificationIntent(
      {
        eventType: 'HANDYMAN_QUOTATION_EXPIRED',
        clientId: quotation.clientId,
        entityId: version.id,
        variables: {
          quotationId: quotation.id,
          quotationVersionId: version.id,
          versionNumber: version.versionNumber,
          validUntil: version.validUntil.toISOString(),
        },
      },
      { executor: tx },
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
    // CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the notification REACTION
    // to the occurred supersession, on the SAME transaction.
    await emitHandymanDomainNotificationIntent(
      {
        eventType: 'HANDYMAN_QUOTATION_SUPERSEDED',
        clientId: quotation.clientId,
        entityId: version.id,
        variables: {
          quotationId: quotation.id,
          quotationVersionId: version.id,
          versionNumber: version.versionNumber,
        },
      },
      { executor: tx },
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
  // CR-HM-SEC-01 PART 02: building-scope authority traced to the parent
  // request's building_id (BE-02G; no same-Client shortcut).
  await assertQuotationThreadBuildingAccess(
    undefined as never,
    quotation,
    actorUserId,
  );
  const txless = undefined as never;
  const current = await handymanQuotationRepository.findCurrentIssued(
    txless,
    quotation.id,
  );
  return current ? toPublicVersion(current) : null;
}
