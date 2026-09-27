/**
 * CR-HM-03 PART 01 — Handyman request triage types (FROZEN F1/F2/F6/F7).
 *
 * The triage decision record carries ONLY the F2-minimum facts — request
 * reference, disposition, concise note, authenticated actor, server
 * timestamp. No diagnosis content, no scope classification, no specialist
 * target, no provider, no quotation — those arrive (or don't) in later
 * PARTs and never live on this record.
 */

/** FROZEN F1 triage dispositions: the ONLY bounded triage outcomes. */
export const HANDYMAN_TRIAGE_DISPOSITIONS = [
  'INSPECTION_REQUIRED',
  'DIAGNOSIS',
] as const;
export type HandymanTriageDisposition =
  (typeof HANDYMAN_TRIAGE_DISPOSITIONS)[number];

export function isHandymanTriageDisposition(
  value: unknown,
): value is HandymanTriageDisposition {
  return (
    typeof value === 'string' &&
    (HANDYMAN_TRIAGE_DISPOSITIONS as readonly string[]).includes(value)
  );
}

/** FROZEN F2 decision record (immutable/append-oriented; minimum fields). */
export type HandymanRequestTriageDecisionRecord = {
  id: string;
  /** Tenant-isolation root, snapshotted verbatim from the request row. */
  clientId: string;
  /** Parent authority: the CR-HM-02 Handyman request. */
  handymanRequestId: string;
  /** Provenance handle, snapshotted verbatim from the request row. */
  channelAttributionId: string;
  buildingId: string;
  triageDisposition: HandymanTriageDisposition;
  triageNote: string;
  /** Local authenticated actor ONLY (FROZEN F7 — never PIC/attribution-derived). */
  actorUserId: string;
  createdAt: Date;
};

/** Input (client/context/PIC are NOT input — the request row is the authority). */
export type CreateHandymanRequestTriageInput = {
  handymanRequestId: string;
  triageDisposition: HandymanTriageDisposition;
  triageNote: string;
};

/** Fully-resolved data ready for persistence (snapshot + actor applied). */
export type NewHandymanRequestTriageRecord = Omit<
  HandymanRequestTriageDecisionRecord,
  'id' | 'createdAt'
>;

/** Safe public representation (createdAt ISO). */
export type PublicHandymanRequestTriage = Omit<
  HandymanRequestTriageDecisionRecord,
  'createdAt'
> & {
  createdAt: string;
};
