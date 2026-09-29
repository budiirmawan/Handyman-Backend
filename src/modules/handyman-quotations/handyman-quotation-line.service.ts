import { AppError } from '../../shared/errors';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { priceCatalogLookupService } from '../price-catalog-entries';
import {
  handymanServiceRequestRepository,
} from '../handyman-requests';
import { handymanQuotationRepository } from './handyman-quotation.repository';
import { handymanQuotationLineRepository } from './handyman-quotation-line.repository';
import { handymanQuotationNotFoundError } from './handyman-quotation.errors';
import {
  handymanQuotationCurrencyMismatchError,
  handymanQuotationLineInvalidError,
  handymanQuotationVersionNotDraftError,
  handymanQuotationVersionNotFoundError,
} from './handyman-quotation.errors';
import {
  HANDYMAN_QUOTATION_CURRENCIES,
  HANDYMAN_QUOTATION_LINE_TYPES,
  type AddHandymanQuotationLineInput,
  type HandymanQuotationLineRecord,
  type PublicHandymanQuotationLine,
  type PublicHandymanQuotationTotals,
} from './handyman-quotation-line.types';

/**
 * CR-HM-06 PART 02 — quotation commercial snapshot lines service
 * (FROZEN F4/F5). Bounded to: add an immutable LABOR/MATERIAL line to a
 * DRAFT version, list lines, and derive totals. Lineage (client/
 * request/building/currency policy) is always derived from the locked
 * version's quotation root; the caller supplies ONLY the commercial
 * facts being quoted. lineTotal is server-calculated (DB), reference
 * price is a governed price-catalog snapshot (never caller-authored),
 * one currency per version, no tax/discount, no CR-HM-12 pricing
 * modes/rules, no inventory mutation, no lifecycle transitions.
 */

