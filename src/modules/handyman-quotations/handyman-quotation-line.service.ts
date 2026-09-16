import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { inventoryItemNotFoundError, inventoryItemRepository } from '../inventory-items';
import { recordOperationalEvent } from '../operational-events';
import {
  priceCatalogLookupService,
} from '../price-catalog-entries';
import type { PriceCatalogLookupResult } from '../price-catalog-entries';
import {
  serviceCatalogNotActiveError,
  serviceCatalogRepository,
} from '../service-catalog';
import { isHandymanServiceCategory } from '../handyman-providers';
import {
  handymanRequestServiceClientMismatchError,
  handymanRequestServiceNotHandymanError,
  handymanServiceSelectionRepository,
} from '../handyman-request-governance';
import {
  handymanQuotationLineInvalidError,
  handymanQuotationLineNotFoundError,
  handymanQuotationLineServiceNotSelectedError,
  handymanQuotationPriceDeviationNoteRequiredError,
  handymanQuotationPriceUnresolvedError,
  handymanQuotationRevisionNotFoundError,
  handymanQuotationRevisionStateInvalidError,
  handymanQuotationStateInvalidError,
} from './handyman-quotation.errors';
import { handymanQuotationLineRepository } from './handyman-quotation-line.repository';
import { handymanQuotationRevisionRepository } from './handyman-quotation-revision.repository';
import {
  loadQuotationOrThrow,
  toPublicHandymanQuotationLine,
} from './handyman-quotation.service';
import type {
  AddHandymanQuotationLineInput,
  HandymanQuotationLineRecord,
  HandymanQuotationRecord,
  HandymanQuotationReferenceResolution,
  PublicHandymanQuotationLine,
  UpdateHandymanQuotationLineInput,
} from './handyman-quotation.types';
import { HANDYMAN_QUOTATION_SENDABLE_STATUSES } from './handyman-quotation.types';

/**
 * CR-HM-BE-03 RUN 2 — Quotation line authority.
 *
 * Lines may only be authored on a DRAFT revision of a DRAFT/WITHDRAWN
 * quotation (SUBMITTED facts are immutable). The discriminated union:
 *
 * - LABOR: governed `service_catalog` identity ONLY — the service must hold
 *   an ACTIVE selection on this request's `handyman_request_services`
 *   (CR-HM-BE-03 governance correction #1) and stay a same-client ACTIVE
 *   HANDYMAN catalog entry. No free-text parsing; no quantity is ever
 *   invented (SERVICE pricing has no governed quantity). Reference price
 *   resolved through the UNCHANGED CR-BE-PRICE-01/SVC-01 lookup in SERVICE
 *   mode.
 * - MATERIAL: inventory item + UOM (same-client, ACTIVE item) + positive
 *   quantity; reference price resolved in MATERIAL mode (exact UOM — no
 *   conversion exists or is inferred).
 * - OTHER: governed description + manual price; no reference concept.
 *
 * Pricing governance: MATCHED ⇒ the reference MAY be used and any authored
 * deviation REQUIRES a deviation note; NO_REFERENCE_PRICE ⇒ manual price +
 * note mandatory; AMBIGUOUS / UOM_INCOMPATIBLE / CURRENCY_INCOMPATIBLE ⇒
 * fail closed (HANDYMAN_QUOTATION_PRICE_UNRESOLVED). No FX, no discounts,
 * no BM fee, no Commercial Agreement, no settlement. Totals are derived
 * from stored lines (GENERATED line_total + SQL SUM), never caller input.
 */

type LineProvenance = {
  referenceResolution: HandymanQuotationReferenceResolution | null;
  referencePriceEntryId: string | null;
  referenceScopeTier: string | null;
  referenceUnitPrice: string | null;
  referenceAsOf: Date | null;
  deviationNote: string | null;
};

function parseUnitPrice(value: unknown, field = 'unitPrice'): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1e16) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a positive number.` },
    ]);
  }
  if (Number(numeric.toFixed(2)) !== numeric) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} allows at most 2 decimal places.` },
    ]);
  }
  return numeric;
}

