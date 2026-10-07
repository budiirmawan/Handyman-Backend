/**
 * BE-03H — External / Vendor Workforce affiliation types.
 *
 * Connects an existing Workforce Profile (BE-03C) to an External Organization
 * (BE-03H reference):
 *
 *   Workforce Profile → External Workforce Link → External Organization
 *
 * The link is the *vendor affiliation*: which external organization supplies
 * this person, under which of the vendor's own personnel codes, since when,
 * until when, and whether the affiliation is currently ACTIVE.
 *
 * External workforce must be able to exist entirely without a User account:
 * creating an affiliation never creates credentials and never grants Role,
 * Permission, or Building access. Those slices (BE-01 / BE-02F) are not
 * touched by this module in either direction.
 *
 * A Workforce Profile must be of type `EXTERNAL` to hold an affiliation. A
 * profile may hold at most one ACTIVE affiliation per External Organization,
 * while deactivated history is retained.
 */

export const EXTERNAL_WORKFORCE_LINK_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type ExternalWorkforceLinkStatus =
  (typeof EXTERNAL_WORKFORCE_LINK_STATUSES)[number];

export function isExternalWorkforceLinkStatus(
  value: unknown,
): value is ExternalWorkforceLinkStatus {
  return (
    typeof value === 'string' &&
    (EXTERNAL_WORKFORCE_LINK_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type ExternalWorkforceLinkRecord = {
  id: string;
  workforceProfileId: string;
  externalOrganizationId: string;
  externalPersonnelCode: string;
  status: ExternalWorkforceLinkStatus;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicExternalWorkforceLink = {
  id: string;
  workforceProfileId: string;
  externalOrganizationId: string;
  externalPersonnelCode: string;
  status: ExternalWorkforceLinkStatus;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
};

/** Input supplied by the API consumer when creating an affiliation. */
export type CreateExternalWorkforceLinkInput = {
  workforceProfileId: string;
  externalOrganizationId: string;
  externalPersonnelCode: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: ExternalWorkforceLinkStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewExternalWorkforceLink = {
  workforceProfileId: string;
  externalOrganizationId: string;
  externalPersonnelCode: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: ExternalWorkforceLinkStatus;
};

/** Partial update input. Deactivation is `status: 'INACTIVE'`. */
export type UpdateExternalWorkforceLinkInput = {
  externalPersonnelCode?: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: ExternalWorkforceLinkStatus;
};
