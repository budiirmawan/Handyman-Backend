/**
 * CR-BE-SAAS-01 PART 02 — SaaS Product & Package catalog types.
 *
 * Frozen contract §9.1–9.4. The package is an EDITION DEFINITION ("what
 * would this package grant?") — features (declarative grants against the
 * existing canonical `modules` catalogue) and limits (definition only — no
 * runtime usage counting or quota enforcement in PART 02).
 */

export type SaasProductStatus = 'ACTIVE' | 'INACTIVE';

export type SaasProductRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: SaasProductStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSaasProductInput = {
  code: string;
  name: string;
  description?: string | null;
  status?: SaasProductStatus;
};

export type UpdateSaasProductInput = {
  name?: string;
  description?: string | null;
  status?: SaasProductStatus;
};

export type ListSaasProductFilters = {
  status?: SaasProductStatus;
};

export type SaasPackageStatus = 'ACTIVE' | 'INACTIVE';

export type SaasPackageRecord = {
  id: string;
  productId: string;
  code: string;
  name: string;
  description: string | null;
  status: SaasPackageStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PackageFeatureRecord = {
  id: string;
  packageId: string;
  /** References the existing canonical `modules` catalogue code. */
  capabilityCode: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** Canonical limit_key vocabulary (frozen; extensible only by CR amendment). */
export const FROZEN_PACKAGE_LIMIT_KEYS = [
  'building.count',
  'user.count',
  'active.asset.count',
  'monthly.wo.count',
  'storage.bytes',
  'api.requests',
  'integration.count',
  'ai.usage',
] as const;

export type FrozenPackageLimitKey = (typeof FROZEN_PACKAGE_LIMIT_KEYS)[number];

export type PackageLimitRecord = {
  id: string;
  packageId: string;
  limitKey: FrozenPackageLimitKey;
  limitValue: number;
  unit: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SaasPackageDetail = SaasPackageRecord & {
  features: PackageFeatureRecord[];
  limits: PackageLimitRecord[];
};

export type PackageFeatureInput = {
  capabilityCode: string;
  enabled?: boolean;
};

export type PackageLimitInput = {
  limitKey: FrozenPackageLimitKey;
  limitValue: number;
  unit: string;
};

export type CreateSaasPackageInput = {
  productId: string;
  code: string;
  name: string;
  description?: string | null;
  status?: SaasPackageStatus;
  features?: PackageFeatureInput[];
  limits?: PackageLimitInput[];
};

/**
 * PATCH semantics: scalar fields are patched individually; `features` and
 * `limits`, when provided, REPLACE the package's composition (atomic,
 * same transaction).
 */
export type UpdateSaasPackageInput = {
  name?: string;
  description?: string | null;
  status?: SaasPackageStatus;
  features?: PackageFeatureInput[];
  limits?: PackageLimitInput[];
};

export type ListSaasPackageFilters = {
  productId?: string;
  status?: SaasPackageStatus;
};
