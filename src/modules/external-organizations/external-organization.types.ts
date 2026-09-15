/**
 * BE-03H — External Organization reference types.
 *
 * The minimum external organization (vendor / external workforce supplier)
 * reference required by the external workforce affiliation. This is NOT a
 * full Vendor module: there are no registration, approval, or contract
 * workflows here, and no API surface of its own in this Wave.
 *
 * An External Organization is scoped to a single Client, mirroring the
 * BE-03A `organizations` shape so a future Vendor module can grow from this
 * reference without a rewrite.
 */

export const EXTERNAL_ORGANIZATION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type ExternalOrganizationStatus =
  (typeof EXTERNAL_ORGANIZATION_STATUSES)[number];

export function isExternalOrganizationStatus(
  value: unknown,
): value is ExternalOrganizationStatus {
  return (
    typeof value === 'string' &&
    (EXTERNAL_ORGANIZATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record of the external organization reference. */
export type ExternalOrganizationRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  status: ExternalOrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
};
