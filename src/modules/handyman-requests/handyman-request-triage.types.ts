import type { ServiceInspectionPolicy } from '../service-catalog/service-catalog.types';
/**
 * CR-HM-03 PART 01 — Handyman request triage types (FROZEN F1/F2/F6/F7).
 *
 * The triage decision record carries ONLY the F2-minimum facts — request
 * reference, disposition, concise note, authenticated actor, server
 * timestamp, plus the owner-authorized service-policy provenance. The note
 * alone is not direct authorization: explicit clarity and a separate reason
 * are required for DIAGNOSIS. No
 * diagnosis content, scope classification, specialist target, provider, or
 * quotation lives on this record. Service-specific direct-quotation
 * eligibility is now snapshotted alongside explicit Operations confirmation.
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
  /** Null on historical rows: no synthetic authorization/backfill. */
  serviceInspectionPolicy: ServiceInspectionPolicy | null;
  policyServiceCatalogId: string | null;
  policyCatalogUpdatedAt: Date | null;
  scopeClarityConfirmed: boolean | null;
  directQuotationReason: string | null;
  /** Local authenticated actor ONLY (FROZEN F7 — never PIC/attribution-derived). */
  actorUserId: string;
  createdAt: Date;
};

/** Input (client/context/PIC are NOT input — the request row is the authority). */
export type CreateHandymanRequestTriageInput = {
  handymanRequestId: string;
  /** Omitted means inspection-first; DIAGNOSIS must be an explicit choice. */
  triageDisposition?: HandymanTriageDisposition;
  /** Required triage note; never sufficient direct-quotation authority. */
  triageNote: string;
  scopeClarityConfirmed?: boolean;
  directQuotationReason?: string;
};

/** Fully-resolved data ready for persistence (snapshot + actor applied). */
export type NewHandymanRequestTriageRecord = Omit<
  HandymanRequestTriageDecisionRecord,
  'id' | 'createdAt'
>;

/** Safe public representation (createdAt ISO). */
export type PublicHandymanRequestTriage = Omit<
  HandymanRequestTriageDecisionRecord,
  'createdAt' | 'policyCatalogUpdatedAt'
> & {
  createdAt: string;
  policyCatalogUpdatedAt: string | null;
};
