import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import { handymanBastRepository } from '../handyman-bast/handyman-bast.repository';
import { toHandymanBastArtifactReference } from '../handyman-bast/handyman-bast.read-contract';
import type { HandymanBastRecord } from '../handyman-bast/handyman-bast.types';
import type { HandymanExecutionScopeRecord } from '../handyman-quotations/handyman-execution-scope.types';
import { commercialConsentHash, COMMERCIAL_CONSENT_PURPOSE } from './commercial-consent.assertion';
import type { CommercialRequest, CommercialTarget } from './commercial-consent.service';

/** Exact ISSUED version identity; quotation engine already makes issued
 * commercial lines immutable. This is NOT a replacement pricing/PDF engine. */
export function quotationCommercialTarget(versionId: string, request: CommercialRequest): CommercialTarget {
  return { type: 'QUOTATION_VERSION', id: versionId,
    digest: commercialConsentHash([COMMERCIAL_CONSENT_PURPOSE, 'QUOTATION_VERSION', versionId,
      request.id, request.clientId, request.tenantCompanyId, request.tenantPicId, request.buildingId, request.spaceId]) };
}
/** Actor/decision-independent digest of the exact authoritative issued BAST
 * manifest. Its QC/quotation/issue-event identities are immutable. */
export async function bastCommercialTarget(tx: Pick<PoolClient, 'query'>, bast: HandymanBastRecord,
  scope: HandymanExecutionScopeRecord): Promise<CommercialTarget> {
  const issues = (await handymanBastRepository.listEventsByBastId(tx, bast.id)).filter(e => e.eventType === 'ISSUE');
  if (!bast.issuedAt || !bast.qcRunId || issues.length !== 1 || issues[0].occurredAt.getTime() !== bast.issuedAt.getTime()) {
    throw AppError.validation('An authoritative issued BAST/QC manifest is required.');
  }
  // Consent remains bound to the ISSUED v2, not the accepted/rejected v3
  // projection observed by an idempotent retry. Never retarget past consent.
  const artifact = toHandymanBastArtifactReference({ ...bast, status: 'ISSUED' });
  return { type: 'BAST', id: bast.id, digest: commercialConsentHash([COMMERCIAL_CONSENT_PURPOSE, 'BAST', bast.id,
    scope.id, scope.approvedQuotationVersionId, scope.clientId, scope.handymanRequestId,
    scope.tenantCompanyId, scope.tenantPicId, scope.buildingId, scope.spaceId,
    artifact.ref, artifact.version, issues[0].id, bast.issuedAt.toISOString(), bast.qcRunId]) };
}
