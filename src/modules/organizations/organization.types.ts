/**
 * BE-03A — Organization domain types.
 *
 * An Organization is a top-level workforce / business-structure unit scoped to
 * a single Client. It is NOT a Property, Building, Subscription, Role, or
 * Permission (those domains live in BE-01/BE-02).
 */

export const ORGANIZATION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export function isOrganizationStatus(value: unknown): value is OrganizationStatus {
  return (
    typeof value === 'string' &&
    (ORGANIZATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type OrganizationRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Public API representation. */
export type PublicOrganization = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: OrganizationStatus;
};

/** Input supplied by the API consumer. */
export type CreateOrganizationInput = {
  clientId: string;
  code: string;
  name: string;
  description?: string;
  status?: OrganizationStatus;
};

/** Fully-resolved data ready for database insertion. */
export type NewOrganization = {
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: OrganizationStatus;
};

/** Partial update input. */
export type UpdateOrganizationInput = {
  name?: string;
  description?: string;
  status?: OrganizationStatus;
};
