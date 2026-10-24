import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import {
  handymanRequestInspectionRepository,
  handymanServiceRequestRepository,
} from '../handyman-requests';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  getHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../handyman-quotations';
import type {
  PublicHandymanQuotationBundle,
  PublicHandymanQuotationVersion,
} from '../handyman-quotations';
import { serviceCatalogRepository } from '../service-catalog';
import {
  handymanParameterizedCatalogRepository,
} from './handyman-parameterized-catalog.repository';
import {
  handymanServiceQuoteResolutionInvalidError,
} from './handyman-parameterized-catalog.errors';
import {
  resolveHandymanRequestItemPrice,
  type HandymanPriceResolutionDraft,
} from './handyman-parameterized-catalog-pricing.service';
import type {
  HandymanServiceQuoteOutcome,
  HandymanServiceRequestItemRecord,
  PublicHandymanServiceQuoteResolution,
} from './handyman-parameterized-catalog.types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — the INITIAL QUOTATION and the
 * POST-INSPECTION REVISION.
 *
 * This module composes the EXISTING quotation lifecycle; it never
 * reimplements it:
 *
 *   - the quotation ROOT and version 1 come from `createHandymanQuotation`;
 *   - every commercial line comes from `addHandymanQuotationLine`
 *     (immutable snapshot, DB-calculated line total, one currency per
 *     version);
 *   - a revision comes from `createHandymanQuotationRevision`;
 *   - issuing comes from `issueHandymanQuotationVersion`;
 *   - the customer approval stays the EXISTING
 *     `decideHandymanQuotation` decision surface.
 *
 * The ONLY thing this module adds is the governed SELECTION of what goes
 * into a line: the price rule, the price fact, the quantity, the effective
 * date and the resulting immutable snapshot.
 *
 * Two hard rules:
 *  1. NO FICTIONAL PRICE. When any item cannot be priced from the governed
 *     facts, NO quotation is created and NO line is written. The outcome is
 *     INSPECTION_REQUIRED or MANUAL_REVIEW with the reason recorded.
 *  2. NO PARALLEL LIFECYCLE. Approval, issuing, expiry, supersede and the
 *     execution scope stay exactly where they are.
 */

export type HandymanCatalogQuotationPrepareResult = {
  status: HandymanCatalogQuotationStatus;
  /** The effective date the price facts were resolved against. */
  effectiveDate: string;
  resolutions: PublicHandymanServiceQuoteResolution[];
  /** Present only when the status is READY. */
  quotation: PublicHandymanQuotationBundle | null;
  /** Present only when the status is READY. */
  quotationVersion: PublicHandymanQuotationVersion | null;
};

/** The overall status of a preparation attempt. */
export type HandymanCatalogQuotationStatus =
  | 'READY'
  | 'INSPECTION_REQUIRED'
  | 'MANUAL_REVIEW';

function overallStatus(
  drafts: HandymanPriceResolutionDraft[],
): HandymanCatalogQuotationStatus {
  if (drafts.some((d) => d.outcome === 'INSPECTION_REQUIRED')) {
    return 'INSPECTION_REQUIRED';
  }
  if (drafts.some((d) => d.outcome === 'MANUAL_REVIEW')) {
    return 'MANUAL_REVIEW';
  }
  return 'READY';
}

function toPublicResolution(
  record: Awaited<
    ReturnType<
      typeof handymanParameterizedCatalogRepository.insertResolution
    >
  >,
): PublicHandymanServiceQuoteResolution {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
  };
}

function parseEffectiveDate(raw: string | undefined): Date {
  if (raw === undefined || raw === null || raw === '') return new Date();
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw AppError.validation('Quotation preparation validation failed.', [
      {
        field: 'effectiveDate',
        message: 'effectiveDate must be a valid ISO-8601 instant.',
      },
    ]);
  }
  return parsed;
}