function parseQuantity(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1e15) {
    throw handymanQuotationLineInvalidError(
      'MATERIAL lines require a positive quantity.',
    );
  }
  if (Number(numeric.toFixed(3)) !== numeric) {
    throw handymanQuotationLineInvalidError(
      'quantity allows at most 3 decimal places.',
    );
  }
  return numeric;
}

function parseOptionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw handymanQuotationLineInvalidError(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 1000) {
    throw handymanQuotationLineInvalidError(
      `${field} must be at most 1000 characters.`,
    );
  }
  return trimmed;
}

/**
 * Reference-price resolution through the UNCHANGED governed lookup.
 * Returns storable provenance or fails closed; enforces the deviation-note
 * rule against the authored price.
 */
async function resolveLinePricing(
  quotation: HandymanQuotationRecord,
  lineType: 'LABOR' | 'MATERIAL' | 'OTHER',
  subject: {
    serviceCatalogId: string | null;
    inventoryItemId: string | null;
    uomId: string | null;
  },
  authoredUnitPrice: number,
  deviationNote: string | null,
  actorUserId: string,
): Promise<LineProvenance> {
  if (lineType === 'OTHER') {
    // Manual price with no reference concept — provenance stays empty.
    return {
      referenceResolution: null,
      referencePriceEntryId: null,
      referenceScopeTier: null,
      referenceUnitPrice: null,
      referenceAsOf: null,
      deviationNote,
    };
  }

  const asOf = new Date().toISOString();
  const lookupInput =
    lineType === 'LABOR'
      ? {
          buildingId: quotation.buildingId,
          vendorId: null,
          currency: quotation.currency,
          asOf,
          sourceMode: 'SERVICE' as const,
          serviceId: subject.serviceCatalogId as string,
        }
      : {
          buildingId: quotation.buildingId,
          vendorId: null,
          currency: quotation.currency,
          asOf,
          sourceMode: 'MATERIAL' as const,
          itemId: subject.inventoryItemId as string,
          uomId: subject.uomId as string,
        };

  const result: PriceCatalogLookupResult =
    await priceCatalogLookupService.lookupPriceCatalogEntry(
      lookupInput,
      actorUserId,
    );
  const referenceAsOf = new Date(result.asOf);

  switch (result.resolution) {
    case 'MATCHED': {
      const entry = result.entry;
      if (!entry) {
        throw handymanQuotationPriceUnresolvedError(
          'The matched reference price entry is missing; the line fails closed.',
        );
      }
      const referenceUnitPrice = Number(entry.unitPrice);
      const deviated =
        Math.round(authoredUnitPrice * 100) !== Math.round(referenceUnitPrice * 100);
      if (deviated && !deviationNote) {
        throw handymanQuotationPriceDeviationNoteRequiredError(
          'The authored unit price deviates from the matched reference price; a deviation note is mandatory.',
        );
      }
      return {
        referenceResolution: 'MATCHED',
        referencePriceEntryId: entry.id,
        referenceScopeTier: result.scopeTier,
        referenceUnitPrice: referenceUnitPrice.toFixed(2),
        referenceAsOf,
        deviationNote,
      };
    }
    case 'NO_REFERENCE_PRICE': {
      if (!deviationNote) {
        throw handymanQuotationPriceDeviationNoteRequiredError(
          'No reference price exists for this subject; a manual price requires a deviation note.',
        );
      }
      return {
        referenceResolution: 'NO_REFERENCE_PRICE',
        referencePriceEntryId: null,
        referenceScopeTier: null,
        referenceUnitPrice: null,
        referenceAsOf,
        deviationNote,
      };
    }
    default:
      // AMBIGUOUS / UOM_INCOMPATIBLE / CURRENCY_INCOMPATIBLE — fail closed.
      throw handymanQuotationPriceUnresolvedError(
        `The reference price lookup failed closed with resolution ${result.resolution}.`,
      );
  }
}

