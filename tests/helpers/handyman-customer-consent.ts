import assert from 'node:assert/strict';
import { getPool } from '../../src/database';
import {
  HANDYMAN_BAST_CUSTOMER_CONSENT_PROTOCOL, computeHandymanBastCustomerConsentDigest,
  handymanBastRepository, type HandymanBastCustomerConsentManifest,
} from '../../src/modules/handyman-bast';
import { handymanEvidenceQcRepository } from '../../src/modules/handyman-evidence-qc/handyman-evidence-qc.repository';
import { handymanExecutionScopeRepository } from '../../src/modules/handyman-quotations/handyman-execution-scope.repository';

/** Customer account already designated by the fixture's request/PIC, not staff. */
export async function handymanCustomerForScope(executionScopeId: string) {
  const result = await getPool().query<{ id: string; email: string }>(
    `SELECT u.id, u.email FROM handyman_execution_scopes s
       JOIN handyman_service_requests r ON r.id = s.handyman_request_id
       JOIN tenant_pics tp ON tp.id = r.tenant_pic_id
       JOIN users u ON u.id = tp.user_id WHERE s.id = $1`, [executionScopeId],
  );
  assert.ok(result.rows[0], 'fixture must have a genuine current customer account');
  return result.rows[0];
}

/**
 * Test client: assemble fields exposed by existing scope/BAST/evidence reads.
 * No production authority/evidence-verifier helper is used to bless a digest.
 */
export async function handymanCustomerConsentInput(
  bastId: string,
  actorUserId: string,
  options: { decision?: 'ACCEPT' | 'REJECT'; rejectReason?: string | null; evidenceRecordId?: string | null } = {},
) {
  const pool = getPool();
  const bast = await handymanBastRepository.findBastById(pool, bastId);
  assert.ok(bast?.issuedAt && bast.qcRunId);
  const scope = await handymanExecutionScopeRepository.findScopeById(pool, bast.executionScopeId);
  assert.ok(scope);
  const issue = (await handymanBastRepository.listEventsByBastId(pool, bast.id)).find((e) => e.eventType === 'ISSUE');
  assert.ok(issue);
  let evidence: HandymanBastCustomerConsentManifest['evidence'] = null;
  if (options.evidenceRecordId) {
    const finalized = await handymanEvidenceQcRepository.findEvidenceFinalizeEventByRecord(pool, options.evidenceRecordId);
    assert.ok(finalized);
    const files = await handymanEvidenceQcRepository.listEvidenceFilesByRecord(pool, options.evidenceRecordId);
    evidence = {
      recordId: options.evidenceRecordId, finalizeEventId: finalized.id,
      files: files.map(({ id, mediaKind, contentType, byteSize, sha256Digest }) =>
        ({ id, mediaKind, contentType, byteSize, sha256Digest })),
    };
  }
  const manifest: HandymanBastCustomerConsentManifest = {
    protocol: HANDYMAN_BAST_CUSTOMER_CONSENT_PROTOCOL, bastId: bast.id,
    executionScopeId: scope.id, approvedQuotationVersionId: scope.approvedQuotationVersionId,
    clientId: scope.clientId, handymanRequestId: scope.handymanRequestId,
    tenantCompanyId: scope.tenantCompanyId, tenantPicId: scope.tenantPicId,
    buildingId: scope.buildingId, issuedArtifactRef: `BAST/${bast.id}/v2`, issuedArtifactVersion: 2,
    issueEventId: issue.id, issuedAt: bast.issuedAt.toISOString(), qcRunId: bast.qcRunId,
    actorUserId, decision: options.decision ?? 'ACCEPT', rejectReason: options.rejectReason?.trim() || null, evidence,
  };
  return { manifest, signatureDigest: computeHandymanBastCustomerConsentDigest(manifest) };
}
