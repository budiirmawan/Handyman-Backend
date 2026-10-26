import { stableJson } from '../../shared/stable-json';
import { COMMERCIAL_CONSENT_METHOD, COMMERCIAL_CONSENT_PURPOSE, commercialConsentHash, freshCommercialConsent, parseCommercialConsentAssertion } from '../handyman-commercial-consent/commercial-consent.assertion';
import type { VerifiedCareConsent } from '../handyman-commercial-consent/commercial-consent.service';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isValidUuid } from '../clients';
import { createEvidenceStorage, isManagedStorageKey } from '../evidence/storage';
import { handymanEvidenceQcRepository } from '../handyman-evidence-qc/handyman-evidence-qc.repository';
import { handymanBastValidationError } from './handyman-bast.errors';
import { handymanBastRepository } from './handyman-bast.repository';
import type {
  HandymanBastEventRecord, HandymanBastRecord, HandymanBastSignOffRecord,
} from './handyman-bast.types';

/** Authenticated electronic consent, NOT a certified digital signature. */
export const HANDYMAN_BAST_CUSTOMER_CONSENT_PROTOCOL = 'HM-BAST-CUSTOMER-CONSENT-SHA256-V1';
export const HANDYMAN_BAST_CUSTOMER_CONSENT_METHOD = 'AUTHENTICATED_REQUEST_PIC';
export const HANDYMAN_BAST_CARE_CONSENT_PROTOCOL = 'HM-BAST-VERIFIED-CARE-CONSENT-SHA256-V1';

export type HandymanBastConsentEvidence = {
  recordId: string;
  finalizeEventId: string;
  files: Array<{
    id: string; mediaKind: string; contentType: string; byteSize: number; sha256Digest: string;
  }>;
};

type PersonalBastConsentManifest = {
  protocol: typeof HANDYMAN_BAST_CUSTOMER_CONSENT_PROTOCOL;
  bastId: string;
  executionScopeId: string;
  approvedQuotationVersionId: string;
  clientId: string;
  handymanRequestId: string;
  tenantCompanyId: string;
  tenantPicId: string;
  buildingId: string;
  issuedArtifactRef: string;
  issuedArtifactVersion: number;
  issueEventId: string;
  issuedAt: string;
  qcRunId: string;
  actorUserId: string;
  decision: 'ACCEPT' | 'REJECT';
  rejectReason: string | null;
  evidence: HandymanBastConsentEvidence | null;
};

export type HandymanBastCustomerConsentManifest = PersonalBastConsentManifest |
  (Omit<PersonalBastConsentManifest, 'protocol' | 'actorUserId' | 'tenantPicId'> & {
    protocol: typeof HANDYMAN_BAST_CARE_CONSENT_PROTOCOL;
    actorUserId: null; tenantPicId: string | null; spaceId: string | null;
    careConsent: VerifiedCareConsent;
  });

/**
 * Frozen V1 wire serialization: UTF-8 JSON of this ORDERED ARRAY, not a JSON
 * object, hex SHA-256 lowercase. Files sort by lowercase UUID, ascending ASCII.
 * IDs/timestamps come from existing BAST/scope/evidence reads, actor from the
 * personal session. Null evidence/reason are literal JSON null. No caller-sent
 * identity or manifest is authoritative. See PART 04's frontend handoff.
 */
export function serializeHandymanBastCustomerConsent(
  manifest: HandymanBastCustomerConsentManifest,
): string {
  const evidence = manifest.evidence;
  const fields: unknown[] = [
    manifest.protocol, manifest.bastId, manifest.executionScopeId, manifest.approvedQuotationVersionId, manifest.clientId,
    manifest.handymanRequestId, manifest.tenantCompanyId, manifest.tenantPicId,
    manifest.buildingId, manifest.issuedArtifactRef, manifest.issuedArtifactVersion,
    manifest.issueEventId, manifest.issuedAt, manifest.qcRunId, manifest.actorUserId,
    manifest.decision, manifest.rejectReason,
    evidence === null ? null : [
      evidence.recordId, evidence.finalizeEventId,
      [...evidence.files].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        .map((file) => [file.id, file.mediaKind, file.contentType, file.byteSize, file.sha256Digest]),
    ],
  ];
  // Keep personal V1 serialization byte-for-byte; JSONB key order cannot
  // affect the new immutable receipt's canonical serialization.
  if (manifest.protocol === HANDYMAN_BAST_CARE_CONSENT_PROTOCOL) fields.push(manifest.spaceId, stableJson(manifest.careConsent));
  return JSON.stringify(fields);
}

export function computeHandymanBastCustomerConsentDigest(
  manifest: HandymanBastCustomerConsentManifest,
): string {
  return createHash('sha256').update(serializeHandymanBastCustomerConsent(manifest), 'utf8').digest('hex');
}

/**
 * Optional consent attachment must be same-scope, finalized, nonempty and
 * backed by genuine managed bytes. The shared record lock serializes with the
 * existing FILE_ADD/FINALIZE commands. Files/events are DB-immutable; no new
 * evidence engine, upload endpoint or signature-verification claim is created.
 */
