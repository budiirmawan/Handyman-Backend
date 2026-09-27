/**
 * CR-HM-01 PART 02 — Trusted Handoff Context Resolution types.
 *
 * Input claims are assumed to have already passed a future trusted
 * handoff-origin authentication layer (D1/D2/D3 remain unresolved). The
 * resolver validates and canonicalizes context only: it never makes an
 * untrusted external payload trusted, and it performs NO persistence side
 * effects (no channel attribution, no session, no service request).
 *
 * Invariants preserved:
 *   customer identity != building authorization != unit/space authorization
 *   authenticated handoff origin != Handyman business authorization
 *   resolved context != Channel Attribution
 */

export type HandoffContextClaims = Readonly<{
  /** Canonical tenant company identifier from the trusted layer. */
  tenantCompanyId: string;
  /** Canonical building identifier from the trusted layer. */
  buildingId: string;
  /** Customer person (Tenant PIC) when supplied/applicable. */
  tenantPicId?: string;
  /** Unit/space when supplied. */
  spaceId?: string;
}>;

/**
 * Canonical server-side resolved context: persisted records/IDs only,
 * tenant-isolation root derived from the tenant company (never from claims).
 * Suitable for later handoff runtime, channel attribution creation, and
 * CR-HM-02 request binding; it grants no authority by itself.
 */
export type ResolvedHandoffContext = Readonly<{
  /** Tenant-isolation root, derived server-side. */
  clientId: string;
  tenantCompanyId: string;
  /** Resolved customer person, or null when not supplied. */
  tenantPicId: string | null;
  buildingId: string;
  /** Resolved unit/space, or null when not supplied. */
  spaceId: string | null;
  /** The ACTIVE tenant-building context record proving the relationship. */
  tenantBuildingContextId: string;
  /** The ACTIVE tenant-space relationship record, when a unit was supplied. */
  tenantSpaceRelationshipId: string | null;
  /**
   * Local User linked to the customer PIC, when one exists; informational
   * only — no session is created and no authorization is granted here.
   */
  resolvedUserId: string | null;
}>;
