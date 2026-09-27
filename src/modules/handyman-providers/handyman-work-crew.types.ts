/**
 * CR-HM-04 PART 03 — Handyman Work Crew / Membership / Lead types
 * (FROZEN F3/F4/F5/F8).
 */

export const HANDYMAN_CREW_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type HandymanCrewStatus = (typeof HANDYMAN_CREW_STATUSES)[number];

export function isHandymanCrewStatus(
  value: unknown,
): value is HandymanCrewStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_CREW_STATUSES as readonly string[]).includes(value)
  );
}

/** Per-job operational grouping (F3) — NEVER the org `teams` entity. */
export type HandymanWorkCrewRecord = {
  id: string;
  clientId: string;
  handymanProviderContextId: string;
  code: string;
  name: string;
  status: HandymanCrewStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type HandymanCrewMembershipRecord = {
  id: string;
  clientId: string;
  handymanCrewId: string;
  handymanWorkerContextId: string;
  status: HandymanCrewStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Append-only lead designation fact (F4); current = MAX(leadSeq). */
export type HandymanCrewLeadRecord = {
  id: string;
  leadSeq: number;
  clientId: string;
  handymanCrewId: string;
  handymanCrewMembershipId: string;
  designatedByUserId: string;
  designatedAt: Date;
};

export type NewHandymanWorkCrewRecord = Omit<
  HandymanWorkCrewRecord,
  'id' | 'status' | 'createdAt' | 'updatedAt'
>;
export type NewHandymanCrewMembershipRecord = Omit<
  HandymanCrewMembershipRecord,
  'id' | 'status' | 'createdAt' | 'updatedAt'
>;
export type NewHandymanCrewLeadRecord = Omit<
  HandymanCrewLeadRecord,
  'id' | 'leadSeq' | 'designatedAt'
>;

export type PublicHandymanWorkCrew = Omit<
  HandymanWorkCrewRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };
export type PublicHandymanCrewMembership = Omit<
  HandymanCrewMembershipRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };
export type PublicHandymanCrewLead = Omit<
  HandymanCrewLeadRecord,
  'designatedAt'
> & { designatedAt: string };

/**
 * Transactional crew creation input (F4 paradox rule): every new crew is
 * ACTIVE only because its initial Lead member is validated in the SAME
 * transaction.
 */
export type CreateHandymanWorkCrewInput = {
  handymanProviderContextId: string;
  code: string;
  name: string;
  leadWorkerContextId: string;
};

export type AddHandymanCrewMemberInput = {
  handymanCrewId: string;
  handymanWorkerContextId: string;
};

export type DesignateHandymanCrewLeadInput = {
  handymanCrewId: string;
  handymanWorkerContextId: string;
};
