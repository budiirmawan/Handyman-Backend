import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { priceCatalogBuildingNotFoundError } from './price-catalog-entry.errors';
import { priceCatalogEntryRepository } from './price-catalog-entry.repository';
import { toPublicPriceCatalogEntry } from './price-catalog-entry.service';
import type {
  PriceCatalogEntryRecord,
} from './price-catalog-entry.types';
import type {
  PriceCatalogLookupInput,
  PriceCatalogLookupResolution,
  PriceCatalogLookupResult,
  PriceCatalogScopeTier,
} from './price-catalog-lookup.types';

/**
 * CR-BE-PRICE-01 PART 02 — deterministic effective-price resolver (§8).
 *
 * Semantics frozen by docs/CR-BE-PRICE-01_START_GOVERNANCE.md:
 *
 *   - Exact match only: Inventory Item, required UOM (no conversion — §10),
 *     and currency (no FX — §9). What is not equal is never compared.
 *   - Scope precedence is fixed, never arbitrary:
 *       1. Vendor + Building
 *       2. Vendor (Client-wide)
 *       3. Building (general)
 *       4. Client-wide (general)
 *     The PART 01 ACTIVE-window exclusion constraint guarantees at most one
 *     applicable row per tier, so the first non-empty tier has exactly one
 *     winner; there is deliberately no ID/date tie-break inside a tier.
 *   - As-of selection is half-open [effective_from, effective_to): future
 *     ACTIVE windows are invisible until T arrives; past-ended windows and
 *     DRAFT/INACTIVE rows are never selected.
 *   - Fail closed, never guess: NO_REFERENCE_PRICE / UOM_INCOMPATIBLE /
 *     CURRENCY_INCOMPATIBLE are valid typed answers, and the defensive
 *     AMBIGUOUS trip records PRICE_CATALOG_AMBIGUITY_REJECTED (§17) so the
 *     caller can surface an error instead of a fabricated price.
 *
 * This seam is internal-only. It opens nothing to RFQ Vendor sessions and
 * never creates RFQ, quotation, award, PO, commitment, or actual-cost
 * behavior. The ambiguity audit write is intentionally committed on the
 * shared pool (not a caller transaction): incident evidence must survive
 * even when the observing caller rolls its work back.
 */

const SCOPE_TIER_BY_RANK: Readonly<Record<number, PriceCatalogScopeTier>> = {
  1: 'VENDOR_BUILDING',
  2: 'VENDOR',
  3: 'BUILDING',
  4: 'CLIENT_WIDE',
};

function tierRankOf(
  entry: Pick<PriceCatalogEntryRecord, 'vendorId' | 'buildingId'>,
): number {
  if (entry.vendorId !== null && entry.buildingId !== null) return 1;
  if (entry.vendorId !== null) return 2;
  if (entry.buildingId !== null) return 3;
  return 4;
}

