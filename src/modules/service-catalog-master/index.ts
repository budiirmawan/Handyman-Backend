/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Service Catalog Starter module.
 *
 * Service Category master + Service Item linkage, Client/Building availability
 * grants, the governed starter-pack import and the authoritative read model.
 * Pricing is composed from the existing price-catalog authority at read time.
 */
export * from './service-catalog-master.types';
export * from './service-catalog-master.errors';
export { serviceCatalogMasterRepository } from './service-catalog-master.repository';
export { serviceCatalogMasterService } from './service-catalog-master.service';
export type { StarterPackImportOutcome } from './service-catalog-master.service';
export {
  STARTER_PACK_CATEGORIES,
  STARTER_PACK_SERVICES,
  STARTER_PACK_OPERATION_KEY,
  starterPackCategoryCodes,
} from './service-catalog-starter-catalog';
export { createServiceCatalogMasterRouter } from './service-catalog-master.routes';
