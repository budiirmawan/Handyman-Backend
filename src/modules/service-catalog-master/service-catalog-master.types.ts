/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Service Catalog Starter domain types.
 *
 * Promotes the existing flat `service_catalog` reference master (0321) into a
 * two-level Service Catalog:
 *
 *   Service Category (governed, Client-scoped master, migration 0473)
 *     └── Service Item (the EXISTING `service_catalog` row; additive
 *        `service_category_id` link + `source`)
 *
 * plus Client/Building availability grants (`service_catalog_availability`).
 *
 * Pricing is deliberately absent from this module: the governed reference
 * price stays on the existing `price_catalog_entries` SERVICE authority and is
 * composed at read time. The catalogue therefore has no default price and
 * never invents a nominal amount (fail-closed → `referencePrice: null`).
 */

import type { ServiceCatalogStatus } from '../service-catalog/service-catalog.types';

export const SERVICE_CATEGORY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ServiceCategoryStatus =
  (typeof SERVICE_CATEGORY_STATUSES)[number];

export function isServiceCategoryStatus(
  value: unknown,
): value is ServiceCategoryStatus {
  return (
    typeof value === 'string' &&
    (SERVICE_CATEGORY_STATUSES as readonly string[]).includes(value)
  );
}

/** `source` distinguishes a governed starter import from a manual create. */
export const SERVICE_CATALOG_SOURCES = ['MANUAL', 'STARTER_PACK'] as const;
export type ServiceCatalogSource = (typeof SERVICE_CATALOG_SOURCES)[number];

export function isServiceCatalogSource(
  value: unknown,
): value is ServiceCatalogSource {
  return (
    typeof value === 'string' &&
    (SERVICE_CATALOG_SOURCES as readonly string[]).includes(value)
  );
}

export type ServiceCategoryRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: ServiceCategoryStatus;
  source: ServiceCatalogSource;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicServiceCategory = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: ServiceCategoryStatus;
  source: ServiceCatalogSource;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateServiceCategoryInput = {
  clientId: string;
  code: string;
  name: string;
  description?: string;
};

export type NewServiceCategory = {
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  source: ServiceCatalogSource;
  createdByUserId: string;
};

export type UpdateServiceCategoryInput = {
  name?: string;
  description?: string | null;
};

export type ServiceCategoryFilters = {
  clientId?: string;
  status?: ServiceCategoryStatus;
};

/** Full database record for a building-scoped availability grant. */
export type ServiceCatalogAvailabilityRecord = {
  id: string;
  clientId: string;
  serviceCatalogId: string;
  buildingId: string;
  status: ServiceCategoryStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicServiceCatalogAvailability = {
  id: string;
  clientId: string;
  serviceCatalogId: string;
  buildingId: string;
  status: ServiceCategoryStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type NewServiceCatalogAvailability = {
  clientId: string;
  serviceCatalogId: string;
  buildingId: string;
  createdByUserId: string;
};

/**
 * Starter-pack read model — one Service Item with its governed category,
 * Client/Building availability and (optionally) composed reference price.
 * `referencePrice` is null unless a governed SERVICE price catalog entry
 * resolves for the requested Building + currency; never guessed.
 */
export type ServiceCatalogItemView = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: ServiceCatalogStatus;
  source: ServiceCatalogSource;
  categoryId: string | null;
  categoryCode: string | null;
  categoryName: string | null;
  /** null when no Building scope was requested. */
  availableInBuilding: boolean | null;
  availabilityScope: 'CLIENT_WIDE' | 'BUILDING_SCOPED';
  referencePrice: ServiceCatalogReferencePrice | null;
};

export type ServiceCatalogReferencePrice = {
  unitPrice: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  scopeTier: string;
};

export type ServiceCatalogCategoryView = PublicServiceCategory & {
  services: ServiceCatalogItemView[];
};

export type ServiceCatalogReadModel = {
  clientId: string;
  buildingId: string | null;
  currency: string | null;
  asOf: string;
  categories: ServiceCatalogCategoryView[];
  services: ServiceCatalogItemView[];
};

/** Starter pack — the frozen Apartment Indonesia catalogue (8 categories, 24 items). */
export type StarterPackCategory = {
  code: string;
  name: string;
  description: string;
};

export type StarterPackService = {
  code: string;
  name: string;
  description: string;
  categoryCode: string;
};

export type StarterPackImportResult = {
  clientId: string;
  operationKey: string;
  categoriesCreated: number;
  categoriesSkipped: number;
  servicesCreated: number;
  servicesSkipped: number;
  totalCategories: number;
  totalServices: number;
  replayed: boolean;
};

/** Result of linking an existing Service Item to a governed Service Category. */
export type ServiceCatalogCategoryLinkResult = {
  serviceCatalogId: string;
  clientId: string;
  code: string;
  name: string;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
};
