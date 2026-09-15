/**
 * BE-18F — Reading Evidence domain types.
 *
 * Binds a BE-18E Meter Reading to the existing BE-07 shared evidence engine
 * (`evidence_requirements` + `evidence_submissions`). No separate utility
 * evidence engine is created: reading requirements target
 * `target_type = 'UTILITY_METER_READING'`, and submissions use
 * `execution_type = 'UTILITY_METER_READING'` with
 * `execution_id = utility_meter_reading id`.
 *
 * File bytes never touch PostgreSQL — `fileReference` is the existing BE-07
 * storage pointer convention (e.g. `object-storage://...`), and the engine's
 * 50 MB `file_size` ceiling still applies.
 *
 * Consumption (BE-18G) is out of scope.
 */

/** The BE-07 evidence types, reused verbatim — BE-18F adds none. */
export const UTILITY_METER_READING_EVIDENCE_TYPES = [
  'PHOTO',
  'DOCUMENT',
  'SIGNATURE',
] as const;

export type UtilityMeterReadingEvidenceType =
  (typeof UTILITY_METER_READING_EVIDENCE_TYPES)[number];

export function isUtilityMeterReadingEvidenceType(
  value: unknown,
): value is UtilityMeterReadingEvidenceType {
  return (
    typeof value === 'string' &&
    (UTILITY_METER_READING_EVIDENCE_TYPES as readonly string[]).includes(value)
  );
}

/** A BE-07 evidence requirement bound to a Meter Reading. */
export type PublicUtilityMeterReadingEvidenceRequirement = {
  id: string;
  clientId: string;
  meterReadingId: string;
  evidenceType: UtilityMeterReadingEvidenceType;
  required: boolean;
  minimumCount: number;
  maximumCount: number | null;
  description: string | null;
  status: string;
};

/** A BE-07 evidence submission bound to a Meter Reading. */
export type PublicUtilityMeterReadingEvidence = {
  id: string;
  clientId: string;
  meterReadingId: string;
  evidenceRequirementId: string | null;
  evidenceType: UtilityMeterReadingEvidenceType;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt: string | null;
  submittedByUserId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

/** Input for submitting Reading Evidence. */
export type SubmitUtilityMeterReadingEvidenceInput = {
  meterReadingId: string;
  /** Resolved by the service from the Meter Reading; callers may omit it. */
  clientId?: string;
  evidenceType: UtilityMeterReadingEvidenceType;
  evidenceRequirementId?: string;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt?: string;
  submittedByUserId: string;
};

/** List filters for GET /utility/meter-reading-evidence. */
export type UtilityMeterReadingEvidenceFilters = {
  meterReadingId?: string;
  meterId?: string;
  buildingId?: string;
};

/**
 * Whether every required BE-07 requirement on a reading has enough ACTIVE
 * submissions. Reported, never enforced as a side effect — BE-18F validates
 * evidence, it does not gate the reading (readings stay append-only).
 */
export type UtilityMeterReadingEvidenceReadiness = {
  meterReadingId: string;
  ready: boolean;
  missingEvidenceTypes: string[];
  requirements: {
    evidenceRequirementId: string;
    evidenceType: UtilityMeterReadingEvidenceType;
    required: boolean;
    minimumCount: number;
    maximumCount: number | null;
    activeCount: number;
    satisfied: boolean;
  }[];
};
