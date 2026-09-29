/**
 * CR-HM-02 PART 01 — Handyman Service Variant types.
 *
 * Handyman-governed child of the existing `service_catalog` master
 * (migration 0376; frozen CR-HM-02 governance chain Service → Service
 * Variant → …). Identity/presentation only for later read-only Handyman
 * catalogue composition: a Variant is never a separate authoritative
 * service master, and this module carries no material/media/price/request/
 * evidence behavior (later PARTs). Reference Price != Quotation !=
 * Final Charge.
 */

export const HANDYMAN_SERVICE_VARIANT_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type HandymanServiceVariantStatus =
  (typeof HANDYMAN_SERVICE_VARIANT_STATUSES)[number];

export function isHandymanServiceVariantStatus(
  value: unknown,
): value is HandymanServiceVariantStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_SERVICE_VARIANT_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type HandymanServiceVariantRecord = {
  id: string;
  /** Tenant-isolation root, derived from the parent service entry. */
  clientId: string;
  /** Parent master service reference (`service_catalog.id`). */
  serviceCatalogId: string;
  code: string;
  name: string;
  description: string | null;
  status: HandymanServiceVariantStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation. */
export type PublicHandymanServiceVariant = Omit<
  HandymanServiceVariantRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

/**
 * Server-side creation input. The caller never supplies `clientId`: it is
 * derived from the parent service entry (and proven structurally by the
 * composite scope-FK).
 */
export type CreateHandymanServiceVariantInput = {
  serviceCatalogId: string;
  code: string;
  name: string;
  description?: string;
};

/** Fully-resolved data ready for persistence. */
export type NewHandymanServiceVariant = {
  clientId: string;
  serviceCatalogId: string;
  code: string;
  name: string;
  description: string | null;
  createdByUserId: string;
};

/** List filters for the read foundation (Client scope is mandatory). */
export type HandymanServiceVariantFilters = {
  clientId: string;
  serviceCatalogId?: string;
  status?: HandymanServiceVariantStatus;
};