type DraftContext = {
  quotation: HandymanQuotationRecord;
  revisionId: string;
};

/** Shared guarded preamble: DRAFT revision under a DRAFT/WITHDRAWN envelope. */
async function loadDraftLineContext(
  revisionId: string,
  actorUserId: string,
  tx: Pick<PoolClient, 'query'>,
): Promise<DraftContext> {
  if (!isValidUuid(revisionId)) throw handymanQuotationRevisionNotFoundError();
  const revision = await handymanQuotationRevisionRepository.lockById(
    revisionId,
    tx,
  );
  if (!revision) throw handymanQuotationRevisionNotFoundError();
  const quotation = await loadQuotationOrThrow(revision.quotationId, actorUserId, tx, {
    forUpdate: true,
  });
  if (revision.status !== 'DRAFT') {
    throw handymanQuotationRevisionStateInvalidError(
      'Lines can only be authored on a DRAFT revision; SUBMITTED facts are immutable.',
    );
  }
  if (
    !(HANDYMAN_QUOTATION_SENDABLE_STATUSES as readonly string[]).includes(
      quotation.status,
    )
  ) {
    throw handymanQuotationStateInvalidError(
      'Lines can only be authored while the quotation is DRAFT or WITHDRAWN.',
    );
  }
  return { quotation, revisionId: revision.id };
}

async function resolveLaborSubject(
  quotation: HandymanQuotationRecord,
  serviceCatalogId: unknown,
  tx: Pick<PoolClient, 'query'>,
): Promise<{ id: string; code: string; name: string }> {
  if (typeof serviceCatalogId !== 'string' || !isValidUuid(serviceCatalogId)) {
    throw handymanQuotationLineInvalidError(
      'LABOR lines require a governed serviceCatalogId.',
    );
  }
  // Cross-aggregate authority: an ACTIVE governed selection on this request.
  const selection =
    await handymanServiceSelectionRepository.findActiveByRequestAndService(
      quotation.requestId,
      serviceCatalogId,
      tx,
    );
  if (!selection) throw handymanQuotationLineServiceNotSelectedError();
  // Catalog re-validation (existence, ACTIVE, same client, HANDYMAN) — the
  // same governed checks the selection itself passed, re-run at authoring
  // time so drift (e.g. terminal deactivation) fails closed here too.
  const service = await serviceCatalogRepository.findById(tx, serviceCatalogId);
  if (!service) {
    throw handymanQuotationLineServiceNotSelectedError(
      'The LABOR subject is not a same-client governed service.',
    );
  }
  if (service.status !== 'ACTIVE') throw serviceCatalogNotActiveError();
  if (service.clientId !== quotation.clientId) {
    throw handymanRequestServiceClientMismatchError();
  }
  if (!isHandymanServiceCategory(service.category)) {
    throw handymanRequestServiceNotHandymanError();
  }
  return { id: service.id, code: service.code, name: service.name };
}

async function resolveMaterialSubject(
  quotation: HandymanQuotationRecord,
  inventoryItemId: unknown,
  uomId: unknown,
  tx: Pick<PoolClient, 'query'>,
): Promise<{
  itemId: string;
  itemCode: string;
  itemName: string;
  uomIdValue: string;
  uomCode: string;
}> {
  if (typeof inventoryItemId !== 'string' || !isValidUuid(inventoryItemId)) {
    throw handymanQuotationLineInvalidError(
      'MATERIAL lines require an inventoryItemId.',
    );
  }
  if (typeof uomId !== 'string' || !isValidUuid(uomId)) {
    throw handymanQuotationLineInvalidError('MATERIAL lines require a uomId.');
  }
  const item = await inventoryItemRepository.findById(inventoryItemId);
  if (!item || item.clientId !== quotation.clientId) {
    throw inventoryItemNotFoundError();
  }
  if (item.status !== 'ACTIVE') {
    throw handymanQuotationLineInvalidError(
      'The inventory item is not ACTIVE; MATERIAL lines require an ACTIVE item.',
    );
  }
  const uom = await handymanQuotationLineRepository.findUnitOfMeasure(
    uomId,
    quotation.clientId,
    tx,
  );
  if (!uom) {
    throw handymanQuotationLineInvalidError(
      'uomId must reference a unit of measure of the same client.',
    );
  }
  return {
    itemId: item.id,
    itemCode: item.code,
    itemName: item.name,
    uomIdValue: uom.id,
    uomCode: uom.code,
  };
}

