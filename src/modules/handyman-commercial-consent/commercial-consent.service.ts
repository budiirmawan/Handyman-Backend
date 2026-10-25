import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import type { CareWorkspacePrincipal } from '../handyman-care-workspace/care-workspace.service';
import { careCreateContextNotFound, lockCareCreateWorkspaceScope } from '../handyman-care-workspace/care-create-exchange.scope';
import { resolveHandoffContext } from '../handyman-handoff/handoff-context.service';
import { isCurrentCareRepresentation } from '../handyman-handoff/care-representation.service';
import {
  COMMERCIAL_CONSENT_METHOD, commercialConsentHash, freshCommercialConsent,
  parseCommercialConsentAssertion, readCommercialConsentSecret, verifyCommercialConsentSignature,
  type CommercialConsentAssertion,
} from './commercial-consent.assertion';

export type CareDecisionChannel = {
  workspaceToken: string; requestId: string; assertion: unknown; signature: string | undefined;
};
export type CommercialRequest = {
  id: string; clientId: string; tenantCompanyId: string; tenantPicId: string | null;
  buildingId: string; spaceId: string | null;
};
export type CommercialTarget = { type: 'QUOTATION_VERSION' | 'BAST'; id: string; digest: string };
export type VerifiedCareConsent = {
  id: string; method: typeof COMMERCIAL_CONSENT_METHOD; integrationId: string; careActorId: string;
  assertionHash: string; assertion: CommercialConsentAssertion; contractReference: string; recordedAt: string;
};
export const commercialConsentInvalid = () => new AppError({ code: 'HANDYMAN_COMMERCIAL_CONSENT_INVALID',
  message: 'Customer commercial consent could not be verified.', statusCode: 403 });
export const commercialConsentConflict = () => new AppError({ code: 'HANDYMAN_COMMERCIAL_CONSENT_CONFLICT',
  message: 'Consent assertion or communication was already used for a different decision.', statusCode: 409 });
export const commercialConsentBlocked = () => new AppError({ code: 'HANDYMAN_COMMERCIAL_CONSENT_INTEGRATION_BLOCKED',
  message: 'A separately enrolled BM customer-consent verifier and purpose-specific signing key are required. Care authentication or evidence alone is not customer consent.', statusCode: 503 });

/** Same current Care session / physical hierarchy / represented occupancy /
 * property-grant roots used by the existing signed create handoff. Never
 * resolve or borrow the represented customer's local User. */
export async function authorizeCareCommercialRequest(tx: PoolClient, principal: CareWorkspacePrincipal, request: CommercialRequest) {
  const property = await tx.query<{ property_id: string }>('SELECT property_id FROM buildings WHERE id=$1', [request.buildingId]);
  if (!property.rows[0]) throw careCreateContextNotFound();
  const bound = await lockCareCreateWorkspaceScope(tx, { ...principal, propertyId: property.rows[0].property_id,
    tenantCompanyId: request.tenantCompanyId, buildingId: request.buildingId, spaceId: request.spaceId });
  if (bound.clientId !== request.clientId) throw careCreateContextNotFound();
  let context;
  try { context = await resolveHandoffContext({ tenantCompanyId: request.tenantCompanyId, buildingId: request.buildingId,
    ...(request.tenantPicId ? { tenantPicId: request.tenantPicId } : {}), ...(request.spaceId ? { spaceId: request.spaceId } : {}) }); }
  catch (error) { if (error instanceof AppError) throw careCreateContextNotFound(); throw error; }
  if (!(await isCurrentCareRepresentation({ ...context, actorType: 'CUSTOMER_CARE',
    careActorId: principal.careActorId, actorReference: bound.actorReference }, tx))) throw careCreateContextNotFound();
  if (request.tenantPicId) {
    const pic = await tx.query(`SELECT id FROM tenant_pics WHERE id=$1 AND tenant_company_id=$2 AND status='ACTIVE' FOR SHARE`,
      [request.tenantPicId, request.tenantCompanyId]);
    if (pic.rowCount !== 1) throw careCreateContextNotFound();
  }
  return { principal, integrationCode: bound.integrationCode };
}

/** Called INSIDE the existing version/BAST decision transaction, before its
 * replay branch. Default is BLOCKED: no shipped integration currently has a
 * commercial verification contract. Enrollment is a deployment/governance
 * action, NOT a Care capability, role, request flag or API operation. */
