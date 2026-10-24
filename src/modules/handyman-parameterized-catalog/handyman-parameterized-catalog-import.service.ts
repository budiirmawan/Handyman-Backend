import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanParameterizedCatalogRepository,
} from './handyman-parameterized-catalog.repository';
import {
  HANDYMAN_STARTER_CATEGORIES,
  HANDYMAN_STARTER_SERVICES,
  HANDYMAN_STARTER_UOMS,
  HANDYMAN_STARTER_VARIANT_CODE,
  HANDYMAN_STARTER_VARIANT_NAME,
} from './handyman-parameterized-catalog.starter';
import { handymanServiceCatalogImportInvalidError } from './handyman-parameterized-catalog.errors';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — the per-Client STARTER IMPORT.
 *
 * The import installs the governed starter definition (8 categories, 24
 * generic services, their technical attribute definitions, one default
 * variant per service, the per-service commercial posture and the five
 * quantity UOMs) into ONE Client.
 *
 * Three properties are contractual, not incidental:
 *
 *  1. IDEMPOTENT — every insert is `ON CONFLICT ... DO NOTHING`. A second
 *     run creates nothing and changes nothing.
 *  2. NEVER OVERWRITES EXISTING DATA — a pre-existing row (an
 *     administrator's renamed service, a re-priced commercial profile, an
 *     edited attribute) is left exactly as it is. There is no UPDATE and no
 *     DELETE anywhere in this module.
 *  3. CONCURRENCY-SAFE — the whole import runs inside ONE transaction that
 *     first takes a per-Client advisory lock, so two concurrent imports of
 *     the same Client serialize instead of racing. The second one then
 *     observes the first one's rows and creates nothing.
 *
 * The import NEVER invents a price: it creates no price rule and no price
 * amount. Until an administrator points a price rule at the existing
 * governed price authority (`price_catalog_entries`), the catalogue simply
 * has no price — and the pricing engine says so instead of inventing one.
 */

export type HandymanStarterImportCounts = {
  created: number;
  skipped: number;
};

export type HandymanStarterImportResult = {
  clientId: string;
  categories: HandymanStarterImportCounts;
  services: HandymanStarterImportCounts;
  attributes: HandymanStarterImportCounts;
  variants: HandymanStarterImportCounts;
  commercialProfiles: HandymanStarterImportCounts;
  unitsOfMeasure: HandymanStarterImportCounts;
  /** ISO timestamp of the import run. */
  importedAt: string;
};

function emptyCounts(): HandymanStarterImportCounts {
  return { created: 0, skipped: 0 };
}

function track(
  counts: HandymanStarterImportCounts,
  created: boolean,
): void {
  if (created) counts.created += 1;
  else counts.skipped += 1;
}

/**
 * Per-Client advisory lock. The key is derived from the Client id so two
 * different Clients never block each other, while two imports of the SAME
 * Client always serialize.
 */
async function lockClientCatalog(tx: {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
}, clientId: string): Promise<void> {
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
    [`handyman-service-catalog-starter:${clientId}`],
  );
}

