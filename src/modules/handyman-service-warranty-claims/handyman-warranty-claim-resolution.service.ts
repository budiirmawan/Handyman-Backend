import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { assertCurrentGuardedHandymanQcPass } from '../handyman-evidence-qc/handyman-qc-pass-gate';
import { assertWarrantyReworkOperations } from '../handyman-service-warranty-reworks/handyman-warranty-rework-authority';

type Actor = {userId:string;sessionId:string};
type Context = {claim_id:string;original_scope_id:string;client_id:string;building_id:string;handyman_request_id:string;
  tenant_company_id:string;tenant_pic_id:string|null;claim_status:string;rework_id:string|null;execution_scope_id:string|null;
  completion_id:string|null;assessment_id:string|null;certificate_id:string|null};
type Proposal = {id:string;claim_id:string;rework_id:string;execution_scope_id:string;completion_id:string;
  assessment_id:string;certificate_id:string;qc_run_id:string;qc_run_version:number;client_id:string;building_id:string;
  tenant_pic_id:string;proposed_by_user_id:string;proposed_session_id:string;idempotency_key:string;proposed_at:Date};
type Event = {id:string;proposal_id:string;claim_id:string;event_type:string;actor_user_id:string;actor_session_id:string;
  note:string|null;idempotency_key:string;occurred_at:Date};
