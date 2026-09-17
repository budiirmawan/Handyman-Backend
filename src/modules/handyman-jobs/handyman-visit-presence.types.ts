/**
 * CR-HM-BE-06 RUN 1 — Handyman visit crew presence types.
 *
 * Presence is VISIT-SCOPED and SNAPSHOT-BOUND: rows are created in the same
 * transaction as the visit's one VERIFIED arrival, exclusively from the
 * ACTIVE crew composition at that moment. Later crew membership changes
 * never rewrite the snapshot; only snapshot members are markable. Rows
 * carry the vendor workforce BINDING id and a role snapshot only — never a
 * worker name/contact/profile copy, never a users.id requirement for
 * helpers (helpers never authenticate), and never an HR attendance fact.
 */

/** Role snapshot taken from the ACTIVE composition at VERIFIED arrival. */
export const HANDYMAN_VISIT_PRESENCE_CREW_ROLES = [
  'LEAD_WORKER',
  'HELPER',
] as const;
export type HandymanVisitPresenceCrewRole =
  (typeof HANDYMAN_VISIT_PRESENCE_CREW_ROLES)[number];

/** Operational presence state of one snapshot member. */
export const HANDYMAN_VISIT_PRESENCE_STATUSES = [
  'PENDING',
  'PRESENT',
  'ABSENT',
] as const;
export type HandymanVisitPresenceStatus =
  (typeof HANDYMAN_VISIT_PRESENCE_STATUSES)[number];

export function isHandymanVisitPresenceStatus(
  value: unknown,
): value is HandymanVisitPresenceStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_VISIT_PRESENCE_STATUSES as readonly string[]).includes(value)
  );
}

/** The two markable states (PENDING is the snapshot's initial fact). */
export const HANDYMAN_VISIT_PRESENCE_MARKS = ['PRESENT', 'ABSENT'] as const;
export type HandymanVisitPresenceMark =
  (typeof HANDYMAN_VISIT_PRESENCE_MARKS)[number];

export function isHandymanVisitPresenceMark(
  value: unknown,
): value is HandymanVisitPresenceMark {
  return (
    typeof value === 'string' &&
    (HANDYMAN_VISIT_PRESENCE_MARKS as readonly string[]).includes(value)
  );
}

/**
 * Recording path attribution — a staff-assisted mark is an explicit
 * override with its own reason and recorder, never a silent impersonation
 * of the Lead Worker.
 */
export const HANDYMAN_VISIT_PRESENCE_RECORDED_VIA = [
  'LEAD',
  'STAFF_ASSISTED',
] as const;
export type HandymanVisitPresenceRecordedVia =
  (typeof HANDYMAN_VISIT_PRESENCE_RECORDED_VIA)[number];

/** Full database record of one snapshot member. */
export type HandymanVisitPresenceRecord = {
  id: string;
  clientId: string;
  handymanServiceVisitId: string;
  /** The one VERIFIED arrival whose transaction created this snapshot. */
  handymanVisitArrivalId: string;
  /** Frozen composition identity at snapshot time (assignment + crew). */
  handymanJobAssignmentId: string;
  handymanWorkCrewId: string;
  vendorWorkforceBindingId: string;
  crewRole: HandymanVisitPresenceCrewRole;
  presenceStatus: HandymanVisitPresenceStatus;
  recordedVia: HandymanVisitPresenceRecordedVia | null;
  recordedByUserId: string | null;
  recordedAt: Date | null;
  /** Mandatory non-empty reason for the STAFF_ASSISTED path only. */
  assistedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Safe public representation — binding id, role/status and attribution IDs
 * only. No worker PII of any kind (names/contacts/profiles never exist on
 * the row), and the assisted free-text reason stays on the record rather
 * than the read model.
 */
export type PublicHandymanVisitPresence = {
  id: string;
  clientId: string;
  handymanServiceVisitId: string;
  handymanVisitArrivalId: string;
  handymanJobAssignmentId: string;
  handymanWorkCrewId: string;
  vendorWorkforceBindingId: string;
  crewRole: HandymanVisitPresenceCrewRole;
  presenceStatus: HandymanVisitPresenceStatus;
  recordedVia: HandymanVisitPresenceRecordedVia | null;
  recordedByUserId: string | null;
  recordedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One snapshot row to insert (crew composition fact, IDs only). */
export type NewHandymanVisitPresence = {
  clientId: string;
  handymanServiceVisitId: string;
  handymanVisitArrivalId: string;
  handymanJobAssignmentId: string;
  handymanWorkCrewId: string;
  vendorWorkforceBindingId: string;
  crewRole: HandymanVisitPresenceCrewRole;
};

/** Lead field mark (the lead may mark themselves and any helper). */
export type RecordPresenceByLeadInput = {
  vendorWorkforceBindingId: string;
  presenceStatus: HandymanVisitPresenceMark;
};

/** Staff-assisted mark (explicit override, mandatory reason). */
export type RecordAssistedPresenceInput = {
  vendorWorkforceBindingId: string;
  presenceStatus: HandymanVisitPresenceMark;
  assistedReason: string;
};

/**
 * Pure execution-start presence evaluation (the Run-2 gate input): the
 * snapshot must exist (from the VERIFIED arrival) and the snapshot's Lead
 * Worker must be PRESENT. Helper states are operational facts only —
 * helper presence never gates execution start and no minimum-helper
 * staffing policy exists.
 */
export type HandymanVisitPresenceEvaluation = {
  handymanServiceVisitId: string;
  snapshotExists: boolean;
  leadPresent: boolean;
  /** The snapshot's lead binding id when a snapshot exists. */
  leadVendorWorkforceBindingId: string | null;
  members: {
    vendorWorkforceBindingId: string;
    crewRole: HandymanVisitPresenceCrewRole;
    presenceStatus: HandymanVisitPresenceStatus;
  }[];
};

/**
 * CR-HM-BE-06 RUN 3 — the gated presence READ view for the HTTP surface:
 * the pure evaluation scalars (Run-1/Run-2 gate facts) plus the attributed
 * public snapshot rows. Operational facts only — binding identity, the
 * FROZEN crew role, status, recording path/attribution and timestamps. No
 * worker PII exists on the rows, and the assisted free-text reason stays
 * off this read model (it lives on the arrival/presence evidence, exposed
 * only through the arrival public projection).
 */
export type HandymanVisitPresenceReadView = {
  handymanServiceVisitId: string;
  snapshotExists: boolean;
  leadPresent: boolean;
  leadVendorWorkforceBindingId: string | null;
  presence: PublicHandymanVisitPresence[];
};
