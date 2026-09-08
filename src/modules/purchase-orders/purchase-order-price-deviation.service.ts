import { contextAccessService } from '../context-access';
import {
  priceCatalogLookupService,
  type PriceCatalogCurrency,
  type PriceCatalogScopeTier,
} from '../price-catalog-entries';
import type { PurchaseOrderLineRecord } from './purchase-order-line.types';
import { purchaseOrderLineRepository } from './purchase-order-line.repository';
import { purchaseOrderNotFoundError } from './purchase-order.errors';
import { purchaseOrderRepository } from './purchase-order.repository';
import type { PurchaseOrderRecord } from './purchase-order.types';
import type {
  PurchaseOrderLinePriceReference,
  PurchaseOrderPriceDeviation,
  PurchaseOrderPriceDeviationLine,
  PurchaseOrderPriceDeviationResolution,
} from './purchase-order-price-deviation.types';

/**
 * CR-BE-PRICE-01 PART 06 — PO advisory reference-price deviation read model
 * (governance §13.3/§13.4, API §20).
 *
 * NON-GATING POSTURE (hard rules, all structural):
 *   - Pure read: no transaction, no locks, no writes, no events of its own.
 *     PO facts are echoed, never recomputed into storage; a catalog
 *     replace/correct afterwards therefore cannot "rewrite history" — this
 *     projection simply resolves the CURRENT authority at request time.
 *   - Never consulted by creation/approval/acknowledgement/issuance paths;
 *     never a commitment origin; never settlement behavior.
 *   - Reference resolution runs through the frozen PART 02 §8 seam: fixed
 *     Vendor+Building → Vendor → Building → Client-wide precedence with the
 *     PO's own Vendor as context, exact UOM/currency match, half-open
 *     windows. No FX, no UOM conversion, no inferred prices.
 *   - AMBIGUOUS stays fail-closed: the typed outcome is reported with all
 *     price facts null (nothing is fabricated; the resolver already wrote
 *     its auto-committed PRICE_CATALOG_AMBIGUITY_REJECTED incident). This
 *     read model persists nothing, so — unlike the PART 04 run-creation
 *     path — there is no evidence row to protect by rejecting the request.
 *   - Permission boundary: the route conjunctively requires
 *     `purchase_order.read` + `price_catalog.read` (§20). Price-authority
 *     fields therefore never reach a caller lacking `price_catalog.read`,
 *     and PO/line payloads elsewhere carry no reference keys at all.
 */

/** 2dp money rounding, mirroring the PART 04 `roundMoney` convention. */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

const TIER_PROVENANCE: Record<PriceCatalogScopeTier, [boolean, boolean]> = {
  VENDOR_BUILDING: [true, true],
  VENDOR: [true, false],
  BUILDING: [false, true],
  CLIENT_WIDE: [false, false],
};

function emptyReference(
  resolution: PurchaseOrderPriceDeviationResolution,
): PurchaseOrderLinePriceReference {
  return {
    resolution,
    priceEntryId: null,
    scopeTier: null,
    scopeVendor: null,
    scopeBuilding: null,
    unitPrice: null,
    currency: null,
    uomId: null,
    effectiveFrom: null,
    effectiveTo: null,
    referenceTotal: null,
    unitVariance: null,
    totalVariance: null,
    variancePercent: null,
    position: null,
  };
}

