/**
 * CR-BE-SVC-01 PART 01 — Service Catalog domain types.
 *
 * The governed Service master identity (`service_catalog`, migration `0321`).
 * It is the SERVICE analog of `inventory_items` (0166): a Client-scoped,
 * code-classified reference master with ACTIVE/INACTIVE lifecycle.
 *
 * This module owns the catalog identity only. It does not own Service Request
 * integration (PART 02), Vendor capability linking (PART 03), RFQ/quotation/PO
 * lineage snapshots (PART 04), SERVICE price widening (PART 05), or any
 * demand/price/quantity/UOM behavior (governance §4.4, §20).
 */

export const SERVICE_CATALOG_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ServiceCatalogStatus = (typeof SERVICE_CATALOG_STATUSES)[number];

export function isServiceCatalogStatus(
  value: unknown,
): value is ServiceCatalogStatus {
  return (
    typeof value === 'string' &&
    (SERVICE_CATALOG_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Code grammar is byte-identical to the existing free-text
 * `service_request.service_type` validation pattern (`service-request.validation.ts`):
 * uppercase, leading letter, then uppercase letters / digits / underscore /
 * hyphen, 2–64 characters. This is the migration bridge: today's accepted
 * free-text codes are valid catalog codes with zero grammar friction.
 */
export const SERVICE_CATALOG_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
export const SERVICE_CATALOG_CODE_MIN_LENGTH = 2;
export const SERVICE_CATALOG_CODE_MAX_LENGTH = 64;

/** Full database record. */
export type ServiceCatalogRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
  status: ServiceCatalogStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicServiceCatalogEntry = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
  status: ServiceCatalogStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** Input supplied by the API consumer when creating a catalog entry. */
export type CreateServiceCatalogEntryInput = {
  clientId: string;
  code: string;
  name: string;
  category: string;
  description?: string;
};

/** Fully-resolved data ready for persistence. Created ACTIVE (governance §11). */
export type NewServiceCatalogEntry = {
  clientId: string;
  code: string;
  name: string;
  category: string;
  description: string | null;
  createdByUserId: string;
};

/**
 * Partial update input (PATCH). Identity (`code`, `clientId`) is immutable;
 * `status` is not editable here — deactivation is the governed lifecycle
 * transition (governance §11/§16). Only `name`, `description`, `category`
 * are editable.
 */
export type UpdateServiceCatalogEntryInput = {
  name?: string;
  description?: string | null;
  category?: string;
};

/** List filters for GET /service-catalog/entries */
export type ServiceCatalogFilters = {
  clientId?: string;
  status?: ServiceCatalogStatus;
  category?: string;
  search?: string;
};
