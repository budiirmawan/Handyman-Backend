/**
 * CR-BE-SAAS-01 PART 02 — versioned SaaS Pricebook types.
 *
 * Frozen contract §10. Historical commercial terms are preserved: versions
 * are DRAFT → PUBLISHED → SUPERSEDED; a PUBLISHED version is immutable
 * (trigger + service); publishing a new version supersedes the previous
 * PUBLISHED version (single-publish invariant). Later PARTs reference
 * `saas_pricebook_versions.id` — the immutable/versioned commercial record.
 */

export type SaasPricebookStatus = 'ACTIVE' | 'INACTIVE';

export type SaasPricebookRecord = {
  id: string;
  code: string;
  name: string;
  /** Default currency for items (canonical `currencies` authority). */
  currencyCode: string;
  status: SaasPricebookStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSaasPricebookInput = {
  code: string;
  name: string;
  currencyCode: string;
  status?: SaasPricebookStatus;
};

export type ListSaasPricebookFilters = {
  status?: SaasPricebookStatus;
};

export type SaasPricebookVersionStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';

export type SaasPricebookVersionRecord = {
  id: string;
  pricebookId: string;
  versionNumber: number;
  status: SaasPricebookVersionStatus;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  publishedAt: Date | null;
  publishedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BillingCycle = 'MONTHLY' | 'ANNUAL' | 'CUSTOM';

export type SaasPriceItemRecord = {
  id: string;
  pricebookVersionId: string;
  productId: string;
  /** Nullable for platform-wide items (not bound to a package). */
  packageId: string | null;
  currencyCode: string;
  billingCycle: BillingCycle;
  basePrice: number;
  includedBuildingCount: number;
  additionalBuildingPrice: number;
  createdAt: Date;
  updatedAt: Date;
};

export type SaasPricebookVersionDetail = SaasPricebookVersionRecord & {
  items: SaasPriceItemRecord[];
};

export type SaasPricebookDetail = SaasPricebookRecord & {
  versions: SaasPricebookVersionDetail[];
};

export type PriceItemInput = {
  productId: string;
  packageId?: string | null;
  currencyCode?: string;
  billingCycle: BillingCycle;
  basePrice: number;
  includedBuildingCount?: number;
  additionalBuildingPrice?: number;
};

export type CreateSaasPricebookVersionInput = {
  /** ISO date-time — required; the version's effective start. */
  effectiveFrom: string;
  items: PriceItemInput[];
};

/** Normalized, validated price item ready for persistence. */
export type NormalizedPriceItem = {
  productId: string;
  packageId: string | null;
  currencyCode: string;
  billingCycle: BillingCycle;
  basePrice: number;
  includedBuildingCount: number;
  additionalBuildingPrice: number;
};