async function resolveLineDeviation(
  purchaseOrder: PurchaseOrderRecord,
  line: PurchaseOrderLineRecord,
  asOf: string,
  actorUserId: string,
): Promise<PurchaseOrderLinePriceReference> {
  // CR-BE-SVC-01 PART 05 — SERVICE lines resolve against the governed SERVICE
  // reference authority when the PO line carries a governed identity (PART 04);
  // otherwise NOT_REQUESTED. SERVICE has no quantity/UOM: unit-vs-unit advisory
  // only (no reference total / total variance). No inference/backfill.
  if (line.requestLineType === 'SERVICE_REQUEST') {
    if (line.sourceServiceId === null) {
      return emptyReference('NOT_REQUESTED');
    }
    const lookup = await priceCatalogLookupService.lookupPriceCatalogEntry(
      {
        sourceMode: 'SERVICE',
        buildingId: purchaseOrder.buildingId,
        vendorId: purchaseOrder.vendorId,
        serviceId: line.sourceServiceId,
        currency: purchaseOrder.currency as PriceCatalogCurrency,
        asOf,
      },
      actorUserId,
    );
    if (lookup.resolution === 'AMBIGUOUS') {
      return emptyReference('AMBIGUOUS');
    }
    if (lookup.resolution !== 'MATCHED' || lookup.entry === null) {
      return emptyReference(lookup.resolution);
    }
    const entry = lookup.entry;
    const tier = lookup.scopeTier ?? 'CLIENT_WIDE';
    const [scopeVendor, scopeBuilding] = TIER_PROVENANCE[tier];
    const unitVariance = roundMoney(line.unitPrice - entry.unitPrice);
    const variancePercent = roundMoney((unitVariance / entry.unitPrice) * 100);
    return {
      resolution: 'MATCHED',
      priceEntryId: entry.id,
      scopeTier: tier,
      scopeVendor,
      scopeBuilding,
      unitPrice: entry.unitPrice,
      currency: entry.currency,
      uomId: null,
      effectiveFrom: entry.effectiveFrom,
      effectiveTo: entry.effectiveTo,
      referenceTotal: null,
      unitVariance,
      totalVariance: null,
      variancePercent,
      position: unitVariance > 0 ? 'ABOVE' : unitVariance < 0 ? 'BELOW' : 'EQUAL',
    };
  }
  // Legacy/odd MATERIAL shape without item or UOM snapshot: nothing exact
  // can resolve — explicit incompatibility, mirroring PART 04.
  if (line.itemId === null || line.uomId === null) {
    return emptyReference('UOM_INCOMPATIBLE');
  }

  const lookup = await priceCatalogLookupService.lookupPriceCatalogEntry(
    {
      sourceMode: 'MATERIAL',
      buildingId: purchaseOrder.buildingId,
      vendorId: purchaseOrder.vendorId,
      itemId: line.itemId,
      uomId: line.uomId,
      currency: purchaseOrder.currency as PriceCatalogCurrency,
      asOf,
    },
    actorUserId,
  );

  if (lookup.resolution !== 'MATCHED' || lookup.entry === null) {
    // NO_REFERENCE_PRICE / UOM_INCOMPATIBLE / CURRENCY_INCOMPATIBLE /
    // AMBIGUOUS — reported as typed outcomes with null facts, never a guess.
    return emptyReference(lookup.resolution);
  }

  const entry = lookup.entry;
  const tier = lookup.scopeTier ?? 'CLIENT_WIDE';
  const [scopeVendor, scopeBuilding] = TIER_PROVENANCE[tier];
  const quantity = line.quantitySnapshot;

  const unitVariance = roundMoney(line.unitPrice - entry.unitPrice);
  const referenceTotal =
    quantity === null ? null : roundMoney(entry.unitPrice * quantity);
  const totalVariance =
    referenceTotal === null ? null : roundMoney(line.lineAmount - referenceTotal);
  // Catalog unit prices are > 0 by CHECK, so the division is structurally
  // safe (governance R-16); PO facts are never divided by anything.
  const variancePercent = roundMoney((unitVariance / entry.unitPrice) * 100);

  return {
    resolution: 'MATCHED',
    priceEntryId: entry.id,
    scopeTier: tier,
    scopeVendor,
    scopeBuilding,
    unitPrice: entry.unitPrice,
    currency: entry.currency,
    uomId: entry.uomId,
    effectiveFrom: entry.effectiveFrom,
    effectiveTo: entry.effectiveTo,
    referenceTotal,
    unitVariance,
    totalVariance,
    variancePercent,
    position: unitVariance > 0 ? 'ABOVE' : unitVariance < 0 ? 'BELOW' : 'EQUAL',
  };
}

/**
 * Computes the advisory deviation projection for one Purchase Order.
 * Scope gate: the caller must reach the PO's Building (BE-02G), exactly as
 * every other PO read. The permission boundary lives at the route.
 */
export async function getPurchaseOrderPriceDeviation(
  id: string,
  actorUserId: string,
): Promise<PurchaseOrderPriceDeviation> {
  const purchaseOrder = await purchaseOrderRepository.findById(id);
  if (!purchaseOrder) throw purchaseOrderNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    purchaseOrder.buildingId,
  );

  const lines = await purchaseOrderLineRepository.listByPurchaseOrder(id);
  const asOf = new Date().toISOString();

  const deviationLines: PurchaseOrderPriceDeviationLine[] = [];
  for (const line of lines) {
    deviationLines.push({
      purchaseOrderLineId: line.id,
      lineNumber: line.lineNumber,
      requestLineType: line.requestLineType,
      itemId: line.itemId,
      uomId: line.uomId,
      quantitySnapshot: line.quantitySnapshot,
      unitPrice: line.unitPrice,
      lineAmount: line.lineAmount,
      reference: await resolveLineDeviation(
        purchaseOrder,
        line,
        asOf,
        actorUserId,
      ),
    });
  }

  return {
    purchaseOrderId: purchaseOrder.id,
    poNumber: purchaseOrder.poNumber,
    purchaseOrderStatus: purchaseOrder.status,
    clientId: purchaseOrder.clientId,
    buildingId: purchaseOrder.buildingId,
    vendorId: purchaseOrder.vendorId,
    currency: purchaseOrder.currency,
    asOf,
    advisoryOnly: true,
    lines: deviationLines,
  };
}

export const purchaseOrderPriceDeviationService = {
  getPurchaseOrderPriceDeviation,
};