export async function addHandymanQuotationLine(
  input: AddHandymanQuotationLineInput,
  actorUserId: string,
): Promise<PublicHandymanQuotationLine> {
  const lineType = input.lineType;
  if (lineType !== 'LABOR' && lineType !== 'MATERIAL' && lineType !== 'OTHER') {
    throw handymanQuotationLineInvalidError(
      'lineType must be one of LABOR, MATERIAL, OTHER.',
    );
  }
  const unitPrice = parseUnitPrice(input.unitPrice);
  const deviationNote = parseOptionalText(input.deviationNote, 'deviationNote');
  const description = parseOptionalText(input.description, 'description');

  return withTransaction(async (tx) => {
    const context = await loadDraftLineContext(
      input.revisionId,
      actorUserId,
      tx,
    );
    const { quotation } = context;

    let lineInput: {
      lineType: string;
      serviceCatalogId: string | null;
      inventoryItemId: string | null;
      uomId: string | null;
      quantity: string | null;
      subjectCode: string | null;
      subjectName: string | null;
      uomCode: string | null;
      description: string | null;
    };

    if (lineType === 'LABOR') {
      if (input.quantity !== undefined && input.quantity !== null) {
        throw handymanQuotationLineInvalidError(
          'LABOR lines never carry a quantity; SERVICE pricing has no governed quantity.',
        );
      }
      const service = await resolveLaborSubject(
        quotation,
        input.serviceCatalogId,
        tx,
      );
      lineInput = {
        lineType: 'LABOR',
        serviceCatalogId: service.id,
        inventoryItemId: null,
        uomId: null,
        quantity: null,
        subjectCode: service.code,
        subjectName: service.name,
        uomCode: null,
        description,
      };
    } else if (lineType === 'MATERIAL') {
      if (input.quantity === undefined || input.quantity === null) {
        throw handymanQuotationLineInvalidError(
          'MATERIAL lines require a positive quantity.',
        );
      }
      const quantity = parseQuantity(input.quantity);
      const subject = await resolveMaterialSubject(
        quotation,
        input.inventoryItemId,
        input.uomId,
        tx,
      );
      lineInput = {
        lineType: 'MATERIAL',
        serviceCatalogId: null,
        inventoryItemId: subject.itemId,
        uomId: subject.uomIdValue,
        quantity: quantity.toFixed(3),
        subjectCode: subject.itemCode,
        subjectName: subject.itemName,
        uomCode: subject.uomCode,
        description,
      };
    } else {
      if (input.quantity !== undefined && input.quantity !== null) {
        throw handymanQuotationLineInvalidError(
          'OTHER lines never carry a quantity.',
        );
      }
      if (
        input.serviceCatalogId !== undefined && input.serviceCatalogId !== null
      ) {
        throw handymanQuotationLineInvalidError(
          'OTHER lines must not reference a service catalog entry.',
        );
      }
      if (input.inventoryItemId !== undefined && input.inventoryItemId !== null) {
        throw handymanQuotationLineInvalidError(
          'OTHER lines must not reference an inventory item.',
        );
      }
      if (input.uomId !== undefined && input.uomId !== null) {
        throw handymanQuotationLineInvalidError(
          'OTHER lines must not reference a unit of measure.',
        );
      }
      if (!description) {
        throw handymanQuotationLineInvalidError(
          'OTHER lines require a governed description.',
        );
      }
      lineInput = {
        lineType: 'OTHER',
        serviceCatalogId: null,
        inventoryItemId: null,
        uomId: null,
        quantity: null,
        subjectCode: null,
        subjectName: null,
        uomCode: null,
        description,
      };
    }

    const provenance = await resolveLinePricing(
      quotation,
      lineType,
      {
        serviceCatalogId: lineInput.serviceCatalogId,
        inventoryItemId: lineInput.inventoryItemId,
        uomId: lineInput.uomId,
      },
      unitPrice,
      deviationNote,
      actorUserId,
    );

    // Sequential under the locked revision row.
    const lineNumber =
      (await handymanQuotationLineRepository.findMaxLineNumber(
        context.revisionId,
        tx,
      )) + 1;

    const created = await handymanQuotationLineRepository.create(
      {
        quotationRevisionId: context.revisionId,
        quotationId: quotation.id,
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        lineNumber,
        ...lineInput,
        unitPrice: unitPrice.toFixed(2),
        referenceResolution: provenance.referenceResolution,
        referencePriceEntryId: provenance.referencePriceEntryId,
        referenceScopeTier: provenance.referenceScopeTier,
        referenceUnitPrice: provenance.referenceUnitPrice,
        referenceAsOf: provenance.referenceAsOf,
        deviationNote: provenance.deviationNote,
        createdByUserId: actorUserId,
      },
      tx,
    );

    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        eventType: 'HANDYMAN_QUOTATION_LINE_ADDED',
        entityType: 'HANDYMAN_QUOTATION_LINE',
        entityId: created.id,
        actorUserId,
        summary: `${lineType} line ${created.lineNumber} added to quotation ${quotation.quotationNumber}.`,
        metadata: {
          quotationId: quotation.id,
          quotationNumber: quotation.quotationNumber,
          revisionId: context.revisionId,
          lineType: created.lineType,
          lineNumber: created.lineNumber,
          referenceResolution: created.referenceResolution,
        },
      },
      tx,
    );

    return toPublicHandymanQuotationLine(created);
  });
}