const conflict = (message:string) => new AppError({code:ERROR_CODES.CONFLICT,statusCode:409,message});
const denied = () => new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Exact Operations or request Tenant PIC authority is required.'});
function uuid(value:unknown,name:string) {
  if (typeof value!=='string' || !isValidUuid(value.trim())) throw AppError.validation(`A valid ${name} is required.`);
  return value.trim().toLowerCase();
}
function input(value:unknown,allowed:string[]) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k)))
    throw AppError.validation('Unexpected resolution field; identity and timestamps come from the authenticated session.');
  return value as Record<string,unknown>;
}
function key(value:unknown) {
  if (typeof value!=='string' || !value.trim() || value.trim().length>200) throw AppError.validation('A valid idempotencyKey is required.');
  return value.trim();
}
function pin(value:Record<string,unknown>) {
  if (!Number.isSafeInteger(value.qcRunVersion) || (value.qcRunVersion as number)<1) throw AppError.validation('A positive qcRunVersion is required.');
  return {reworkId:uuid(value.reworkId,'reworkId'),qcRunId:uuid(value.qcRunId,'qcRunId'),qcRunVersion:value.qcRunVersion as number,
    idempotencyKey:key(value.idempotencyKey)};
}
function note(value:unknown):string|null {
  if (value===undefined || value===null) return null;
  if (typeof value!=='string' || !value.trim() || value.trim().length>2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    throw AppError.validation('A dispute note must be nonempty text of at most 2000 characters.');
  return value.trim();
}
function proposalView(p:Proposal) {
  return {proposalId:p.id,claimId:p.claim_id,reworkId:p.rework_id,executionScopeId:p.execution_scope_id,
    completionId:p.completion_id,assessmentId:p.assessment_id,certificateId:p.certificate_id,
    qcRunId:p.qc_run_id,qcRunVersion:p.qc_run_version,qcResult:'PASSED',tenantPicId:p.tenant_pic_id,
    proposedByUserId:p.proposed_by_user_id,proposedAt:p.proposed_at.toISOString()};
}
function eventView(e:Event) {
  return {eventId:e.id,type:e.event_type,actorUserId:e.actor_user_id,note:e.note,occurredAt:e.occurred_at.toISOString()};
}
/** Lock parent before child, the same order as QC and rework writers. */
async function context(tx:PoolClient,actor:Actor,claimId:string):Promise<Context> {
  const initial=(await tx.query<{execution_scope_id:string;client_id:string;building_id:string}>(`SELECT c.execution_scope_id,c.client_id,s.building_id
    FROM handyman_service_warranty_claims c JOIN handyman_execution_scopes s ON s.id=c.execution_scope_id AND s.client_id=c.client_id
    WHERE c.id=$1`,[claimId])).rows[0];
  if (!initial) throw AppError.notFound('Warranty claim not found.');
  await assertBuildingScopedResourceAccess(actor.userId,{clientId:initial.client_id,buildingId:initial.building_id},tx);
  await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE',[initial.execution_scope_id]);
  const row=(await tx.query<Context>(`SELECT c.id AS claim_id,c.execution_scope_id AS original_scope_id,c.client_id,s.building_id,
    s.handyman_request_id,s.tenant_company_id,s.tenant_pic_id,c.status AS claim_status,
    r.id AS rework_id,x.execution_scope_id,comp.id AS completion_id,x.assessment_id,x.certificate_id
    FROM handyman_service_warranty_claims c JOIN handyman_execution_scopes s ON s.id=c.execution_scope_id AND s.client_id=c.client_id
    LEFT JOIN handyman_service_warranty_reworks r ON r.claim_id=c.id AND r.client_id=c.client_id AND r.execution_scope_id=s.id
    LEFT JOIN handyman_warranty_rework_executions x ON x.rework_id=r.id AND x.claim_id=c.id AND x.original_scope_id=s.id
      AND x.client_id=c.client_id AND x.building_id=s.building_id AND x.assessment_id=c.decision_assessment_id
    LEFT JOIN handyman_warranty_rework_completions comp ON comp.rework_id=r.id AND comp.execution_scope_id=x.execution_scope_id
    WHERE c.id=$1`,[claimId])).rows[0];
  if (!row) throw AppError.notFound('Warranty claim not found.');
  return row;
}
async function operations(tx:PoolClient,actor:Actor,ctx:Context) {
  await assertWarrantyReworkOperations(tx,{clientId:ctx.client_id,buildingId:ctx.building_id,handymanRequestId:ctx.handyman_request_id},actor.userId);
}
async function exactPic(tx:PoolClient,actor:Actor,ctx:Context):Promise<boolean> {
  return Boolean((await tx.query(`SELECT p.id FROM tenant_pics p JOIN users u ON u.id=p.user_id AND u.status='ACTIVE'
    JOIN user_sessions sess ON sess.user_id=u.id AND sess.id=$4 AND sess.status='ACTIVE' AND sess.expires_at>clock_timestamp()
    JOIN user_building_assignments a ON a.user_id=u.id AND a.building_id=$5 AND a.status='ACTIVE'
    JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE'
    JOIN properties pr ON pr.id=b.property_id AND pr.client_id=$6
    WHERE p.id=$1 AND p.tenant_company_id=$2 AND p.user_id=$3 AND p.status='ACTIVE'
    FOR SHARE OF p,u,sess,a,b,pr`,[ctx.tenant_pic_id,ctx.tenant_company_id,actor.userId,actor.sessionId,ctx.building_id,ctx.client_id])).rowCount);
}
async function requireCurrent(tx:PoolClient,ctx:Context,expected:{reworkId:string;qcRunId:string;qcRunVersion:number}) {
  if (ctx.claim_status!=='CLAIM_APPROVED' || !ctx.execution_scope_id || !ctx.completion_id || !ctx.assessment_id ||
      !ctx.certificate_id || !ctx.tenant_pic_id || ctx.rework_id!==expected.reworkId)
    throw conflict('The exact approved claim and completed bound rework are required.');
  await assertCurrentGuardedHandymanQcPass(tx,{id:ctx.execution_scope_id,clientId:ctx.client_id,buildingId:ctx.building_id},expected.qcRunId);
  const q=(await tx.query<{version:number}>(`SELECT version FROM handyman_qc_runs WHERE id=$1 AND execution_scope_id=$2
    AND client_id=$3 AND status='PASSED' FOR SHARE`,[expected.qcRunId,ctx.execution_scope_id,ctx.client_id])).rows[0];
  if (!q || q.version!==expected.qcRunVersion) throw conflict('The proposed QC result is stale or not the exact rework PASS.');
}
async function proposal(tx:PoolClient,claimId:string,proposalId:string):Promise<Proposal> {
  const row=(await tx.query<Proposal>('SELECT * FROM handyman_warranty_resolution_proposals WHERE id=$1 AND claim_id=$2',[proposalId,claimId])).rows[0];
  if (!row) throw AppError.notFound('Resolution proposal not found.');
  return row;
}
function samePin(p:Proposal,expected:{reworkId:string;qcRunId:string;qcRunVersion:number}) {
  if (p.rework_id!==expected.reworkId || p.qc_run_id!==expected.qcRunId || p.qc_run_version!==expected.qcRunVersion)
    throw conflict('The response must identify the exact proposed rework and QC result.');
}
async function currentProposal(tx:PoolClient,ctx:Context,p:Proposal) {
  await requireCurrent(tx,ctx,{reworkId:p.rework_id,qcRunId:p.qc_run_id,qcRunVersion:p.qc_run_version});
  const current=(await tx.query<{valid:boolean}>('SELECT hm_warranty_resolution_basis_current(p) AS valid FROM handyman_warranty_resolution_proposals p WHERE p.id=$1',[p.id])).rows[0];
  if (!current?.valid) throw conflict('The proposal no longer has the exact consented rework and fresh QC basis.');
}
async function finalEvent(tx:PoolClient,claimId:string) {
  return (await tx.query<Event>("SELECT * FROM handyman_warranty_resolution_events WHERE claim_id=$1 AND event_type='RESOLVED'",[claimId])).rows[0];
}
function mapDbConflict(error:unknown):never {
  if (['23505','23514'].includes((error as {code?:string})?.code ?? '')) throw conflict('Resolution is duplicate, stale, or lacks its required authority and evidence.');
  throw error;
}

/** Explicit Operations proposal; never changes the original claim decision. */
export async function proposeClaimResolution(actor:Actor,claimInput:string,body:unknown) {
  const claimId=uuid(claimInput,'claimId'), cmd=pin(input(body,['reworkId','qcRunId','qcRunVersion','idempotencyKey']));
  try { return await withTransaction(async tx=>{
    const ctx=await context(tx,actor,claimId); await operations(tx,actor,ctx);
    const prior=(await tx.query<Proposal>('SELECT * FROM handyman_warranty_resolution_proposals WHERE claim_id=$1 AND idempotency_key=$2',[claimId,cmd.idempotencyKey])).rows[0];
    if (prior) {
      samePin(prior,cmd); if (prior.proposed_by_user_id!==actor.userId) throw conflict('Idempotency key belongs to another actor.');
      return {proposal:proposalView(prior),replayed:true};
    }
    if (await finalEvent(tx,claimId)) throw conflict('This claim is already resolved.');
    await requireCurrent(tx,ctx,cmd);
    const row=(await tx.query<Proposal>(`INSERT INTO handyman_warranty_resolution_proposals
      (id,claim_id,rework_id,execution_scope_id,completion_id,assessment_id,certificate_id,qc_run_id,qc_run_version,
       client_id,building_id,tenant_pic_id,proposed_by_user_id,proposed_session_id,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [randomUUID(),claimId,cmd.reworkId,ctx.execution_scope_id,ctx.completion_id,ctx.assessment_id,ctx.certificate_id,
      cmd.qcRunId,cmd.qcRunVersion,ctx.client_id,ctx.building_id,ctx.tenant_pic_id,actor.userId,actor.sessionId,cmd.idempotencyKey])).rows[0];
    return {proposal:proposalView(row),replayed:false};
  }); } catch(error) { return mapDbConflict(error); }
}

/** A local authenticated request PIC, not Care, records exactly one response. */
export async function respondClaimResolution(actor:Actor,claimInput:string,proposalInput:string,body:unknown) {
  const claimId=uuid(claimInput,'claimId'),proposalId=uuid(proposalInput,'proposalId');
  const b=input(body,['reworkId','qcRunId','qcRunVersion','idempotencyKey','decision','note']),cmd=pin(b);
  if (b.decision!=='ACKNOWLEDGE' && b.decision!=='DISPUTE') throw AppError.validation('decision must be ACKNOWLEDGE or DISPUTE.');
  const responseType=b.decision==='ACKNOWLEDGE'?'ACKNOWLEDGED':'DISPUTED', responseNote=note(b.note);
  if (responseType==='ACKNOWLEDGED' && responseNote!==null) throw AppError.validation('Only disputes may include a note.');
  try { return await withTransaction(async tx=>{
    const ctx=await context(tx,actor,claimId); if (!(await exactPic(tx,actor,ctx))) throw denied();
    const p=await proposal(tx,claimId,proposalId); samePin(p,cmd);
    const prior=(await tx.query<Event>(`SELECT * FROM handyman_warranty_resolution_events
      WHERE proposal_id=$1 AND event_type IN ('ACKNOWLEDGED','DISPUTED')`,[p.id])).rows[0];
    if (prior) {
      if (prior.idempotency_key!==cmd.idempotencyKey || prior.actor_user_id!==actor.userId ||
          prior.event_type!==responseType || prior.note!==responseNote) throw conflict('This proposal already has a Tenant PIC response.');
      return {proposal:proposalView(p),event:eventView(prior),replayed:true};
    }
    if (await finalEvent(tx,claimId)) throw conflict('This claim is already resolved.');
    await currentProposal(tx,ctx,p);
    const event=(await tx.query<Event>(`INSERT INTO handyman_warranty_resolution_events
      (id,proposal_id,claim_id,event_type,actor_user_id,actor_session_id,note,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(),p.id,claimId,responseType,actor.userId,actor.sessionId,responseNote,cmd.idempotencyKey])).rows[0];
    return {proposal:proposalView(p),event:eventView(event),replayed:false};
  }); } catch(error) { return mapDbConflict(error); }
}

/** Operations may finalize only the same current result acknowledged by the PIC. */
export async function finalizeClaimResolution(actor:Actor,claimInput:string,proposalInput:string,body:unknown) {
  const claimId=uuid(claimInput,'claimId'),proposalId=uuid(proposalInput,'proposalId');
  const cmd=pin(input(body,['reworkId','qcRunId','qcRunVersion','idempotencyKey']));
  try { return await withTransaction(async tx=>{
    const ctx=await context(tx,actor,claimId); await operations(tx,actor,ctx);
    const p=await proposal(tx,claimId,proposalId); samePin(p,cmd);
    const final=await finalEvent(tx,claimId);
    if (final) {
      if (final.proposal_id!==p.id || final.actor_user_id!==actor.userId || final.idempotency_key!==cmd.idempotencyKey)
        throw conflict('This claim is already resolved.');
      return {proposal:proposalView(p),event:eventView(final),resolutionStatus:'RESOLVED',replayed:true};
    }
    const response=(await tx.query<Event>(`SELECT * FROM handyman_warranty_resolution_events WHERE proposal_id=$1
      AND event_type IN ('ACKNOWLEDGED','DISPUTED')`,[p.id])).rows[0];
    if (response?.event_type!=='ACKNOWLEDGED') throw conflict('The exact proposal needs Tenant PIC acknowledgment; a dispute remains open.');
    await currentProposal(tx,ctx,p);
    const event=(await tx.query<Event>(`INSERT INTO handyman_warranty_resolution_events
      (id,proposal_id,claim_id,event_type,actor_user_id,actor_session_id,idempotency_key)
      VALUES($1,$2,$3,'RESOLVED',$4,$5,$6) RETURNING *`,
      [randomUUID(),p.id,claimId,actor.userId,actor.sessionId,cmd.idempotencyKey])).rows[0];
    return {proposal:proposalView(p),event:eventView(event),resolutionStatus:'RESOLVED',replayed:false};
  }); } catch(error) { return mapDbConflict(error); }
}

/** The exact PIC and Operations can inspect the recorded result before acting. */
export async function readClaimResolution(actor:Actor,claimInput:string) {
  const claimId=uuid(claimInput,'claimId');
  return withTransaction(async tx=>{
    const ctx=await context(tx,actor,claimId);
    if (!(await exactPic(tx,actor,ctx))) await operations(tx,actor,ctx);
    const proposals=(await tx.query<Proposal>(`SELECT * FROM handyman_warranty_resolution_proposals
      WHERE claim_id=$1 ORDER BY proposed_at DESC,id DESC`,[claimId])).rows;
    const events=(await tx.query<Event>(`SELECT * FROM handyman_warranty_resolution_events
      WHERE claim_id=$1 ORDER BY occurred_at,id`,[claimId])).rows;
    const final=events.find(e=>e.event_type==='RESOLVED');
    return {claimId,decisionStatus:ctx.claim_status,resolutionStatus:final?'RESOLVED':'OPEN',
      proposals:proposals.map(p=>({...proposalView(p),events:events.filter(e=>e.proposal_id===p.id).map(eventView)}))};
  });
}
