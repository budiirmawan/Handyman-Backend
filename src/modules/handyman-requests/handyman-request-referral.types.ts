import type { HandymanScopeClassification } from './handyman-request-diagnosis.types';

/**
 * CR-HM-03 PART 04 — Handyman referral record types (FROZEN F4/F5/F9).
 *
 * The referral is the downstream handoff fact derived from the
 * authoritative PART 03 diagnosis. The caller NEVER picks a referral type
 * or a target discipline — both are derived verbatim from the diagnosis.
 */

export const HANDYMAN_REFERRAL_TYPES = ['SPECIALIST', 'OUT_OF_SCOPE'] as const;
export type HandymanReferralType = (typeof HANDYMAN_REFERRAL_TYPES)[number];

/** F5/F9 derivation: diagnosis classification → referral type. */
export const CLASSIFICATION_TO_REFERRAL_TYPE: Record<
  'SPECIALIST_REQUIRED' | 'OUT_OF_HANDYMAN_SCOPE',
  HandymanReferralType
> = {
  SPECIALIST_REQUIRED: 'SPECIALIST',
  OUT_OF_HANDYMAN_SCOPE: 'OUT_OF_SCOPE',
};

/** Eligibility lives on the diagnosis classification only. */
export function isReferralEligibleClassification(
  value: HandymanScopeClassification,
): value is 'SPECIALIST_REQUIRED' | 'OUT_OF_HANDYMAN_SCOPE' {
  return value === 'SPECIALIST_REQUIRED' || value === 'OUT_OF_HANDYMAN_SCOPE';
}

/** FROZEN F2 referral record (immutable/append-oriented; minimum fields). */
export type HandymanRequestReferralRecord = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  channelAttributionId: string;
  buildingId: string;
  /** Source authority: the immutable PART 03 diagnosis row. */
  handymanDiagnosisId: string;
  referralType: HandymanReferralType;
  /** Target discipline verbatim from diagnosis authority (id + code). */
  handymanDisciplineId: string;
  disciplineCode: string;
  referralNote: string;
  referredByUserId: string;
  referredAt: Date;
};

/** Caller input — type/target/context/snapshot fields are NEVER input. */
export type CreateHandymanReferralInput = {
  handymanRequestId: string;
  referralNote: string;
};

export type NewHandymanRequestReferralRecord = Omit<
  HandymanRequestReferralRecord,
  'id' | 'referredAt'
>;

/** Safe public representation (referredAt ISO). */
export type PublicHandymanRequestReferral = Omit<
  HandymanRequestReferralRecord,
  'referredAt'
> & {
  referredAt: string;
};