/** Loads line + locked revision/quotation and enforces draft authoring state. */
async function loadDraftLineOrThrow(
  lineId: string,
  actorUserId: string,
  tx: Pick<PoolClient, 'query'>,
): Promise<{ line: HandymanQuotationLineRecord; quotation: HandymanQuotationRecord }> {
  if (!isValidUuid(lineId)) throw handymanQuotationLineNotFoundError();
  const probe = await handymanQuotationLineRepository.findById(lineId, tx);
  if (!probe) throw handymanQuotationLineNotFoundError();
  const context = await loadDraftLineContext(
    probe.quotationRevisionId,
    actorUserId,
    tx,
  );
  // Re-read after the locks are held (stale-mutation protection).
  const line = await handymanQuotationLineRepository.findById(lineId, tx);
  if (!line) throw handymanQuotationLineNotFoundError();
  return { line, quotation: context.quotation };
}

export async function updateHandymanQuotationLine(
  lineId: string,
  input: UpdateHandymanQuotationLineInput,
  actorUserId: string,
): Promise<PublicHandymanQuotationLine> {
  return withTransaction(async (tx) => {
    const { line, quotation } = await loadDraftLineOrThrow(
      lineId,
      actorUserId,
      tx,
    );

    // Effective commercial facts (subject identity is immutable — remove and
    // re-add under governance instead).
    const unitPrice =
      input.unitPrice !== undefined
        ? parseUnitPrice(input.unitPrice)
        : Number(line.unitPrice);
    const deviationNote =
      input.deviationNote !== undefined
        ? parseOptionalText(input.deviationNote, 'deviationNote')
        : line.deviationNote;

    let quantity: string | null = line.quantity;
    if (input.quantity !== undefined && input.quantity !== null) {
      if (line.lineType !== 'MATERIAL') {
        throw handymanQuotationLineInvalidError(
          'Only MATERIAL lines carry a quantity.',
        );
      }
      quantity = parseQuantity(input.quantity).toFixed(3);
    } else if (input.quantity === null && line.lineType === 'MATERIAL') {
      throw handymanQuotationLineInvalidError(
        'MATERIAL lines require a positive quantity.',
      );
    }

    let description =
      input.description !== undefined
        ? parseOptionalText(input.description, 'description')
        : line.description;
    if (line.lineType === 'OTHER' && !description) {
      throw handymanQuotationLineInvalidError(
        'OTHER lines require a governed description.',
      );
    }

    // Every price-affecting update re-runs the governed reference-price
    // resolution — provenance always reflects the stored facts.
    const provenance = await resolveLinePricing(
      quotation,
      line.lineType,
      {
        serviceCatalogId: line.serviceCatalogId,
        inventoryItemId: line.inventoryItemId,
        uomId: line.uomId,
      },
      unitPrice,
      deviationNote,
      actorUserId,
    );

    const updated = await handymanQuotationLineRepository.updateCommercialFacts(
      line.id,
      {
        unitPrice: unitPrice.toFixed(2),
        quantity,
        description,
        referenceResolution: provenance.referenceResolution,
        referencePriceEntryId: provenance.referencePriceEntryId,
        referenceScopeTier: provenance.referenceScopeTier,
        referenceUnitPrice: provenance.referenceUnitPrice,
        referenceAsOf: provenance.referenceAsOf,
        deviationNote: provenance.deviationNote,
      },
      tx,
    );
    if (!updated) throw handymanQuotationLineNotFoundError();

    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        eventType: 'HANDYMAN_QUOTATION_LINE_UPDATED',
        entityType: 'HANDYMAN_QUOTATION_LINE',
        entityId: updated.id,
        actorUserId,
        summary: `Line ${updated.lineNumber} updated on quotation ${quotation.quotationNumber}.`,
        metadata: {
          quotationId: quotation.id,
          quotationNumber: quotation.quotationNumber,
          revisionId: updated.quotationRevisionId,
          lineType: updated.lineType,
          lineNumber: updated.lineNumber,
          referenceResolution: updated.referenceResolution,
        },
      },
      tx,
    );

    return toPublicHandymanQuotationLine(updated);
  });
}

