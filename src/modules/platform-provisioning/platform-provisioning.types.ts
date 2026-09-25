/**
 * CR-BE-SAAS-01 PART 05 — SaaS provisioning types (frozen §13).
 *
 * Product-agnostic CORE — but PART 05 implements the exact frozen
 * §13 Workflow which is keyed to the Asentra Building operational
 * hierarchy (Organization → Property → Building → admin). Vendor FM
 * and Handyman provisioning semantics are NOT implemented here
 * (frozen §13 does not bind them yet) and a request for a non-Building
 * product code is intentionally OUT OF SCOPE: PART 05 implements
 * the current frozen contract; future PARTs may bind more profiles.
 *
 * No SaaS "tenants" table is introduced (frozen D4). The customer's
 * "provisioning COMPLETED" state is DERIVED from the latest
 * `saas_provisioning_runs` row; no `clients` column changes are
 * required.
 */

export const SAAS_PROVISIONING_RUN_STATUSES = [
  'RUNNING',
  'COMPLETED',
  'FAILED',
] as const;
export type SaasProvisioningRunStatus =
  (typeof SAAS_PROVISIONING_RUN_STATUSES)[number];

export type SaasProvisioningStepStatus = 'PENDING' | 'RUNNING' | 'OK' | 'FAILED' | 'SKIPPED';

export type SaasProvisioningStep = {
  name: string;
  status: SaasProvisioningStepStatus;
  naturalKey: string | null;
  resourceIds: Record<string, string>;
  /** MUST NOT carry secrets (no passwords, no tokens, no provider refs). */
  error?: string;
};

export type SaasProvisioningRunRecord = {
  id: string;
  customerId: string;
  status: SaasProvisioningRunStatus;
  attempt: number;
  steps: SaasProvisioningStep[];
  lastError: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicSaasProvisioningRun = {
  id: string;
  customerId: string;
  status: SaasProvisioningRunStatus;
  attempt: number;
  steps: SaasProvisioningStep[];
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicSaasProvisioningSummary = {
  customerId: string;
  /** Latest run (any status). */
  latest: PublicSaasProvisioningRun | null;
  /** Derived: the latest COMPLETED run, else null. */
  lastCompleted: PublicSaasProvisioningRun | null;
  /** Derived: is there at least one COMPLETED run? */
  provisioned: boolean;
};

export type PublicSaasProvisionedResources = {
  organizationId: string;
  propertyId: string;
  buildingId: string;
  /**
   * Null until the provisioned admin accepts their invitation (frozen
   * §11 IAM canonical onboarding path).
   */
  adminUserId: string | null;
  /**
   * Always populated for NEW admins; null when an existing user was
   * re-anchored (no new invitation needed).
   */
  adminInvitationId: string | null;
  adminEmail: string;
  /** Stable per-customer provisioning role id (canonical business-plane). */
  roleId: string;
};

export type PublicSaasProvisioningResult = {
  run: PublicSaasProvisioningRun;
  resources: PublicSaasProvisionedResources;
};

/** Frozen §13.1 command body. Caller supplies ONLY these optional fields. */
export type ProvisionCustomerInput = {
  organizationCode?: string;
  organizationName?: string;
  propertyCode?: string;
  propertyName?: string;
  buildingCode?: string;
  buildingName?: string;
  adminEmail?: string;
  adminName?: string;
  reason?: string;
  /** Frozen §17.3 — the route is "ver" against the customer aggregate. */
  expectedVersion: number;
};
