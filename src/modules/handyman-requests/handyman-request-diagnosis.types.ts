import type { HandymanDisciplineScopeClass } from '../handyman-disciplines';
import type { HandymanServiceRequestStatus } from './handyman-service-request.types';

/**
 * CR-HM-03 PART 03 — Handyman diagnosis + scope classification types
 * (FROZEN F4/F9).
 *
 * The classification is SERVER-DERIVED from `discipline.scopeClass`. The
 * caller NEVER independently chooses a classification; any caller-supplied
 * classification field is structurally ignored.
 */

export const HANDYMAN_SCOPE_CLASSIFICATIONS = [
  'GENERAL_HANDYMAN',
  'SPECIALIST_REQUIRED',
  'OUT_OF_HANDYMAN_SCOPE',
] as const;
export type HandymanScopeClassification =
  (typeof HANDYMAN_SCOPE_CLASSIFICATIONS)[number];

/** F4/F9.7 derivation: discipline.scopeClass → diagnosis classification. */
export const SCOPE_CLASS_TO_CLASSIFICATION: Record<
  HandymanDisciplineScopeClass,
  HandymanScopeClassification
> = {
  GENERAL_HANDYMAN: 'GENERAL_HANDYMAN',
  SPECIALIST: 'SPECIALIST_REQUIRED',
  OUT_OF_HANDYMAN_SCOPE: 'OUT_OF_HANDYMAN_SCOPE',
};

/**
 * F1 projection derived from `discipline.scopeClass`. `REFERRED` is
 * terminal in CR-HM-03 (F5); no execution/quotation/provider vocabulary.
 */
export const SCOPE_CLASS_TO_REQUEST_STATUS: Record<
  HandymanDisciplineScopeClass,
  HandymanServiceRequestStatus
> = {
  GENERAL_HANDYMAN: 'READY_FOR_NEXT_STEP',
  SPECIALIST: 'READY_FOR_NEXT_STEP',
  OUT_OF_HANDYMAN_SCOPE: 'REFERRED',
};

/** FROZEN F2 diagnosis record (immutable/append-oriented; minimum fields). */
export type HandymanRequestDiagnosisRecord = {
  id: string;
  clientId: string;
  /** Parent authority: the CR-HM-02 Handyman request. */
  handymanRequestId: string;
  channelAttributionId: string;
  buildingId: string;
  /** F9 registry reference (authoritative ID + verbatim code snapshot). */
  handymanDisciplineId: string;
  disciplineCode: string;
  diagnosis: string;
  /** Server-derived snapshot — NEVER caller-supplied. */
  scopeClassification: HandymanScopeClassification;
  recommendedServiceCatalogId: string | null;
  diagnosedByUserId: string;
  diagnosedAt: Date;
};

/** Caller input — classification/context/snapshot fields are NEVER input. */
export type CreateHandymanDiagnosisInput = {
  handymanRequestId: string;
  disciplineId: string;
  diagnosis: string;
  recommendedServiceCatalogId?: string | null;
};

export type NewHandymanRequestDiagnosisRecord = Omit<
  HandymanRequestDiagnosisRecord,
  'id' | 'diagnosedAt'
>;

/** Safe public representation (diagnosedAt ISO). */
export type PublicHandymanRequestDiagnosis = Omit<
  HandymanRequestDiagnosisRecord,
  'diagnosedAt'
> & {
  diagnosedAt: string;
};
