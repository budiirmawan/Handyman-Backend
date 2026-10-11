import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { readHandoffIntegrationSecret } from '../handyman-handoff/handoff-runtime.config';
import { recordOperationalEvent } from '../operational-events';

export const BM_STAFF_LAUNCH_PURPOSE = 'HANDYMAN_BM_STAFF_LAUNCH';
export const BM_STAFF_LAUNCH_AUDIENCE = 'HANDYMAN_BM_STAFF_SSO';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^hbsl_[A-Za-z0-9_-]{43}$/;
export type BmStaffLaunchAssertion = {
  purpose: typeof BM_STAFF_LAUNCH_PURPOSE;
  integrationCode: string;
  issuer: string;
  audience: typeof BM_STAFF_LAUNCH_AUDIENCE;
  assertionId: string;
  staffReference: string;
  buildingId: string;
  issuedAt: string;
  expiresAt: string;
};
const deny = () => new AppError({ code: ERROR_CODES.HANDYMAN_BM_STAFF_HANDOFF_UNAUTHORIZED,
  statusCode: 401, message: 'BM staff handoff authentication failed.' });
const blocked = () => new AppError({ code: ERROR_CODES.HANDYMAN_BM_STAFF_AUTHORITY_UNAVAILABLE,
  statusCode: 409, message: 'Staff SSO is not enabled: a production BM-staff-to-User binding and explicit staff Care/Building authority are required. No session was created.' });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function keyFor(code: string): string {
  const secret = readHandoffIntegrationSecret(code);
  if (!secret || Buffer.byteLength(secret) < 32) throw deny();
  return secret;
}
function credentialBinding(secret: string, integrationId: string) {
  return createHmac('sha256', secret).update(`BM_STAFF_LAUNCH_KEY:${integrationId}`).digest('hex');
}
export function signBmStaffLaunch(assertion: BmStaffLaunchAssertion, secret: string) {
  return 'sha256=' + createHmac('sha256', secret).update(stableJson(assertion)).digest('hex');
}
function windowValid(a: BmStaffLaunchAssertion, now: number) {
  const from = Date.parse(a.issuedAt), to = Date.parse(a.expiresAt);
  if (from > now || to <= now || to <= from || to-from > 60_000) throw deny();
}
function parse(value: unknown): BmStaffLaunchAssertion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw deny();
  const a = value as Record<string, unknown>;
  const keys = ['purpose','integrationCode','issuer','audience','assertionId','staffReference','buildingId','issuedAt','expiresAt'];
  if (Object.keys(a).length !== keys.length || Object.keys(a).some(k=>!keys.includes(k)) ||
      a.purpose !== BM_STAFF_LAUNCH_PURPOSE || a.audience !== BM_STAFF_LAUNCH_AUDIENCE ||
      typeof a.integrationCode !== 'string' || !/^[A-Z0-9_]{1,128}$/.test(a.integrationCode) || a.issuer !== a.integrationCode ||
      typeof a.assertionId !== 'string' || !UUID.test(a.assertionId) || typeof a.buildingId !== 'string' || !UUID.test(a.buildingId) ||
      typeof a.staffReference !== 'string' || !a.staffReference.length || a.staffReference.length>128 || a.staffReference.trim()!==a.staffReference) throw deny();
  for (const k of ['issuedAt','expiresAt']) {
    if (typeof a[k] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(a[k] as string) ||
        !Number.isFinite(Date.parse(a[k] as string)) || new Date(a[k] as string).toISOString() !== a[k]) throw deny();
  }
  return value as BmStaffLaunchAssertion;
}

type TransportIdentity = { integrationId: string; careActorId: string; propertyGrantId: string; clientId: string };
/** Existing Care registry is transport identity only, NEVER a User resolver.
 * A property grant permits this pending receipt, not exact Building staff access.
 */
async function transportIdentity(tx: PoolClient, code: string, reference: string, buildingId: string): Promise<TransportIdentity> {
  const result = await tx.query<TransportIdentity>(`SELECT i.id AS "integrationId", a.id AS "careActorId",
      g.id AS "propertyGrantId", c.id AS "clientId"
    FROM handyman_handoff_integrations i JOIN handyman_handoff_care_actors a ON a.integration_id=i.id
    JOIN handyman_care_property_grants g ON g.care_actor_id=a.id AND g.status='ACTIVE'
    JOIN properties p ON p.id=g.property_id AND p.status='ACTIVE'
    JOIN buildings b ON b.property_id=p.id AND b.status='ACTIVE'
    JOIN clients c ON c.id=p.client_id AND c.status='ACTIVE'
    WHERE i.integration_code=$1 AND a.actor_reference=$2 AND b.id=$3
      AND i.status='ACTIVE' AND i.actor_capability='CUSTOMER_CARE' AND a.status='ACTIVE'
    FOR SHARE OF i,a,g,p,b,c`,[code,reference,buildingId]);
  if (result.rowCount!==1) throw deny();
  return result.rows[0];
}
async function audit(tx: PoolClient, row: TransportIdentity, receiptId: string, buildingId: string, eventType: string) {
  await recordOperationalEvent({ clientId:row.clientId, buildingId, entityType:'HANDYMAN_BM_STAFF_LAUNCH', entityId:receiptId,
    eventType, summary:'BM staff launch transport fact; staff session authority remains unresolved.',
    metadata:{integrationId:row.integrationId,careActorId:row.careActorId,requestedBuildingId:buildingId,
      staffSessionCreated:false,authorityStatus:'BLOCKED_STAFF_AUTHORITY'} },tx);
}

