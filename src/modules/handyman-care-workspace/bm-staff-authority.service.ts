import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { readHandoffIntegrationSecret } from '../handyman-handoff/handoff-runtime.config';
import { recordOperationalEvent } from '../operational-events';

export const STAFF_CARE_PERMISSION='handyman.care.staff.access';
const denied=()=>new AppError({code:'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED',statusCode:401,message:'Staff Care session authority is unavailable.'});
const forbidden=()=>new AppError({code:'PERMISSION_DENIED',statusCode:403,message:'Staff authority administration requires explicit delegation and Building access.'});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function staffUuid(value:unknown):string {
  if(typeof value!=='string'||!UUID.test(value)) throw AppError.validation('Expected a UUID.');
  return value.toLowerCase();
}
export function staffBody(value:unknown,keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))) throw AppError.validation('Unexpected staff authority fields.');
  return value as Record<string,unknown>;
}
type Executor=Pick<PoolClient,'query'>;
const RBAC=`FROM user_role_assignments ur JOIN roles r ON r.id=ur.role_id
  JOIN role_permission_assignments rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
  WHERE ur.user_id=$1 AND ur.status='ACTIVE' AND r.status='ACTIVE' AND rp.status='ACTIVE' AND p.status='ACTIVE' AND p.code=$2`;
async function lockPermission(tx:Executor,userId:string,code:string) {
  return (await tx.query(`SELECT p.id ${RBAC} ORDER BY ur.id,rp.id LIMIT 1 FOR SHARE OF ur,r,rp,p`,[userId,code])).rowCount===1;
}

/** Locks existing authorities through writes; the SQL projection also rechecks
 * them at every read boundary. No role-name or claim-based authorization. */
async function lockGrant(tx:Executor,grantId:string) {
  const result=await tx.query(`SELECT * FROM handyman_bm_staff_live_authority WHERE grant_id=$1 FOR SHARE`,[grantId]);
  const row=result.rows[0];if(!row) return null;
  if(!await lockPermission(tx,row.user_id,STAFF_CARE_PERMISSION)) return null;
  const context=await tx.query(`SELECT id FROM tenant_building_contexts WHERE tenant_company_id=$1 AND building_id=$2 AND status='ACTIVE'
    AND (effective_from IS NULL OR effective_from<=clock_timestamp()) AND (effective_until IS NULL OR effective_until>=clock_timestamp()) FOR SHARE`,[row.tenant_company_id,row.building_id]);
  if(!context.rowCount) return null;
  return row;
}
function currentKeyMatches(code:string,integrationId:string,binding:string) {
  const key=readHandoffIntegrationSecret(code);
  return !!key&&Buffer.byteLength(key)>=32&&createHmac('sha256',key).update(`BM_STAFF_LAUNCH_KEY:${integrationId}`).digest('hex')===binding;
}

/** Null means a legacy non-User Care session. A linked staff session can never
 * fall back to legacy authority when its mapping/entitlement disappears. */
export async function lockBmStaffSession(tx:Executor,sessionId:string,scope?:{buildingId:string;tenantCompanyId:string;propertyId?:string}) {
  const link=(await tx.query(`SELECT ss.*,l.credential_binding FROM handyman_bm_staff_sessions ss
    JOIN handyman_bm_staff_launch_receipts l ON l.id=ss.launch_id WHERE ss.session_id=$1`,[sessionId])).rows[0];
  if(!link) return null;
  const row=await lockGrant(tx,link.scope_grant_id);
  if(!row || !currentKeyMatches(row.integration_code,row.integration_id,link.credential_binding)) throw denied();
  // Scope function includes original transport property grant and session TTL.
  const valid=await tx.query('SELECT 1 WHERE handyman_bm_staff_scope($1,$2,$3,$4)',
    [sessionId,scope?.buildingId??null,scope?.tenantCompanyId??null,scope?.propertyId??null]);
  if(!valid.rowCount) throw denied();
  return row;
}

