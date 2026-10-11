/**
 * CR-HM-03 PART 02 — Handyman inspection record types (FROZEN F1/F2/F3/F7).
 *
 * The inspection row carries the minimum structured record of ONE
 * inspection of ONE request: outcome + notes + actor + server timestamp.
 * Owner-approved revisit extension: immutable numbered physical attempts,
 * assignment provenance, structured unsuccessful reason and an optional
 * same-request intake evidence reference. No diagnosis or classification.
 */

/**
 * Minimal, inspection-specific outcome vocabulary. Vocabulary is about the
 * INSPECTION activity (the property was observed / it could not be
 * observed), never about diagnosis or scope classification.
 */
export const HANDYMAN_INSPECTION_RESULTS = [
  'INSPECTED',
  'NOT_INSPECTABLE',
] as const;
export type HandymanInspectionResult =
  (typeof HANDYMAN_INSPECTION_RESULTS)[number];

export function isHandymanInspectionResult(
  value: unknown,
): value is HandymanInspectionResult {
  return (
    typeof value === 'string' &&
    (HANDYMAN_INSPECTION_RESULTS as readonly string[]).includes(value)
  );
}

export const UNSUCCESSFUL_INSPECTION_REASONS = ['ACCESS_DENIED', 'CUSTOMER_UNAVAILABLE', 'UNSAFE_SITE', 'SITE_NOT_READY', 'OTHER'] as const;
export type UnsuccessfulInspectionReason = (typeof UNSUCCESSFUL_INSPECTION_REASONS)[number];

/** FROZEN F2 inspection record (immutable/append-oriented; minimum fields). */
export type HandymanRequestInspectionRecord = {
  id: string;
  /** Tenant-isolation root, snapshotted verbatim from the request row. */
  clientId: string;
  /** Parent authority: the CR-HM-02 Handyman request. */
  handymanRequestId: string;
  /** Provenance handle, snapshotted verbatim from the request row. */
  channelAttributionId: string;
  buildingId: string;
  inspectionResult: HandymanInspectionResult;
  inspectionNotes: string;
  unsuccessfulReason?: UnsuccessfulInspectionReason | null;
  evidenceSubmissionId?: string | null;
  /** Local authenticated actor ONLY (FROZEN F7 — never PIC/attribution-derived). */
  inspectedByUserId: string;
  inspectedAt: Date;
  attemptNumber: number;
  revisitAttemptId: string | null;
  inspectionAssignmentId: string | null;
};

/** Caller input — context/snapshot fields are NEVER input. */
export type CreateHandymanInspectionInput = {
  handymanRequestId: string;
  inspectionResult: HandymanInspectionResult;
  inspectionNotes: string;
  unsuccessfulReason?: UnsuccessfulInspectionReason | null;
  evidenceSubmissionId?: string | null;
};

/** Fully-resolved data ready for persistence (snapshot + actor applied). */
export type NewHandymanRequestInspectionRecord = Omit<
  HandymanRequestInspectionRecord,
  'id' | 'inspectedAt'
>;

/** Safe public representation (inspectedAt ISO). */
export type PublicHandymanRequestInspection = Omit<
  HandymanRequestInspectionRecord,
  'inspectedAt'
> & {
  inspectedAt: string;
};