export async function removeHandymanQuotationLine(
  lineId: string,
  actorUserId: string,
): Promise<{ removed: true; lineId: string }> {
  return withTransaction(async (tx) => {
    const { line, quotation } = await loadDraftLineOrThrow(
      lineId,
      actorUserId,
      tx,
    );
    const removed = await handymanQuotationLineRepository.deleteById(line.id, tx);
    if (!removed) throw handymanQuotationLineNotFoundError();

    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        eventType: 'HANDYMAN_QUOTATION_LINE_REMOVED',
        entityType: 'HANDYMAN_QUOTATION_LINE',
        entityId: line.id,
        actorUserId,
        summary: `Line ${line.lineNumber} removed from quotation ${quotation.quotationNumber}.`,
        metadata: {
          quotationId: quotation.id,
          quotationNumber: quotation.quotationNumber,
          revisionId: line.quotationRevisionId,
          lineType: line.lineType,
          lineNumber: line.lineNumber,
        },
      },
      tx,
    );

    return { removed: true as const, lineId: line.id };
  });
}

export async function listHandymanQuotationLines(
  revisionId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationLine[]> {
  return withTransaction(async (tx) => {
    if (!isValidUuid(revisionId)) throw handymanQuotationRevisionNotFoundError();
    const revision = await handymanQuotationRevisionRepository.findById(
      revisionId,
      tx,
    );
    if (!revision) throw handymanQuotationRevisionNotFoundError();
    await loadQuotationOrThrow(revision.quotationId, actorUserId, tx);
    const lines = await handymanQuotationLineRepository.listByRevision(
      revision.id,
      tx,
    );
    return lines.map(toPublicHandymanQuotationLine);
  });
}

export const handymanQuotationLineService = {
  addHandymanQuotationLine,
  updateHandymanQuotationLine,
  removeHandymanQuotationLine,
  listHandymanQuotationLines,
};