export async function mintBmStaffSession(tx:PoolClient,launch:any,tenantCompanyId:string|null) {
  if(!tenantCompanyId) return null;
  const candidate=(await tx.query(`SELECT v.grant_id FROM handyman_bm_staff_live_authority v
    WHERE v.integration_id=$1 AND v.care_actor_id=$2 AND v.integration_code=$3 AND v.building_id=$4 AND v.tenant_company_id=$5`,
    [launch.integration_id,launch.care_actor_id,launch.issuer,launch.requested_building_id,tenantCompanyId])).rows[0];
  if(!candidate) return null;
  const v=await lockGrant(tx,candidate.grant_id);if(!v) return null;
  const now=(await tx.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  // Lock waits/audit must not turn an elapsed 0452 receipt into admission.
  if(launch.expires_at<=now || !currentKeyMatches(v.integration_code,v.integration_id,launch.credential_binding)) throw denied();
  const sessionId=randomUUID(), workspaceToken='hbs_'+randomBytes(32).toString('base64url');
  const expiresAt=new Date(now.getTime()+900_000);
  await tx.query(`INSERT INTO handyman_care_workspace_sessions(id,integration_id,care_actor_id,assertion_id,token_hash,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[sessionId,v.integration_id,v.care_actor_id,`bm-staff:${launch.id}`,
      createHash('sha256').update(workspaceToken).digest('hex'),now,expiresAt]);
  await tx.query('INSERT INTO handyman_bm_staff_sessions(session_id,launch_id,scope_grant_id) VALUES($1,$2,$3)',[sessionId,launch.id,v.grant_id]);
  await recordOperationalEvent({clientId:v.client_id,buildingId:v.building_id,actorUserId:v.user_id,
    entityType:'HANDYMAN_BM_STAFF_SESSION',entityId:sessionId,eventType:'HANDYMAN_BM_STAFF_SESSION_ADMITTED',
    summary:'Explicitly bound local Customer Care staff admitted.',metadata:{bindingId:v.binding_id,scopeGrantId:v.grant_id,
      tenantCompanyId:v.tenant_company_id,launchId:launch.id,staffSessionCreated:true}},tx);
  if(!(await tx.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp() AND handyman_bm_staff_scope($2)',[launch.expires_at,sessionId])).rowCount) throw denied();
  return {workspaceToken,expiresAt:expiresAt.toISOString(),principalType:'BM_STAFF' as const,
    userId:v.user_id,tenantCompanyId:v.tenant_company_id,buildingId:v.building_id};
}

async function administrator(tx:PoolClient,userId:string,buildingId:string,tenantCompanyId?:string) {
  const user=await tx.query("SELECT id FROM users WHERE id=$1 AND status='ACTIVE' FOR SHARE",[userId]);
  if(!user.rowCount) throw forbidden();
  for(const code of ['user.manage','permission.manage','tenant_company.manage',STAFF_CARE_PERMISSION]) if(!await lockPermission(tx,userId,code)) throw forbidden();
  const scope=await tx.query(`SELECT p.client_id FROM user_building_assignments ba JOIN buildings b ON b.id=ba.building_id
    JOIN properties p ON p.id=b.property_id WHERE ba.user_id=$1 AND ba.building_id=$2 AND ba.status='ACTIVE' FOR SHARE OF ba,b,p`,[userId,buildingId]);
  if(!scope.rowCount) throw forbidden();
  if(tenantCompanyId && !(await tx.query('SELECT id FROM tenant_companies WHERE id=$1 AND client_id=$2 FOR SHARE',[tenantCompanyId,scope.rows[0].client_id])).rowCount) throw forbidden();
  return scope.rows[0].client_id as string;
}
async function grant(tx:PoolClient,adminId:string,bindingId:string,buildingId:string,tenantCompanyId:string) {
  const clientId=await administrator(tx,adminId,buildingId,tenantCompanyId);
  const binding=(await tx.query('SELECT * FROM handyman_bm_staff_bindings WHERE id=$1 AND revoked_at IS NULL FOR SHARE',[bindingId])).rows[0];
  if(!binding) throw forbidden();
  const ba=(await tx.query(`SELECT ba.id FROM user_building_assignments ba JOIN users u ON u.id=ba.user_id AND u.status='ACTIVE'
    JOIN buildings b ON b.id=ba.building_id AND b.status='ACTIVE' JOIN properties p ON p.id=b.property_id AND p.status='ACTIVE'
    JOIN clients c ON c.id=p.client_id AND c.status='ACTIVE'
    JOIN tenant_companies t ON t.id=$3 AND t.client_id=c.id AND t.status='ACTIVE'
    WHERE ba.user_id=$1 AND ba.building_id=$2 AND ba.status='ACTIVE' FOR SHARE OF ba,u,b,p,c,t`,[binding.user_id,buildingId,tenantCompanyId])).rows[0];
  if(!ba) throw forbidden();
  if(!(await tx.query(`SELECT id FROM tenant_building_contexts WHERE tenant_company_id=$1 AND building_id=$2 AND status='ACTIVE'
    AND (effective_from IS NULL OR effective_from<=clock_timestamp()) AND (effective_until IS NULL OR effective_until>=clock_timestamp()) FOR SHARE`,[tenantCompanyId,buildingId])).rowCount) throw forbidden();
  const id=randomUUID();
  await tx.query(`INSERT INTO handyman_bm_staff_scope_grants(id,binding_id,tenant_company_id,building_id,building_assignment_id,granted_by_user_id) VALUES($1,$2,$3,$4,$5,$6)`,[id,bindingId,tenantCompanyId,buildingId,ba.id,adminId]);
  await recordOperationalEvent({clientId,buildingId,actorUserId:adminId,entityType:'HANDYMAN_BM_STAFF_SCOPE',entityId:id,
    eventType:'HANDYMAN_BM_STAFF_SCOPE_GRANTED',summary:'Explicit tenant and exact Building staff scope granted.',metadata:{bindingId,tenantCompanyId,userId:binding.user_id}},tx);
  return {id,bindingId,tenantCompanyId,buildingId};
}
export async function provisionBmStaffBinding(adminId:string,input:unknown) {
  const b=staffBody(input,['integrationId','subject','userId','buildingId','tenantCompanyId']);
  const integrationId=staffUuid(b.integrationId),userId=staffUuid(b.userId),buildingId=staffUuid(b.buildingId),tenantCompanyId=staffUuid(b.tenantCompanyId);
  if(typeof b.subject!=='string'||b.subject.trim()!==b.subject||!b.subject.length||b.subject.length>128) throw AppError.validation('Invalid subject.');
  return withTransaction(async tx=>{
    const clientId=await administrator(tx,adminId,buildingId,tenantCompanyId);
    const actor=(await tx.query(`SELECT a.id FROM handyman_handoff_care_actors a JOIN handyman_handoff_integrations i ON i.id=a.integration_id
      WHERE a.integration_id=$1 AND a.actor_reference=$2 AND a.status='ACTIVE' AND i.status='ACTIVE' AND i.actor_capability='CUSTOMER_CARE' FOR SHARE OF a,i`,[integrationId,b.subject])).rows[0];
    if(!actor) throw forbidden();
    if(!(await tx.query("SELECT id FROM users WHERE id=$1 AND status='ACTIVE' FOR SHARE",[userId])).rowCount) throw forbidden();
    const id=randomUUID();
    await tx.query(`INSERT INTO handyman_bm_staff_bindings(id,integration_id,subject,care_actor_id,user_id,provisioned_by_user_id) VALUES($1,$2,$3,$4,$5,$6)`,[id,integrationId,b.subject,actor.id,userId,adminId]);
    const scope=await grant(tx,adminId,id,buildingId,tenantCompanyId);
    await recordOperationalEvent({clientId,buildingId,actorUserId:adminId,entityType:'HANDYMAN_BM_STAFF_BINDING',entityId:id,
      eventType:'HANDYMAN_BM_STAFF_BINDING_CREATED',summary:'Explicit BM issuer/subject binding to existing local User provisioned.',metadata:{integrationId,careActorId:actor.id,userId}},tx);
    return {id,userId,integrationId,scope};
  });
}
export async function grantBmStaffScope(adminId:string,binding:unknown,input:unknown) {
  const b=staffBody(input,['buildingId','tenantCompanyId']);
  return withTransaction(tx=>grant(tx,adminId,staffUuid(binding),staffUuid(b.buildingId),staffUuid(b.tenantCompanyId)));
}
export async function revokeBmStaffAuthority(adminId:string,kind:'bindings'|'grants',value:unknown) {
  const id=staffUuid(value),table=kind==='bindings'?'handyman_bm_staff_bindings':'handyman_bm_staff_scope_grants';
  return withTransaction(async tx=>{
    // Serialize global binding withdrawal against concurrent scope additions.
    if(!(await tx.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[id])).rowCount) throw forbidden();
    const scopes=(await tx.query(`SELECT * FROM handyman_bm_staff_scope_grants WHERE ${kind==='bindings'?'binding_id':'id'}=$1 ORDER BY building_id`,[id])).rows;
    if(!scopes.length) throw forbidden();
    let clientId='';for(const scope of scopes) clientId=await administrator(tx,adminId,scope.building_id,scope.tenant_company_id);
    const result=await tx.query(`UPDATE ${table} SET revoked_at=clock_timestamp(),revoked_by_user_id=$2 WHERE id=$1 AND revoked_at IS NULL RETURNING id`,[id,adminId]);
    if(result.rowCount) await recordOperationalEvent({clientId,actorUserId:adminId,entityType:'HANDYMAN_BM_STAFF_AUTHORITY',entityId:id,
      eventType:'HANDYMAN_BM_STAFF_AUTHORITY_REVOKED',summary:'Staff authority revoked; linked sessions permanently invalidated.',metadata:{kind}},tx);
  });
}

/** Logout remains possible after loss of User/role/grants, and is idempotent.
 * Possession only permits revocation of this exact credential, never admission. */
export async function logoutBmStaffSession(token:string) {
  if(!/^hbs_[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
  await withTransaction(async tx=>{
    const result=await tx.query(`UPDATE handyman_care_workspace_sessions s SET revoked_at=clock_timestamp()
      FROM handyman_bm_staff_sessions ss,handyman_bm_staff_scope_grants g,handyman_bm_staff_bindings d,buildings b,properties p
      WHERE s.id=ss.session_id AND g.id=ss.scope_grant_id AND d.id=g.binding_id AND b.id=g.building_id AND p.id=b.property_id
        AND s.token_hash=$1 AND s.revoked_at IS NULL RETURNING s.id,d.user_id,g.building_id,p.client_id`,[createHash('sha256').update(token).digest('hex')]);
    const row=result.rows[0];if(row) await recordOperationalEvent({clientId:row.client_id,buildingId:row.building_id,actorUserId:row.user_id,
      entityType:'HANDYMAN_BM_STAFF_SESSION',entityId:row.id,eventType:'HANDYMAN_BM_STAFF_SESSION_LOGOUT',summary:'Staff session logged out.'},tx);
  });
}

export async function revokeBmStaffSessionById(adminId:string,input:unknown) {
  const id=staffUuid(input);
  await withTransaction(async tx=>{
    const scope=(await tx.query(`SELECT g.* FROM handyman_bm_staff_sessions ss JOIN handyman_bm_staff_scope_grants g ON g.id=ss.scope_grant_id WHERE ss.session_id=$1`,[id])).rows[0];
    if(!scope) throw forbidden();
    const clientId=await administrator(tx,adminId,scope.building_id,scope.tenant_company_id);
    const result=await tx.query('UPDATE handyman_care_workspace_sessions SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL RETURNING id',[id]);
    if(result.rowCount) await recordOperationalEvent({clientId,buildingId:scope.building_id,actorUserId:adminId,entityType:'HANDYMAN_BM_STAFF_SESSION',
      entityId:id,eventType:'HANDYMAN_BM_STAFF_SESSION_REVOKED',summary:'Staff session revoked by authorized administrator.'},tx);
  });
}