/** Authenticated S2S transport only. 202 does NOT mean staff admission. */
export async function issueBmStaffLaunch(body: unknown, signature: string | undefined) {
  const assertion=parse(body);
  windowValid(assertion,Date.now());
  const secret=keyFor(assertion.integrationCode);
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(signature),Buffer.from(signBmStaffLaunch(assertion,secret)))) throw deny();
  try {
    return await withTransaction(async tx=>{
      const identity=await transportIdentity(tx,assertion.integrationCode,assertion.staffReference,assertion.buildingId);
      const now=(await tx.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
      windowValid(assertion,now.getTime());
      // Re-read after lock waits: replacing an integration key cuts off in-flight old-key issuance.
      if (keyFor(assertion.integrationCode)!==secret) throw deny();
      const launchReference='hbsl_'+randomBytes(32).toString('base64url');
      const id=randomUUID(), expiresAt=new Date(Math.min(now.getTime()+60_000,Date.parse(assertion.expiresAt)));
      await tx.query(`INSERT INTO handyman_bm_staff_launch_receipts
        (id,integration_id,care_actor_id,property_grant_id,requested_building_id,assertion_id,issuer,audience,reference_hash,credential_binding,issued_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id,identity.integrationId,identity.careActorId,identity.propertyGrantId,assertion.buildingId,assertion.assertionId,
          assertion.issuer,assertion.audience,hash(launchReference),credentialBinding(secret,identity.integrationId),now,expiresAt]);
      await audit(tx,identity,id,assertion.buildingId,'HANDYMAN_BM_STAFF_LAUNCH_RECEIVED');
      return {launchReference,expiresAt:expiresAt.toISOString()};
    });
  } catch(error) {
    if ((error as {code?:string}).code==='23505') throw deny();
    throw error;
  }
}

/** Consume exactly once, committing the replay barrier, then refuse admission.
 * There is intentionally NO call to createSessionForUser/admitCareWorkspace.
 * Do not replace this refusal with a claim-based identity/permission fallback.
 */
export async function exchangeBmStaffLaunch(reference: unknown): Promise<never> {
  if (typeof reference!=='string' || !REFERENCE.test(reference)) throw deny();
  await withTransaction(async tx=>{
    const found=await tx.query(`SELECT l.*,i.integration_code,a.actor_reference
      FROM handyman_bm_staff_launch_receipts l JOIN handyman_handoff_integrations i ON i.id=l.integration_id
      JOIN handyman_handoff_care_actors a ON a.id=l.care_actor_id WHERE l.reference_hash=$1`,[hash(reference)]);
    const candidate=found.rows[0]; if(!candidate) throw deny();
    const identity=await transportIdentity(tx,candidate.integration_code,candidate.actor_reference,candidate.requested_building_id);
    const result=await tx.query(`SELECT * FROM handyman_bm_staff_launch_receipts WHERE id=$1
      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,[candidate.id]);
    const row=result.rows[0];
    if(!row || row.property_grant_id!==identity.propertyGrantId || row.care_actor_id!==identity.careActorId ||
       row.issuer!==candidate.integration_code || row.audience!==BM_STAFF_LAUNCH_AUDIENCE ||
       row.credential_binding!==credentialBinding(keyFor(candidate.integration_code),identity.integrationId)) throw deny();
    const consumed=await tx.query(`UPDATE handyman_bm_staff_launch_receipts SET consumed_at=clock_timestamp()
      WHERE id=$1 AND expires_at>clock_timestamp() AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`,[row.id]);
    if(!consumed.rowCount) throw deny();
    await audit(tx,identity,row.id,row.requested_building_id,'HANDYMAN_BM_STAFF_LAUNCH_BLOCKED');
  });
  throw blocked();
}

/** A reference holder can discard a pending transport receipt, never revoke
 * another authority or gain a session. Unknown/revoked references are opaque. */
export async function revokeBmStaffLaunch(reference: unknown): Promise<void> {
  if(typeof reference!=='string' || !REFERENCE.test(reference)) throw deny();
  await withTransaction(async tx=>{
    const result=await tx.query(`UPDATE handyman_bm_staff_launch_receipts SET revoked_at=clock_timestamp()
      WHERE reference_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING *`,[hash(reference)]);
    const row=result.rows[0];
    if(row) {
      const scope=(await tx.query(`SELECT p.client_id FROM buildings b JOIN properties p ON p.id=b.property_id WHERE b.id=$1`,[row.requested_building_id])).rows[0];
      await audit(tx,{integrationId:row.integration_id,careActorId:row.care_actor_id,propertyGrantId:row.property_grant_id,clientId:scope.client_id},
        row.id,row.requested_building_id,'HANDYMAN_BM_STAFF_LAUNCH_REVOKED');
    }
  });
}