/** A bounded, human-readable description of one quoted item. */
function buildLineDescription(
  item: HandymanServiceRequestItemRecord,
  serviceCode: string,
  serviceName: string,
  variantCode: string | null = null,
): string {
  const attributes = Object.entries(item.attributeValues)
    .map(([code, value]) => {
      // CR-HM-SERVICE-CATALOG-01 PART 03 — the description records WHICH
      // values were inherited from the variant, so the snapshot explains
      // itself without reading the catalogue again.
      const inherited = Object.prototype.hasOwnProperty.call(
        item.inheritedAttributeValues ?? {},
        code,
      )
        ? '*'
        : '';
      return `${code}${inherited}=${value}`;
    })
    .join(', ');
  const parts = [
    `${serviceCode} ${serviceName}`,
    variantCode ? `variant ${variantCode}` : '',
    attributes.length > 0 ? `[${attributes}]` : '',
    `qty ${item.quantity}`,
    `access ${item.accessCondition}`,
  ].filter((part) => part.length > 0);
  const description = parts.join(' · ');
  return description.length > 1000 ? description.slice(0, 1000) : description;
}

async function resolveItems(
  clientId: string,
  buildingId: string,
  items: HandymanServiceRequestItemRecord[],
  effectiveAt: Date,
): Promise<HandymanPriceResolutionDraft[]> {
  const drafts: HandymanPriceResolutionDraft[] = [];
  for (const item of items) {
    drafts.push(
      await resolveHandymanRequestItemPrice(item, {
        clientId,
        buildingId,
        effectiveAt,
      }),
    );
  }
  return drafts;
}

/** Persist the resolutions as append-only snapshots. */
async function persistResolutions(
  clientId: string,
  handymanRequestId: string,
  drafts: HandymanPriceResolutionDraft[],
  actorUserId: string,
  binding?: {
    quotationId: string;
    quotationVersionId: string;
    lineIdByItemId: Record<string, string>;
  },
): Promise<PublicHandymanServiceQuoteResolution[]> {
  const persisted: PublicHandymanServiceQuoteResolution[] = [];
  for (const draft of drafts) {
    const record =
      await handymanParameterizedCatalogRepository.insertResolution(
        undefined,
        {
          clientId,
          handymanRequestId,
          requestItemId: draft.requestItemId,
          outcome: draft.outcome,
          reasonCode: draft.reasonCode,
          reasonDetail: draft.reasonDetail,
          priceRuleId: draft.priceRuleId,
          priceCatalogEntryId: draft.priceCatalogEntryId,
          currency: draft.currency,
          unitAmount: draft.unitAmount,
          quantity: draft.quantity,
          priceBasis: draft.priceBasis,
          effectiveFrom: draft.effectiveFrom,
          effectiveTo: draft.effectiveTo,
          computedTotal: draft.computedTotal,
          quotationId: binding?.quotationId ?? null,
          quotationVersionId: binding?.quotationVersionId ?? null,
          quotationLineId:
            draft.requestItemId !== null && binding
              ? binding.lineIdByItemId[draft.requestItemId] ?? null
              : null,
          resolvedByUserId: actorUserId,
        },
      );
    persisted.push(toPublicResolution(record));
  }
  return persisted;
}

/**
 * Prepare the INITIAL quotation of a request from its mixed items.
 *
 * The caller may pass an explicit `effectiveDate`; the price facts are then
 * resolved as of that instant, which is what makes the price snapshot
 * reproducible and auditable.
 */