function assertUuid(value: string | undefined, field: string): void {
  if (value === undefined || !isValidUuid(value)) {
    throw AppError.validation('Quotation line validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
}

function isValidAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toPublicLine(
  row: HandymanQuotationLineRecord,
): PublicHandymanQuotationLine {
  return {
    id: row.id,
    quotationVersionId: row.quotationVersionId,
    lineType: row.lineType,
    description: row.description,
    quantity: row.quantity,
    uomId: row.uomId,
    referenceUnitAmount: row.referenceUnitAmount,
    finalQuotedUnitAmount: row.finalQuotedUnitAmount,
    lineTotal: row.lineTotal,
    currency: row.currency,
    sourceItemId: row.sourceItemId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validateInput(
  input: AddHandymanQuotationLineInput,
): { description: string } {
  if (
    !(HANDYMAN_QUOTATION_LINE_TYPES as readonly string[]).includes(
      input.lineType,
    )
  ) {
    throw handymanQuotationLineInvalidError(
      'lineType must be exactly LABOR or MATERIAL.',
    );
  }
  const description =
    typeof input.description === 'string' ? input.description.trim() : '';
  if (description.length < 1 || description.length > 1000) {
    throw handymanQuotationLineInvalidError(
      'description is required (1-1000 characters).',
    );
  }
  if (!isValidAmount(input.quantity) || input.quantity <= 0) {
    throw handymanQuotationLineInvalidError('quantity must be > 0.');
  }
  if (
    !isValidAmount(input.finalQuotedUnitAmount) ||
    input.finalQuotedUnitAmount < 0
  ) {
    throw handymanQuotationLineInvalidError(
      'finalQuotedUnitAmount must be >= 0.',
    );
  }
  assertUuid(input.uomId, 'uomId');
  if (
    !(HANDYMAN_QUOTATION_CURRENCIES as readonly string[]).includes(
      input.currency,
    )
  ) {
    throw handymanQuotationLineInvalidError(
      'currency must be one of the governed currencies.',
    );
  }
  if (input.sourceItemId !== undefined) {
    assertUuid(input.sourceItemId, 'sourceItemId');
    if (input.lineType !== 'MATERIAL') {
      throw handymanQuotationLineInvalidError(
        'sourceItemId is only valid for MATERIAL lines.',
      );
    }
  }
  return { description };
}

/**
 * Add one immutable line to a DRAFT version (atomic: lock version →
 * derive lineage → validate scope/uom/item → one-currency rule →
 * governed reference snapshot → insert → audit journal).
 */
export async function addHandymanQuotationLine(
  quotationVersionId: string,
  input: AddHandymanQuotationLineInput,
  actorUserId: string,
): Promise<PublicHandymanQuotationLine> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');
  const { description } = validateInput(input);

  return withTransaction(async (tx) => {
    // 1) Lineage authority from the version → quotation root.
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

    // 2) DRAFT-only gate (PART 03 lifecycle will flip statuses later).
    if (version.status !== 'DRAFT') {
      throw handymanQuotationVersionNotDraftError();
    }

    // 3) Realm authority over the server-derived client scope.
    if (
      !(await contextAccessService.canAccessClient(
        actorUserId,
        quotation.clientId,
      ))
    ) {
      throw buildingAccessDeniedError();
    }

    // 4) Client-scoped master checks (no cross-client master references).
    if (
      !(await handymanQuotationLineRepository.uomBelongsToClient(
        tx,
        input.uomId,
        quotation.clientId,
      ))
    ) {
      throw handymanQuotationLineInvalidError(
        'uomId must reference a units_of_measure master of this client.',
      );
    }
    if (
      input.sourceItemId !== undefined &&
      !(await handymanQuotationLineRepository.itemBelongsToClient(
        tx,
        input.sourceItemId,
        quotation.clientId,
      ))
    ) {
      throw handymanQuotationLineInvalidError(
        'sourceItemId must reference an inventory item of this client.',
      );
    }

    // 5) One currency per quotation version (first line sets it).
    const existingCurrency =
      await handymanQuotationLineRepository.findVersionCurrency(
        tx,
        version.id,
      );
    if (existingCurrency && existingCurrency !== input.currency) {
      throw handymanQuotationCurrencyMismatchError();
    }

    // 6) Governed reference-price snapshot for MATERIAL provenance:
    //    looked up against the request's authoritative building scope;
    //    fail-closed NULL whenever no authority resolves. The looked-up
    //    value is copied NOW and can never change with the source later.
    let referenceUnitAmount: number | null = null;
    if (input.lineType === 'MATERIAL' && input.sourceItemId !== undefined) {
      const request = await handymanServiceRequestRepository.findById(
        tx,
        quotation.handymanRequestId,
      );
      const resolved = await priceCatalogLookupService
        .lookupPriceCatalogEntry(
          {
            sourceMode: 'MATERIAL',
            itemId: input.sourceItemId,
            uomId: input.uomId,
            buildingId: request!.buildingId,
            currency: input.currency,
            asOf: new Date().toISOString(),
          },
          actorUserId,
        );
      if (
        resolved.resolution === 'MATCHED' &&
        resolved.entry &&
        typeof resolved.entry.unitPrice === 'number' &&
        resolved.entry.unitPrice >= 0
      ) {
        referenceUnitAmount = resolved.entry.unitPrice;
      }
    }

    // 7) Immutable insert (line_total computed by the DB) + audit journal.
    const line = await handymanQuotationLineRepository.insertLine(tx, {
      quotationVersionId: version.id,
      lineType: input.lineType,
      description,
      quantity: input.quantity,
      uomId: input.uomId,
      referenceUnitAmount,
      finalQuotedUnitAmount: input.finalQuotedUnitAmount,
      currency: input.currency,
      sourceItemId: input.sourceItemId ?? null,
      createdByUserId: actorUserId,
    });
    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        eventType: 'HANDYMAN_QUOTATION_LINE_ADDED',
        entityType: 'HANDYMAN_QUOTATION_VERSION',
        entityId: version.id,
        actorUserId,
        summary: `Handyman quotation ${line.lineType} line added (version ${version.versionNumber}).`,
        metadata: {
          quotationId: quotation.id,
          quotationVersionId: version.id,
          quotationLineId: line.id,
          lineType: line.lineType,
          handymanRequestId: quotation.handymanRequestId,
        },
      },
      tx,
    );
    return toPublicLine(line);
  });
}

/** Exact bounded read: lines of one version (immutable order). */
export async function listHandymanQuotationVersionLines(
  quotationVersionId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationLine[]> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');
  const version = await handymanQuotationRepository.findVersionById(
    undefined,
    quotationVersionId,
  );
  if (!version) throw handymanQuotationVersionNotFoundError();
  const quotation = await handymanQuotationRepository.findQuotationById(
    undefined,
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
  const lines = await handymanQuotationLineRepository.listLines(
    undefined,
    version.id,
  );
  return lines.map(toPublicLine);
}

/** Bounded derived totals (F4/F5: derived, never persisted). */
export async function getHandymanQuotationVersionTotals(
  quotationVersionId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationTotals> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');
  const version = await handymanQuotationRepository.findVersionById(
    undefined,
    quotationVersionId,
  );
  if (!version) throw handymanQuotationVersionNotFoundError();
  const quotation = await handymanQuotationRepository.findQuotationById(
    undefined,
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
  const sums = await handymanQuotationLineRepository.sumLines(
    undefined,
    version.id,
  );
  const currency = await handymanQuotationLineRepository
    .findVersionCurrency(undefined, version.id);
  return {
    laborSubtotal: sums.labor,
    materialSubtotal: sums.material,
    total: sums.labor + sums.material,
    currency: currency as PublicHandymanQuotationTotals['currency'],
    lineCount: sums.count,
  };
}