export async function readHandymanBastConsentEvidence(
  tx: Pick<PoolClient, 'query'>,
  evidenceRecordId: string | null,
  bast: HandymanBastRecord,
): Promise<HandymanBastConsentEvidence | null> {
  if (evidenceRecordId === null) return null;
  const result = await tx.query<{ id: string; client_id: string; execution_scope_id: string }>(
    `SELECT id, client_id, execution_scope_id FROM handyman_evidence_records
      WHERE id = $1 FOR SHARE`, [evidenceRecordId],
  );
  const record = result.rows[0];
  if (!record || record.execution_scope_id !== bast.executionScopeId || record.client_id !== bast.clientId) {
    throw handymanBastValidationError('evidenceRecordId', 'Evidence must belong to this BAST execution scope.');
  }
  const finalized = await handymanEvidenceQcRepository.findEvidenceFinalizeEventByRecord(tx, record.id);
  const files = await handymanEvidenceQcRepository.listEvidenceFilesByRecord(tx, record.id);
  if (!finalized || files.length === 0) {
    throw handymanBastValidationError('evidenceRecordId', 'Consent evidence must be finalized and contain verified files.');
  }
  const storage = createEvidenceStorage();
  for (const file of files) {
    if (!isManagedStorageKey(file.storageKey) || !/^[a-f0-9]{64}$/.test(file.sha256Digest)) {
      throw handymanBastValidationError('evidenceRecordId', 'Consent evidence has no trustworthy stored-byte reference.');
    }
    try {
      const stored = await storage.get(file.storageKey);
      const actualSha = createHash('sha256').update(stored.buffer).digest('hex');
      if (stored.size !== file.byteSize || stored.buffer.byteLength !== file.byteSize || actualSha !== file.sha256Digest) {
        throw new Error('Evidence byte integrity mismatch.');
      }
    } catch {
      throw handymanBastValidationError('evidenceRecordId', 'Consent evidence bytes are unavailable or do not match their immutable digest.');
    }
  }
  return {
    recordId: record.id, finalizeEventId: finalized.id,
    files: files.map(({ id, mediaKind, contentType, byteSize, sha256Digest }) =>
      ({ id, mediaKind, contentType, byteSize, sha256Digest })),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function validManifest(value: unknown): value is HandymanBastCustomerConsentManifest {
  const m = asObject(value);
  if (!m || ![HANDYMAN_BAST_CUSTOMER_CONSENT_PROTOCOL, HANDYMAN_BAST_CARE_CONSENT_PROTOCOL].includes(String(m.protocol)) ||
      !['ACCEPT', 'REJECT'].includes(String(m.decision))) return false;
  const care = m.protocol === HANDYMAN_BAST_CARE_CONSENT_PROTOCOL;
  if (care) {
    if (m.actorUserId !== null || (m.tenantPicId !== null && (typeof m.tenantPicId !== 'string' || !isValidUuid(m.tenantPicId))) ||
        (m.spaceId !== null && (typeof m.spaceId !== 'string' || !isValidUuid(m.spaceId)))) return false;
    const proof = asObject(m.careConsent);
    if (!proof || proof.method !== COMMERCIAL_CONSENT_METHOD ||
        !['id', 'integrationId', 'careActorId'].every(k => typeof proof[k] === 'string' && isValidUuid(proof[k] as string)) ||
        typeof proof.contractReference !== 'string' || !proof.contractReference.trim() || proof.contractReference.length > 200 ||
        typeof proof.recordedAt !== 'string' || iso(proof.recordedAt) !== proof.recordedAt) return false;
    const a = parseCommercialConsentAssertion(proof.assertion);
    if (!a || !freshCommercialConsent(a, new Date(proof.recordedAt)) || proof.assertionHash !== commercialConsentHash(a) || a.careActorId !== proof.careActorId ||
        a.targetType !== 'BAST' || a.targetId !== m.bastId || a.handymanRequestId !== m.handymanRequestId ||
        a.clientId !== m.clientId || a.tenantCompanyId !== m.tenantCompanyId || a.tenantPicId !== m.tenantPicId ||
        a.buildingId !== m.buildingId || a.spaceId !== m.spaceId || a.decision !== m.decision || a.rejectReason !== m.rejectReason ||
        a.targetDigest !== commercialConsentHash([COMMERCIAL_CONSENT_PURPOSE, 'BAST', m.bastId,
          m.executionScopeId, m.approvedQuotationVersionId, m.clientId, m.handymanRequestId,
          m.tenantCompanyId, m.tenantPicId, m.buildingId, m.spaceId, m.issuedArtifactRef,
          m.issuedArtifactVersion, m.issueEventId, m.issuedAt, m.qcRunId])) return false;
  } else if (m.careConsent !== undefined || typeof m.actorUserId !== 'string' || !isValidUuid(m.actorUserId) ||
      typeof m.tenantPicId !== 'string' || !isValidUuid(m.tenantPicId)) return false;
  for (const field of [
    'bastId', 'executionScopeId', 'approvedQuotationVersionId', 'clientId', 'handymanRequestId', 'tenantCompanyId',
    'buildingId', 'issueEventId', 'qcRunId',
  ]) if (typeof m[field] !== 'string' || !isValidUuid(m[field] as string)) return false;
  if (m.issuedArtifactVersion !== 2 || m.issuedArtifactRef !== `BAST/${m.bastId}/v2` ||
      typeof m.issuedAt !== 'string' || iso(m.issuedAt) !== m.issuedAt ||
      (m.rejectReason !== null && (typeof m.rejectReason !== 'string' || m.rejectReason.length > 2000)) ||
      (m.decision === 'ACCEPT' && m.rejectReason !== null)) return false;
  if (m.evidence === null) return true;
  const evidence = asObject(m.evidence);
  if (!evidence || typeof evidence.recordId !== 'string' || !isValidUuid(evidence.recordId) ||
      typeof evidence.finalizeEventId !== 'string' || !isValidUuid(evidence.finalizeEventId) ||
      !Array.isArray(evidence.files) || evidence.files.length === 0) return false;
  const ids = new Set<string>();
  for (const value of evidence.files) {
    const file = asObject(value);
    if (!file || typeof file.id !== 'string' || !isValidUuid(file.id) || ids.has(file.id) ||
        typeof file.mediaKind !== 'string' || !['PHOTO', 'DOCUMENT', 'VIDEO'].includes(file.mediaKind) ||
        typeof file.contentType !== 'string' || file.contentType.length === 0 ||
        typeof file.byteSize !== 'number' || !Number.isSafeInteger(file.byteSize) || file.byteSize <= 0 ||
        typeof file.sha256Digest !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256Digest)) return false;
    ids.add(file.id);
  }
  return true;
}

/**
 * Verify the immutable BACKEND attestation, not a free-standing digest. The
 * event metadata is written only after personal-PIC/session OR independently
 * verified Care-recorded customer consent, plus current QC and
 * issued-manifest validation. Body metadata/signer claims are never persisted.
 * Do not re-resolve today's PIC: a later legitimate relink cannot rewrite or
 * transfer the recorded actor's past consent. Legacy staff/digest-only history
 * is preserved, but is deliberately NOT certified by this predicate.
 */
export function verifiedHandymanBastCustomerConsent(
  bast: HandymanBastRecord,
  event: HandymanBastEventRecord,
  signOff: HandymanBastSignOffRecord,
): HandymanBastCustomerConsentManifest | null {
  const receipt = asObject(event.metadata?.customerConsent);
  if (!receipt || !validManifest(receipt.manifest)) return null;
  const m = receipt.manifest;
  if (m.protocol === HANDYMAN_BAST_CARE_CONSENT_PROTOCOL) {
    if (receipt.method !== COMMERCIAL_CONSENT_METHOD || event.actorUserId !== null ||
        event.actorCareActorId !== m.careConsent.careActorId || event.commercialConsentId !== m.careConsent.id) return null;
  } else if (receipt.method !== HANDYMAN_BAST_CUSTOMER_CONSENT_METHOD ||
      event.actorCareActorId != null || event.commercialConsentId != null) return null;
  if (iso(event.occurredAt) === null || iso(signOff.createdAt) === null) return null;
  if (m.bastId !== bast.id || m.clientId !== bast.clientId || m.executionScopeId !== bast.executionScopeId ||
      m.issuedAt !== iso(bast.issuedAt) || m.qcRunId !== bast.qcRunId ||
      event.bastId !== bast.id || event.clientId !== bast.clientId || event.executionScopeId !== bast.executionScopeId ||
      event.eventType !== m.decision || event.actorUserId !== m.actorUserId ||
      signOff.eventId !== event.id || signOff.bastId !== bast.id ||
      signOff.clientId !== bast.clientId || signOff.executionScopeId !== bast.executionScopeId ||
      signOff.decision !== m.decision || signOff.evidenceRecordId !== (m.evidence?.recordId ?? null) ||
      signOff.rejectReason !== m.rejectReason ||
      bast.status !== (m.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED') ||
      iso(event.occurredAt) !== iso(m.decision === 'ACCEPT' ? bast.acceptedAt : bast.rejectedAt) ||
      iso(event.occurredAt) !== iso(signOff.createdAt)) return null;
  const digest = computeHandymanBastCustomerConsentDigest(m);
  return receipt.sha256Digest === digest && signOff.signatureDigest === digest ? m : null;
}

/** Internal downstream gate. Same transaction executor; no HTTP bypass. */
export async function hasVerifiedHandymanBastCustomerAcceptance(
  tx: Pick<PoolClient, 'query'>,
  bastId: string,
): Promise<boolean> {
  const bast = await handymanBastRepository.findBastById(tx, bastId);
  if (!bast || bast.status !== 'ACCEPTED' || !bast.acceptedAt) return false;
  const events = await handymanBastRepository.listEventsByBastId(tx, bast.id);
  const signOffs = await handymanBastRepository.listSignOffsByBastId(tx, bast.id);
  return signOffs.some((so) => so.decision === 'ACCEPT' && events.some((event) =>
    verifiedHandymanBastCustomerConsent(bast, event, so) !== null));
}