export async function prepareHandymanCatalogQuotation(
  handymanRequestId: string,
  options: { effectiveDate?: string },
  actorUserId: string,
): Promise<HandymanCatalogQuotationPrepareResult> {
  if (!isValidUuid(handymanRequestId)) {
    throw AppError.validation('Quotation preparation validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) {
    throw handymanServiceQuoteResolutionInvalidError(
      'Handyman service request not found.',
    );
  }
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: request.clientId,
    buildingId: request.buildingId,
  });

  const effectiveAt = parseEffectiveDate(options.effectiveDate);
  const items = await handymanParameterizedCatalogRepository.listRequestItems(
    undefined,
    request.clientId,
    request.id,
    'ACTIVE',
  );
  if (items.length === 0) {
    throw handymanServiceQuoteResolutionInvalidError(
      'The request has no ACTIVE catalog items to quote.',
    );
  }

  const drafts = await resolveItems(
    request.clientId,
    request.buildingId,
    items,
    effectiveAt,
  );
  const status = overallStatus(drafts);

  if (status !== 'READY') {
    const resolutions = await persistResolutions(
      request.clientId,
      request.id,
      drafts,
      actorUserId,
    );
    return {
      status,
      effectiveDate: effectiveAt.toISOString(),
      resolutions,
      quotation: null,
      quotationVersion: null,
    };
  }

  // One currency per quotation version — the existing engine's rule. The
  // check happens BEFORE the quotation is created so a currency conflict can
  // never leave a half-quoted DRAFT behind.
  const currencies = new Set(drafts.map((d) => d.currency));
  if (currencies.size > 1) {
    await persistResolutions(
      request.clientId,
      request.id,
      drafts,
      actorUserId,
    );
    throw handymanServiceQuoteResolutionInvalidError(
      `The request items resolve to ${currencies.size} different currencies; one quotation version carries exactly one currency.`,
    );
  }

  // The EXISTING quotation engine creates the root and version 1 (DRAFT).
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id },
    actorUserId,
  );
  const version = bundle.versions[0];

  const lineIdByItemId: Record<string, string> = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const draft = drafts[index];
    const service = await serviceCatalogRepository.findById(
      undefined,
      item.serviceCatalogId,
    );
    const variant =
      item.serviceVariantId !== null
        ? await handymanParameterizedCatalogRepository.findVariantById(
            undefined,
            item.serviceVariantId,
          )
        : null;
    const line = await addHandymanQuotationLine(
      version.id,
      {
        lineType: 'LABOR',
        description: buildLineDescription(
          item,
          service?.code ?? 'SERVICE',
          service?.name ?? 'Handyman service',
          variant?.code ?? null,
        ),
        quantity: item.quantity,
        uomId: draft.uomId as string,
        currency: draft.currency as never,
        finalQuotedUnitAmount: draft.unitAmount as number,
      },
      actorUserId,
    );
    if (item.id) lineIdByItemId[item.id] = line.id;
  }

  const resolutions = await persistResolutions(
    request.clientId,
    request.id,
    drafts,
    actorUserId,
    {
      quotationId: bundle.quotation.id,
      quotationVersionId: version.id,
      lineIdByItemId,
    },
  );

  return {
    status: 'READY',
    effectiveDate: effectiveAt.toISOString(),
    resolutions,
    quotation: bundle,
    quotationVersion: version,
  };
}

/**
 * The POST-INSPECTION REVISION lane.
 *
 * When an inspection changed the scope or the price, the correction is a
 * NEW immutable quotation version (the EXISTING revision authority) — never
 * an edit of the issued version, and never a bypass of the customer
 * approval. Issuing and approving stay with the existing lifecycle
 * operations.
 */
