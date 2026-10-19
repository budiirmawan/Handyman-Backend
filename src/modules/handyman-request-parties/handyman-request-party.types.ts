/**
 * CR-HM-MASTER-IND-01 — request-level party designations.
 *
 * A canonical Handyman request already distinguishes its CREATOR (the
 * authenticated Backend user) from the REPRESENTED Tenant (immutable channel
 * attribution). Two further commercial roles are independent of both and are
 * recorded explicitly here:
 *
 *   APPROVAL              — who approves on the customer side
 *   COST_RESPONSIBILITY   — who bears the cost
 *
 * Each is a party from the existing individual/legal-entity master, never a
 * user identity and never inferred from the creator. Rows are append-only
 * (migration 0456): a designation is a recorded fact.
 */
export const HANDYMAN_REQUEST_PARTY_ROLES = [
  'APPROVAL',
  'COST_RESPONSIBILITY',
] as const;

export type HandymanRequestPartyRole =
  (typeof HANDYMAN_REQUEST_PARTY_ROLES)[number];

export function isHandymanRequestPartyRole(
  value: unknown,
): value is HandymanRequestPartyRole {
  return (
    typeof value === 'string' &&
    (HANDYMAN_REQUEST_PARTY_ROLES as readonly string[]).includes(value)
  );
}

export type HandymanRequestPartyRecord = {
  id: string;
  clientId: string;
  requestId: string;
  partyRole: HandymanRequestPartyRole;
  tenantCompanyId: string;
  tenantCode: string;
  tenantName: string;
  partyKind: string;
  tenantPicId: string | null;
  tenantPicName: string | null;
  createdByUserId: string;
  createdAt: Date;
};

export type PublicHandymanRequestParty = Omit<
  HandymanRequestPartyRecord,
  'createdAt'
> & { createdAt: string };

export type NewHandymanRequestParty = {
  clientId: string;
  requestId: string;
  partyRole: HandymanRequestPartyRole;
  tenantCompanyId: string;
  tenantPicId: string | null;
  createdByUserId: string;
};