export async function importHandymanServiceCatalogStarter(
  clientId: string,
  actorUserId: string,
): Promise<HandymanStarterImportResult> {
  if (!isValidUuid(clientId)) {
    throw handymanServiceCatalogImportInvalidError(
      'clientId must be a valid UUID.',
    );
  }
  if (!isValidUuid(actorUserId)) {
    throw handymanServiceCatalogImportInvalidError(
      'actorUserId must be a valid UUID.',
    );
  }

  // Client-scoped isolation (same convention as `service_catalog`: the
  // catalogue is Client-scoped, isolation is per Client).
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }

  const counts = {
    categories: emptyCounts(),
    services: emptyCounts(),
    attributes: emptyCounts(),
    variants: emptyCounts(),
    commercialProfiles: emptyCounts(),
    unitsOfMeasure: emptyCounts(),
  };

  await withTransaction(async (tx) => {
    // Concurrency guard: serialize imports of the same Client.
    await lockClientCatalog(tx as never, clientId);

    // 1) Quantity UOMs — one per price basis.
    for (const uom of HANDYMAN_STARTER_UOMS) {
      const result =
        await handymanParameterizedCatalogRepository.insertUnitOfMeasureIfAbsent(
          tx as never,
          {
            clientId,
            code: uom.code,
            name: uom.name,
            symbol: uom.symbol,
            category: uom.category,
          },
        );
      track(counts.unitsOfMeasure, result.created);
    }

    // 2) Governed categories.
    for (const category of HANDYMAN_STARTER_CATEGORIES) {
      const result =
        await handymanParameterizedCatalogRepository.insertCategoryIfAbsent(
          tx as never,
          {
            clientId,
            code: category.code,
            name: category.name,
            description: category.description,
            status: 'ACTIVE',
            createdByUserId: actorUserId,
          },
        );
      track(counts.categories, result.created);
    }

    // 3) The 24 generic services, their attributes, their default variant
    //    and their commercial posture.
    for (const service of HANDYMAN_STARTER_SERVICES) {
      const serviceRow =
        await handymanParameterizedCatalogRepository.insertServiceCatalogIfAbsent(
          tx as never,
          {
            clientId,
            code: service.code,
            name: service.name,
            description: service.description,
            // The existing `service_catalog.category` column is written with
            // the governed category CODE so the free-text master and the
            // governed category master stay reconcilable.
            category: service.categoryCode,
            createdByUserId: actorUserId,
          },
        );
      track(counts.services, serviceRow.created);

      for (const attribute of service.attributes) {
        const attributeRow =
          await handymanParameterizedCatalogRepository.insertAttributeIfAbsent(
            tx as never,
            {
              clientId,
              serviceCatalogId: serviceRow.id,
              code: attribute.code,
              name: attribute.name,
              description: attribute.description,
              dataType: attribute.dataType,
              unit: attribute.unit ?? null,
              required: attribute.required,
              allowFreeValue: attribute.allowFreeValue ?? false,
              allowedValues: attribute.allowedValues ?? [],
              sortOrder: attribute.sortOrder,
              status: 'ACTIVE',
              createdByUserId: actorUserId,
            },
          );
        track(counts.attributes, attributeRow.created);
      }

      const variantRow =
        await handymanParameterizedCatalogRepository.insertVariantIfAbsent(
          tx as never,
          {
            clientId,
            serviceCatalogId: serviceRow.id,
            code: HANDYMAN_STARTER_VARIANT_CODE,
            name: HANDYMAN_STARTER_VARIANT_NAME,
            description:
              'Default variant installed by the Handyman service catalog starter import.',
            createdByUserId: actorUserId,
          },
        );
      track(counts.variants, variantRow.created);

      const profileRow =
        await handymanParameterizedCatalogRepository.insertCommercialProfileIfAbsent(
          tx as never,
          {
            clientId,
            serviceCatalogId: serviceRow.id,
            pricingMode: service.pricingMode,
            notes: null,
            status: 'ACTIVE',
            createdByUserId: actorUserId,
          },
        );
      track(counts.commercialProfiles, profileRow.created);
    }

    await recordOperationalEvent(
      {
        clientId,
        eventType: 'HANDYMAN_SERVICE_CATALOG_STARTER_IMPORTED',
        entityType: 'HANDYMAN_SERVICE_CATALOG',
        entityId: clientId,
        actorUserId,
        summary:
          'Handyman service catalog starter import completed (idempotent, non-overwriting).',
        metadata: {
          categories: counts.categories,
          services: counts.services,
          attributes: counts.attributes,
          variants: counts.variants,
          commercialProfiles: counts.commercialProfiles,
          unitsOfMeasure: counts.unitsOfMeasure,
        },
      },
      tx,
    );
  });

  return {
    clientId,
    ...counts,
    importedAt: new Date().toISOString(),
  };
}
