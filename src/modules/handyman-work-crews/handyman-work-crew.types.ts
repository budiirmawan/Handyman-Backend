/**
 * CR-HM-BE-04 RUN 1 — Handyman Work Crew domain types.
 *
 * The crew is the minimum NEW Handyman execution-composition concept:
 *
 *   Provider (existing CR-HM-BE-02 designation) → Crew
 *     → Membership (LEAD_WORKER | HELPER)
 *       → existing Vendor Workforce Binding (BE-06F)
 *         → existing Workforce Profile (BE-03C, EXTERNAL)
 *
 * No person master, provider master, building eligibility, schedule, permit,
 * WorkSession, or attendance concept is defined here — memberships hold
 * REFERENCES to existing authorities only (the permit_workers idiom).
 *
 * A HELPER (and structurally a LEAD_WORKER too, in BE-04) never requires a
 * User account: crew membership creates no user, credential, role,
 * permission, or building access. A future authenticated mobile Lead Worker
 * uses the existing nullable unique `workforce_profiles.user_id` link.
 */

export const HANDYMAN_WORK_CREW_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type HandymanWorkCrewStatus =
  (typeof HANDYMAN_WORK_CREW_STATUSES)[number];

export function isHandymanWorkCrewStatus(
  value: unknown,
): value is HandymanWorkCrewStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_WORK_CREW_STATUSES as readonly string[]).includes(value)
  );
}

export const HANDYMAN_WORK_CREW_ROLES = ['LEAD_WORKER', 'HELPER'] as const;

export type HandymanWorkCrewRole = (typeof HANDYMAN_WORK_CREW_ROLES)[number];

export function isHandymanWorkCrewRole(
  value: unknown,
): value is HandymanWorkCrewRole {
  return (
    typeof value === 'string' &&
    (HANDYMAN_WORK_CREW_ROLES as readonly string[]).includes(value)
  );
}

export const HANDYMAN_WORK_CREW_MEMBER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type HandymanWorkCrewMemberStatus =
  (typeof HANDYMAN_WORK_CREW_MEMBER_STATUSES)[number];

/** Full database record of a crew. */
export type HandymanWorkCrewRecord = {
  id: string;
  clientId: string;
  handymanProviderId: string;
  crewCode: string;
  crewName: string;
  status: HandymanWorkCrewStatus;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation of a crew. */
export type PublicHandymanWorkCrew = {
  id: string;
  clientId: string;
  handymanProviderId: string;
  crewCode: string;
  crewName: string;
  status: HandymanWorkCrewStatus;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** Full database record of a membership (history rows included). */
export type HandymanWorkCrewMemberRecord = {
  id: string;
  clientId: string;
  crewId: string;
  vendorWorkforceBindingId: string;
  crewRole: HandymanWorkCrewRole;
  status: HandymanWorkCrewMemberStatus;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  addedAt: Date;
  addedByUserId: string;
  removedAt: Date | null;
  removedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation of a membership. */
export type PublicHandymanWorkCrewMember = {
  id: string;
  clientId: string;
  crewId: string;
  vendorWorkforceBindingId: string;
  crewRole: HandymanWorkCrewRole;
  status: HandymanWorkCrewMemberStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  addedAt: string;
  addedByUserId: string;
  removedAt: string | null;
  removedByUserId: string | null;
};

/**
 * Input supplied by the caller when creating a crew. The FIRST Lead Worker
 * binding is REQUIRED: an operational ACTIVE crew must never exist with zero
 * active leads, and no preparation-before-activation convention exists — so
 * the crew and its founding lead membership are created atomically.
 * `createdByUserId` is never part of the input (actor comes from the
 * authenticated context).
 */
export type CreateHandymanWorkCrewInput = {
  clientId: string;
  handymanProviderId: string;
  crewCode: string;
  crewName: string;
  leadWorkerBindingId: string;
};

/** Mutable crew metadata (identity code and provider are immutable). */
export type UpdateHandymanWorkCrewInput = {
  crewName: string;
};

export type UpdateHandymanWorkCrewStatusInput = {
  status: HandymanWorkCrewStatus;
};

/** Input for seating a worker on a crew (helper, or lead via change-lead). */
export type AddHandymanWorkCrewMemberInput = {
  vendorWorkforceBindingId: string;
  crewRole: HandymanWorkCrewRole;
};

/** Atomic lead replacement input (avoids any zero-lead intermediate). */
export type ChangeHandymanWorkCrewLeadInput = {
  newLeadWorkerBindingId: string;
};

export type HandymanWorkCrewFilters = {
  handymanProviderId?: string;
  status?: HandymanWorkCrewStatus;
};

export type HandymanWorkCrewMemberFilters = {
  status?: HandymanWorkCrewMemberStatus;
};

/** Fully-resolved crew data ready for persistence. */
export type NewHandymanWorkCrew = {
  clientId: string;
  handymanProviderId: string;
  crewCode: string;
  crewName: string;
  status: HandymanWorkCrewStatus;
  createdByUserId: string;
  updatedByUserId: string;
};

/** Fully-resolved membership data ready for persistence. */
export type NewHandymanWorkCrewMember = {
  clientId: string;
  crewId: string;
  vendorWorkforceBindingId: string;
  crewRole: HandymanWorkCrewRole;
  status: HandymanWorkCrewMemberStatus;
  addedByUserId: string;
};

/**
 * Transactional worker-validation read: the binding joined with its person
 * master and the profile's client resolution (profile → organization →
 * client, the BE-06F chain). Consumed read-only — BE-04 never writes to
 * vendor_workforce_bindings, workforce_profiles, or organizations.
 */
export type CrewWorkerCandidate = {
  bindingId: string;
  bindingStatus: string;
  vendorId: string;
  workforceProfileId: string;
  profileStatus: string;
  workforceType: string;
  profileClientId: string;
};