export async function reviseHandymanCatalogQuotation(
  handymanRequestId: string,
  options: {
    effectiveDate?: string;
    validUntil?: string;
    issue?: boolean;
  },
  actorUserId: string,
): Promise<HandymanCatalogQuotationPrepareResult> {
  if (!isValidUuid(handymanRequestId)) {
    throw AppError.validation('Quotation revision validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) {
    throw handymanServiceQuoteResolutionInvalidError(
      'Handyman service request not found.',
    );
  }
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: request.clientId,
    buildingId: request.buildingId,
  });

  // The revision lane exists BECAUSE an inspection happened: the existing
  // inspection authority must have a record for this request.
  const inspection = await handymanRequestInspectionRepository.findByRequest(
    undefined,
    request.id,
  );
  if (!inspection) {
    throw handymanServiceQuoteResolutionInvalidError(
      'A quotation revision requires a recorded inspection for this request.',
    );
  }

  const effectiveAt = parseEffectiveDate(options.effectiveDate);
  const items = await handymanParameterizedCatalogRepository.listRequestItems(
    undefined,
    request.clientId,
    request.id,
    'ACTIVE',
  );
  if (items.length === 0) {
    throw handymanServiceQuoteResolutionInvalidError(
      'The request has no ACTIVE catalog items to revise.',
    );
  }

  const drafts = await resolveItems(
    request.clientId,
    request.buildingId,
    items,
    effectiveAt,
  );
  const status = overallStatus(drafts);

  if (status !== 'READY') {
    const resolutions = await persistResolutions(
      request.clientId,
      request.id,
      drafts,
      actorUserId,
    );
    return {
      status,
      effectiveDate: effectiveAt.toISOString(),
      resolutions,
      quotation: null,
      quotationVersion: null,
    };
  }

  const currencies = new Set(drafts.map((d) => d.currency));
  if (currencies.size > 1) {
    await persistResolutions(
      request.clientId,
      request.id,
      drafts,
      actorUserId,
    );
    throw handymanServiceQuoteResolutionInvalidError(
      `The request items resolve to ${currencies.size} different currencies; one quotation version carries exactly one currency.`,
    );
  }

  // The EXISTING quotation thread and the EXISTING revision authority.
  const existing = await getHandymanQuotation(request.id, actorUserId);
  const version = await createHandymanQuotationRevision(
    existing.quotation.id,
    actorUserId,
  );

  const lineIdByItemId: Record<string, string> = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const draft = drafts[index];
    const service = await serviceCatalogRepository.findById(
      undefined,
      item.serviceCatalogId,
    );
    const variant =
      item.serviceVariantId !== null
        ? await handymanParameterizedCatalogRepository.findVariantById(
            undefined,
            item.serviceVariantId,
          )
        : null;
    const line = await addHandymanQuotationLine(
      version.id,
      {
        lineType: 'LABOR',
        description: buildLineDescription(
          item,
          service?.code ?? 'SERVICE',
          service?.name ?? 'Handyman service',
          variant?.code ?? null,
        ),
        quantity: item.quantity,
        uomId: draft.uomId as string,
        currency: draft.currency as never,
        finalQuotedUnitAmount: draft.unitAmount as number,
      },
      actorUserId,
    );
    if (item.id) lineIdByItemId[item.id] = line.id;
  }

  const resolutions = await persistResolutions(
    request.clientId,
    request.id,
    drafts,
    actorUserId,
    {
      quotationId: existing.quotation.id,
      quotationVersionId: version.id,
      lineIdByItemId,
    },
  );

  // Issuing stays with the EXISTING lifecycle operation. When the caller
  // asks for it, the SAME existing service issues the new revision — the
  // customer approval that follows is the EXISTING decision surface.
  let issuedVersion = version;
  if (options.issue === true) {
    if (!options.validUntil) {
      throw handymanServiceQuoteResolutionInvalidError(
        'validUntil is required when a revision is issued.',
      );
    }
    issuedVersion = await issueHandymanQuotationVersion(
      version.id,
      { validUntil: options.validUntil },
      actorUserId,
    );
  }

  return {
    status: 'READY',
    effectiveDate: effectiveAt.toISOString(),
    resolutions,
    quotation: existing,
    quotationVersion: issuedVersion,
  };
}

/**
 * The recorded resolutions of a request — the price snapshot history.
 */
export async function listHandymanServiceQuoteResolutions(
  handymanRequestId: string,
  actorUserId: string,
): Promise<PublicHandymanServiceQuoteResolution[]> {
  if (!isValidUuid(handymanRequestId)) {
    throw AppError.validation('Quotation resolution validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) {
    throw handymanServiceQuoteResolutionInvalidError(
      'Handyman service request not found.',
    );
  }
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: request.clientId,
    buildingId: request.buildingId,
  });
  const records = await handymanParameterizedCatalogRepository.listResolutions(
    undefined,
    request.clientId,
    request.id,
  );
  return records.map((record) => ({
    ...record,
    createdAt: record.createdAt.toISOString(),
  }));
}
