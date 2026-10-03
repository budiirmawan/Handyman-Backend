/**
 * CR-HM-11 PART 03 — published BAST/acceptance READ contract for
 * CR-HM-15 / CR-HM-17 / CR-HM-18. Projects PART 01–02 authority
 * only. NOT a second write path. NOT warranty runtime. NOT ledger.
 * NOT FM BAST. Session COMPLETE / quotation approval / QC PASS are
 * never mapped to customer acceptance.
 *
 * CR-HM-17 P1 FIX01 — adds Backend-owned `artifactRef` (versioned
 * viewable reference) and `approvedSignOff` binding (signature-
 * evidence pair required for sign-off). The artifact is computed
 * server-side; the Frontend MUST NOT generate or forge it.
 */

import type {
  HandymanBastEventRecord,
  HandymanBastRecord,
  HandymanBastSignOffRecord,
  HandymanBastStatus,
} from './handyman-bast.types';

/** Frozen aliases that MUST NOT be treated as BAST Acceptance. */
export const HANDYMAN_NOT_BAST_ACCEPTANCE = [
  'SESSION_COMPLETE',
  'CHECK_OUT',
  'QUOTATION_APPROVAL',
  'QC_PASS',
  'FM_BAST_STATUS',
] as const;

export type HandymanNotBastAcceptance =
  (typeof HANDYMAN_NOT_BAST_ACCEPTANCE)[number];

/**
 * CR-HM-17 P1 FIX01 — Backend-owned, versioned BAST artifact
 * reference. The `ref` is computed server-side from the BAST
 * identity and status-derived version; it MUST NOT be generated
 * or forged by the Frontend. Each status transition produces a
 * new immutable version so consumers can track the authoritative
 * artifact.
 */
export type HandymanBastArtifactReference = {
  ref: string;
  bastId: string;
  version: number;
  status: HandymanBastStatus;
};

/**
 * Status → artifact version mapping (deterministic).
 * DRAFT → 1, ISSUED → 2, ACCEPTED/REJECTED → 3, VOID → 2.
 */
export function computeBastArtifactVersion(
  status: HandymanBastStatus,
): number {
  switch (status) {
    case 'DRAFT': return 1;
    case 'ISSUED': return 2;
    case 'ACCEPTED': return 3;
    case 'REJECTED': return 3;
    case 'VOID': return 2;
    default: return 0;
  }
}

export function toHandymanBastArtifactReference(
  bast: HandymanBastRecord,
): HandymanBastArtifactReference {
  const version = computeBastArtifactVersion(bast.status);
  return {
    ref: `BAST/${bast.id}/v${version}`,
    bastId: bast.id,
    version,
    status: bast.status,
  };
}

/**
 * CR-HM-17 P1 FIX01 — approved signature-evidence binding.
 * Present only when BAST status is ACCEPTED and the ACCEPT sign-off
 * carries both a signature digest AND a bound evidence record.
 * Required for sign-off completion; the Frontend MUST NOT accept
 * BAST sign-off without this binding being present.
 */
export type HandymanBastApprovedSignOffBinding = {
  signOffId: string;
  eventId: string;
  signatureDigest: string;
  evidenceRecordId: string | null;
  actorUserId: string;
  occurredAt: Date;
  createdAt: Date;
};

/**
 * Resolve the ACCEPT sign-off from the event chain. Returns null
 * if the BAST is not ACCEPTED or no ACCEPT sign-off is found.
 */
export function resolveApprovedSignOff(
  bast: HandymanBastRecord,
  events: HandymanBastEventRecord[],
  signOffs: HandymanBastSignOffRecord[],
): HandymanBastApprovedSignOffBinding | null {
  if (bast.status !== 'ACCEPTED') return null;
  const acceptEvent = events.find((e) => e.eventType === 'ACCEPT');
  if (!acceptEvent) return null;
  const signOff = signOffs.find(
    (s) => s.eventId === acceptEvent.id && s.decision === 'ACCEPT',
  );
  if (!signOff) return null;
  return {
    signOffId: signOff.id,
    eventId: acceptEvent.id,
    signatureDigest: signOff.signatureDigest,
    evidenceRecordId: signOff.evidenceRecordId,
    actorUserId: acceptEvent.actorUserId,
    occurredAt: acceptEvent.occurredAt,
    createdAt: signOff.createdAt,
  };
}

/**
 * Bounded public read shape. `status` is the sole acceptance
 * authority (sign-off rows are evidence, never truth).
 *
 * CR-HM-17 P1 FIX01 adds:
 * - `artifactRef`: backend-owned versioned artifact reference.
 * - `approvedSignOff`: signature-evidence binding for ACCEPTED.
 * - `signOffComplete`: true iff ACCEPTED and binding is present.
 */
export type HandymanBastAcceptanceReadContract = {
  bastId: string;
  clientId: string;
  executionScopeId: string;
  status: HandymanBastStatus;
  customerAccepted: boolean;
  warrantyStartEligible: boolean;
  issuedAt: Date | null;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
  voidedAt: Date | null;
  artifactRef: string;
  approvedSignOff: HandymanBastApprovedSignOffBinding | null;
  signOffComplete: boolean;
};

export function isHandymanCustomerBastAccepted(
  status: HandymanBastStatus,
): boolean {
  return status === 'ACCEPTED';
}

/** CR-HM-15 may start service warranty ONLY from ACCEPTED. */
export function isHandymanWarrantyStartEligible(
  status: HandymanBastStatus,
): boolean {
  return status === 'ACCEPTED';
}

export function isNotBastAcceptanceAlias(
  value: string,
): value is HandymanNotBastAcceptance {
  return (HANDYMAN_NOT_BAST_ACCEPTANCE as readonly string[])
    .includes(value);
}

export function toHandymanBastAcceptanceReadContract(
  bast: HandymanBastRecord,
  events: HandymanBastEventRecord[] = [],
  signOffs: HandymanBastSignOffRecord[] = [],
): HandymanBastAcceptanceReadContract {
  const customerAccepted = isHandymanCustomerBastAccepted(bast.status);
  const artifact = toHandymanBastArtifactReference(bast);
  const approvedSignOff = resolveApprovedSignOff(
    bast,
    events,
    signOffs,
  );
  return {
    bastId: bast.id,
    clientId: bast.clientId,
    executionScopeId: bast.executionScopeId,
    status: bast.status,
    customerAccepted,
    warrantyStartEligible: isHandymanWarrantyStartEligible(bast.status),
    issuedAt: bast.issuedAt,
    acceptedAt: customerAccepted ? bast.acceptedAt : null,
    rejectedAt: bast.status === 'REJECTED' ? bast.rejectedAt : null,
    voidedAt: bast.status === 'VOID' ? bast.voidedAt : null,
    artifactRef: artifact.ref,
    approvedSignOff,
    signOffComplete: customerAccepted && approvedSignOff !== null
      && approvedSignOff.signatureDigest.length > 0,
  };
}