export async function lookupPriceCatalogEntry(
  input: PriceCatalogLookupInput,
  actorUserId: string,
): Promise<PriceCatalogLookupResult> {
  // The Building is the scope anchor: it derives the governed Client (the
  // caller never supplies one) and it is the isolation checkpoint.
  const building = await priceCatalogEntryRepository.loadBuildingById(
    input.buildingId,
  );
  if (!building) throw priceCatalogBuildingNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);

  const clientId = building.clientId;
  const vendorId = input.vendorId ?? null;
  const asOf = new Date(input.asOf);
  const sourceMode = input.sourceMode;

  const context = {
    clientId,
    buildingId: input.buildingId,
    vendorId,
    sourceMode,
    itemId: sourceMode === 'MATERIAL' ? input.itemId : null,
    uomId: sourceMode === 'MATERIAL' ? input.uomId : null,
    serviceId: sourceMode === 'SERVICE' ? input.serviceId : null,
    currency: input.currency,
    asOf: asOf.toISOString(),
  };

  const candidates = await priceCatalogEntryRepository.listResolutionCandidates(
    sourceMode === 'MATERIAL'
      ? {
          sourceMode: 'MATERIAL',
          clientId,
          itemId: input.itemId,
          buildingId: input.buildingId,
          vendorId,
          uomId: input.uomId,
          currency: input.currency,
          asOf,
        }
      : {
          sourceMode: 'SERVICE',
          clientId,
          serviceId: input.serviceId,
          buildingId: input.buildingId,
          vendorId,
          currency: input.currency,
          asOf,
        },
  );

  // Fixed precedence: the first non-empty tier wins. Structurally that tier
  // holds exactly one row (exclusion constraint); a larger winning group is
  // the defensive AMBIGUOUS trip — fail closed, audit, never pick.
  let winningRank = Number.POSITIVE_INFINITY;
  let winners: PriceCatalogEntryRecord[] = [];
  for (const candidate of candidates) {
    const rank = tierRankOf(candidate);
    if (rank < winningRank) {
      winningRank = rank;
      winners = [candidate];
    } else if (rank === winningRank) {
      winners.push(candidate);
    }
  }

  if (winners.length > 1) {
    await recordOperationalEvent({
      clientId,
      buildingId: input.buildingId,
      eventType: 'PRICE_CATALOG_AMBIGUITY_REJECTED',
      entityType: 'PRICE_CATALOG_LOOKUP',
      entityId: sourceMode === 'MATERIAL' ? input.itemId : input.serviceId,
      actorUserId,
      summary:
        'Price catalog lookup failed closed: more than one applicable ACTIVE price survived scope precedence.',
      metadata: {
        sourceMode,
        itemId: context.itemId,
        serviceId: context.serviceId,
        uomId: context.uomId,
        currency: input.currency,
        vendorId,
        asOf: context.asOf,
        scopeTier: SCOPE_TIER_BY_RANK[winningRank] ?? null,
        candidateCount: winners.length,
        candidateEntryIds: winners.map((winner) => winner.id),
      },
    });
    return {
      ...context,
      resolution: 'AMBIGUOUS',
      scopeTier: null,
      entry: null,
    };
  }

  if (winners.length === 1) {
    const winner = winners[0];
    return {
      ...context,
      resolution: 'MATCHED',
      scopeTier: SCOPE_TIER_BY_RANK[winningRank] ?? 'CLIENT_WIDE',
      entry: toPublicPriceCatalogEntry(winner),
    };
  }

  // Fail-closed classification for the no-winner case. The diagnosis set is
  // scope- and window-filtered identically to selection, so an out-of-scope
  // or not-yet-effective price is never revealed by its side effects. UOM is
  // checked before currency for MATERIAL (exact quantity semantics dominate,
  // §10). SERVICE has no UOM, so its only classification beyond
  // NO_REFERENCE_PRICE is CURRENCY_INCOMPATIBLE.
  let resolution: PriceCatalogLookupResolution = 'NO_REFERENCE_PRICE';
  const diagnostics =
    await priceCatalogEntryRepository.listResolutionDiagnostics(
      sourceMode === 'MATERIAL'
        ? {
            sourceMode: 'MATERIAL',
            clientId,
            itemId: input.itemId,
            buildingId: input.buildingId,
            vendorId,
            asOf,
          }
        : {
            sourceMode: 'SERVICE',
            clientId,
            serviceId: input.serviceId,
            buildingId: input.buildingId,
            vendorId,
            asOf,
          },
    );
  if (diagnostics.length > 0) {
    if (sourceMode === 'SERVICE') {
      // SERVICE has no UOM; any same-subject in-scope/in-window entry is a
      // currency miss (it was not selected only by currency).
      resolution = 'CURRENCY_INCOMPATIBLE';
    } else {
      resolution = diagnostics.some((row) => row.uomId === input.uomId)
        ? 'CURRENCY_INCOMPATIBLE'
        : 'UOM_INCOMPATIBLE';
    }
  }

  return {
    ...context,
    resolution,
    scopeTier: null,
    entry: null,
  };
}

export const priceCatalogLookupService = {
  lookupPriceCatalogEntry,
};