export async function verifyCareCommercialConsent(
  tx: PoolClient, channel: CareDecisionChannel, request: CommercialRequest,
  target: CommercialTarget, decision: 'ACCEPT' | 'REJECT', principal: CareWorkspacePrincipal, rejectReason: string | null = null,
): Promise<VerifiedCareConsent> {
  if (channel.requestId !== request.id) throw careCreateContextNotFound();
  const { integrationCode } = await authorizeCareCommercialRequest(tx, principal, request);
  const trust = await tx.query<{ commercial_consent_contract_ref: string | null }>(
    'SELECT commercial_consent_contract_ref FROM handyman_handoff_integrations WHERE id=$1 FOR SHARE', [principal.integrationId]);
  const contract = trust.rows[0]?.commercial_consent_contract_ref;
  const secret = readCommercialConsentSecret(integrationCode);
  if (!contract || !secret) throw commercialConsentBlocked();
  const a = parseCommercialConsentAssertion(channel.assertion);
  if (!a || a.iss !== integrationCode || !verifyCommercialConsentSignature(a, channel.signature, secret) ||
      a.careActorId !== principal.careActorId || a.handymanRequestId !== request.id || a.clientId !== request.clientId ||
      a.tenantCompanyId !== request.tenantCompanyId || a.tenantPicId !== request.tenantPicId ||
      a.buildingId !== request.buildingId || a.spaceId !== request.spaceId || a.targetType !== target.type ||
      a.targetId !== target.id || a.targetDigest !== target.digest || a.decision !== decision || a.rejectReason !== rejectReason) {
    throw commercialConsentInvalid();
  }
  const comm = await tx.query(`SELECT * FROM handyman_care_communications WHERE id=$1 FOR UPDATE`, [a.communicationId]);
  const c = comm.rows[0];
  if (!c || c.client_id !== request.clientId || c.handyman_request_id !== request.id || c.building_id !== request.buildingId ||
      c.recorded_by_care_actor_id !== principal.careActorId ||
      c.purpose !== (target.type === 'BAST' ? 'BAST_CONFIRMATION_RECEIVED' : 'QUOTATION_RESPONSE_RECEIVED') ||
      c.reported_statement !== (decision === 'ACCEPT' ? 'CONFIRM' : 'REJECT')) throw commercialConsentInvalid();
  const hash = commercialConsentHash(a);
  const prior = await tx.query(`SELECT * FROM handyman_commercial_consent_receipts WHERE integration_id=$1 AND assertion_id=$2`,
    [principal.integrationId, a.jti]);
  let row = prior.rows[0];
  if (row && (row.assertion_hash !== hash || row.care_actor_id !== principal.careActorId)) throw commercialConsentConflict();
  if (!row) {
    const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    if (!freshCommercialConsent(a, clock.rows[0].now)) throw commercialConsentInvalid();
    try {
      row = (await tx.query(`INSERT INTO handyman_commercial_consent_receipts
        (id,integration_id,care_actor_id,communication_id,client_id,handyman_request_id,target_type,target_id,
         target_digest,decision,assertion_id,assertion_hash,assertion,contract_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING *`,
      [randomUUID(), principal.integrationId, principal.careActorId, a.communicationId, request.clientId, request.id,
        target.type, target.id, target.digest, decision, a.jti, hash, JSON.stringify(a), contract])).rows[0];
    } catch (error) { if ((error as { code?: string }).code === '23505') throw commercialConsentConflict(); throw error; }
  }
  return { id: row.id, method: COMMERCIAL_CONSENT_METHOD, integrationId: principal.integrationId,
    careActorId: principal.careActorId, assertionHash: hash, assertion: a,
    contractReference: row.contract_reference, recordedAt: row.recorded_at.toISOString() };
}

/** A first write cannot outlive its signed consent or workspace admission
 * while waiting on aggregate/QC/evidence locks or managed-byte I/O. Replay
 * returns historical facts earlier and deliberately does not mint new consent. */
export async function assertCareConsentWriteFresh(tx: PoolClient, consent: VerifiedCareConsent,
  principal: CareWorkspacePrincipal): Promise<void> {
  // Row locks prevent revocation/turnover, not natural effective-window expiry.
  // Reuse current Care authority again after any evidence/communication wait.
  const a = consent.assertion;
  await authorizeCareCommercialRequest(tx, principal, { id: a.handymanRequestId, clientId: a.clientId,
    tenantCompanyId: a.tenantCompanyId, tenantPicId: a.tenantPicId, buildingId: a.buildingId, spaceId: a.spaceId });
  const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  if (!freshCommercialConsent(consent.assertion, clock.rows[0].now) ||
      Date.parse(principal.expiresAt) <= clock.rows[0].now.getTime()) throw commercialConsentInvalid();
}
