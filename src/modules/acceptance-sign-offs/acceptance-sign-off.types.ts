/**
 * BE-22E — Acceptance / Sign-Off.
 * Sign-Off belongs to valid BAST / Handover context, supports INTERNAL / TENANT / VENDOR,
 * records authorized signer, decision and timestamp, preserves history.
 * Reuses BAST/Handover masters — no separate approval engine.
 */

export const SIGN_OFF_DECISIONS = ['ACCEPTED', 'REJECTED'] as const;
export type SignOffDecision = (typeof SIGN_OFF_DECISIONS)[number];
export function isSignOffDecision(v: unknown): v is SignOffDecision {
  return typeof v === 'string' && (SIGN_OFF_DECISIONS as readonly string[]).includes(v);
}

export type AcceptanceSignOffRecord = {
  id: string;
  bastDocumentId: string | null;
  handoverDocumentId: string | null;
  bastSubmissionAttemptId: string | null;
  documentVersionId: string | null;
  clientId: string;
  buildingId: string;
  contextType: 'INTERNAL' | 'TENANT' | 'VENDOR';
  decision: SignOffDecision;
  signerUserId: string;
  notes: string | null;
  signedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicAcceptanceSignOff = {
  id: string;
  bastDocumentId: string | null;
  handoverDocumentId: string | null;
  bastSubmissionAttemptId: string | null;
  documentVersionId: string | null;
  clientId: string;
  buildingId: string;
  contextType: 'INTERNAL' | 'TENANT' | 'VENDOR';
  decision: SignOffDecision;
  signerUserId: string;
  notes: string | null;
  signedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateAcceptanceSignOffInput = {
  bastDocumentId?: string | null;
  handoverDocumentId?: string | null;
  decision: SignOffDecision;
  notes?: string | null;
};

export type AcceptanceSignOffFilters = {
  bastDocumentId?: string;
  handoverDocumentId?: string;
  buildingId?: string;
  contextType?: 'INTERNAL' | 'TENANT' | 'VENDOR';
  decision?: SignOffDecision;
  clientId?: string;
  signerUserId?: string;
};
