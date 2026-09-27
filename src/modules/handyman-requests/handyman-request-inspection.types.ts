/**
 * CR-HM-03 PART 02 — Handyman inspection record types (FROZEN F1/F2/F3/F7).
 *
 * The inspection row carries the minimum structured record of ONE
 * inspection of ONE request: outcome + notes + actor + server timestamp.
 * It carries NO diagnosis, NO classification, NO specialist target, no
 * evidence references (FROZEN F3 — evidence defers to CR-HM-10).
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
  /** Local authenticated actor ONLY (FROZEN F7 — never PIC/attribution-derived). */
  inspectedByUserId: string;
  inspectedAt: Date;
};

/** Caller input — context/snapshot fields are NEVER input. */
export type CreateHandymanInspectionInput = {
  handymanRequestId: string;
  inspectionResult: HandymanInspectionResult;
  inspectionNotes: string;
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
