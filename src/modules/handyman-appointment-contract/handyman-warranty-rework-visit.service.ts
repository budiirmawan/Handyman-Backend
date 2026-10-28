import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { resolveHandymanAssignmentLead } from '../handyman-scope-assignments';
import { readCoveredWarrantyClaimApproval } from '../handyman-service-warranty-claims/handyman-warranty-claim-assessment.service';
import { assertWarrantyReworkOperations } from '../handyman-service-warranty-reworks/handyman-warranty-rework-authority';
import { recordOperationalEvent } from '../operational-events';
import { insertHandymanVisitProposal } from './handyman-appointment.repository';
import { assertVisitResourceAdmission, conflict, encode, requestScope } from './handyman-visit-api.service';
import { parseVisitWindow } from './handyman-visit-api.validation';

type Context = {
  rework_id:string; execution_scope_id:string; original_scope_id:string; claim_id:string; assessment_id:string;
  certificate_id:string; item_line_id:string; client_id:string; building_id:string; handyman_request_id:string;
  tenant_company_id:string; tenant_pic_id:string|null; rework_status:string;
};
type Visit = { id:string; state:string; version:number; start_at:Date; end_at:Date; resource_id:string;
  supersedes_appointment_id:string|null; warranty_rework_key:string; created_by_user_id:string;
  tenant_choice_evidence_ref:string|null; assignment_id:string; lead_user_id:string; crew_id:string };
const forbidden = () => new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,
  message:'The exact request Tenant PIC or authorized Operations actor is required.'});
const key = (value:unknown) => {
  if (typeof value!=='string' || !value.trim() || value.trim().length>200) throw AppError.validation('A valid idempotencyKey is required.');
  return value.trim();
};
const version = (value:unknown) => {
  if (!Number.isSafeInteger(value) || (value as number)<1) throw AppError.validation('A positive version is required.');
  return value as number;
};

/** Request → original scope → rework scope is the common lock order. */
async function context(tx:PoolClient,reworkId:string):Promise<{ctx:Context; req:Awaited<ReturnType<typeof requestScope>>}> {
  const initial=(await tx.query<{handyman_request_id:string;original_scope_id:string;execution_scope_id:string}>(`
    SELECT s.handyman_request_id,x.original_scope_id,x.execution_scope_id FROM handyman_warranty_rework_executions x
    JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id WHERE x.rework_id=$1`,[reworkId])).rows[0];
  if (!initial) throw AppError.notFound('Warranty rework execution not found.');
  const req=await requestScope(tx,initial.handyman_request_id,true);
  await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR SHARE',[initial.original_scope_id]);
  await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE',[initial.execution_scope_id]);
  const ctx=(await tx.query<Context>(`SELECT x.rework_id,x.execution_scope_id,x.original_scope_id,x.claim_id,x.assessment_id,
      x.certificate_id,x.item_line_id,x.client_id,x.building_id,s.handyman_request_id,s.tenant_company_id,s.tenant_pic_id,
      r.status AS rework_status FROM handyman_warranty_rework_executions x
      JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id
      JOIN handyman_service_warranty_reworks r ON r.id=x.rework_id
      WHERE x.rework_id=$1 AND hm_warranty_rework_scope_current(x.execution_scope_id) FOR SHARE OF r,x`,[reworkId])).rows[0];
  if (!ctx || !(await readCoveredWarrantyClaimApproval(tx,ctx.claim_id)))
    throw conflict('The certificate-bound COVERED claim assessment is no longer current.');
  return {ctx,req};
}
function requireBeforeStart(ctx:Context) {
  if (ctx.rework_status!=='REWORK_AUTHORIZED') throw conflict('Rework scheduling is closed after execution starts.');
}
async function operations(tx:PoolClient,ctx:Context,actor:string) {
  await assertWarrantyReworkOperations(tx,{clientId:ctx.client_id,buildingId:ctx.building_id,handymanRequestId:ctx.handyman_request_id},actor);
}
async function exactPic(tx:PoolClient,ctx:Context,actor:string,sessionId:string):Promise<string> {
  await assertBuildingScopedResourceAccess(actor,{clientId:ctx.client_id,buildingId:ctx.building_id},tx);
  const pic=(await tx.query<{id:string}>(`SELECT p.id FROM tenant_pics p JOIN users u ON u.id=p.user_id AND u.status='ACTIVE'
    JOIN user_sessions sess ON sess.id=$4 AND sess.user_id=u.id AND sess.status='ACTIVE' AND sess.expires_at>clock_timestamp()
    WHERE p.id=$1 AND p.tenant_company_id=$2 AND p.user_id=$3 AND p.status='ACTIVE' FOR SHARE OF p,u,sess`,
    [ctx.tenant_pic_id,ctx.tenant_company_id,actor,sessionId])).rows[0];
  if (!pic) throw forbidden();
  return pic.id;
}
async function assignedLead(tx:PoolClient,ctx:Context,actor:string) {
  const assignment=(await tx.query<{handyman_crew_id:string}>(`SELECT handyman_crew_id FROM handyman_execution_scope_assignments
    WHERE execution_scope_id=$1 AND status='ACTIVE'`,[ctx.execution_scope_id])).rows[0];
  if (!assignment) throw conflict('An active assigned Crew Leader is required.');
  await tx.query('SELECT id FROM handyman_work_crews WHERE id=$1 FOR UPDATE',[assignment.handyman_crew_id]);
  const lead=await resolveHandymanAssignmentLead(ctx.execution_scope_id,actor,tx);
  if (!lead || (await tx.query(`SELECT 1 FROM handyman_assignment_responses
      WHERE assignment_id=$1 AND response_status='TIDAK_BISA'`,[lead.assignmentId])).rowCount)
    throw conflict('The assigned Crew Leader is unavailable or has declined.');
  return lead;
}
async function visit(tx:PoolClient,reworkId:string,appointmentId:string,lock=true):Promise<Visit> {
  const row=(await tx.query<Visit>(`SELECT a.id,a.state,a.version,a.start_at,a.end_at,a.resource_id,a.supersedes_appointment_id,
      a.warranty_rework_key,a.created_by_user_id,a.tenant_choice_evidence_ref,b.assignment_id,b.lead_user_id,b.crew_id
    FROM handyman_visit_appointments a JOIN handyman_warranty_rework_visit_bindings b ON b.appointment_id=a.id
    WHERE a.id=$1 AND a.warranty_rework_id=$2 AND b.rework_id=$2 ${lock?'FOR UPDATE OF a':''}`,
    [appointmentId,reworkId])).rows[0];
  if (!row) throw AppError.notFound('Rework appointment not found.');
  return row;
}
/** Revalidate the pinned assignment and exact approved claim at consent/confirmation/read. */
export async function assertReworkVisitCurrent(tx:PoolClient,appointmentId:string,actor:string):Promise<{ctx:Context; row:Visit}> {
  const id=(await tx.query<{rework_id:string}>('SELECT rework_id FROM handyman_warranty_rework_visit_bindings WHERE appointment_id=$1',[appointmentId])).rows[0];
  if (!id) throw AppError.notFound('Rework appointment not found.');
  const {ctx}=await context(tx,id.rework_id);
  requireBeforeStart(ctx);
  const row=await visit(tx,ctx.rework_id,appointmentId);
  const lead=await assignedLead(tx,ctx,actor);
  if (lead.assignmentId!==row.assignment_id || lead.crewId!==row.crew_id || lead.leadUserId!==row.lead_user_id)
    throw conflict('The rework visit belongs to an earlier crew assignment; cancel and reschedule.');
  return {ctx,row};
}

export async function proposeWarrantyReworkVisit(actor:string,reworkId:string,input:{startAt:string;endAt:string;idempotencyKey:string;supersedesAppointmentId?:string|null}) {
  const idem=key(input.idempotencyKey);
  let interval:{startAt:string;endAt:string};
  try { interval=parseVisitWindow(input.startAt,input.endAt); } catch { throw AppError.validation('A future visit slot of at most 24 hours is required.'); }
  return withTransaction(async tx=>{
    const {ctx,req}=await context(tx,reworkId); await operations(tx,ctx,actor); requireBeforeStart(ctx);
    if (!req.timezone) throw conflict('Building timezone is not configured.');
    try { new Intl.DateTimeFormat('en',{timeZone:req.timezone}).format(new Date()); } catch { throw conflict('Building timezone is invalid.'); }
    const lead=await assignedLead(tx,ctx,actor);
    await assertVisitResourceAdmission(tx,req,{kind:'EXECUTION',resourceId:lead.crewId,executionScopeId:ctx.execution_scope_id});
    const prior=(await tx.query<{id:string;created_by_user_id:string;start_at:Date;end_at:Date;supersedes_appointment_id:string|null}>(`
      SELECT id,created_by_user_id,start_at,end_at,supersedes_appointment_id FROM handyman_visit_appointments
      WHERE warranty_rework_id=$1 AND warranty_rework_key=$2`,[reworkId,idem])).rows[0];
    if (prior) {
      if (prior.created_by_user_id!==actor || prior.start_at.getTime()!==Date.parse(interval.startAt) ||
          prior.end_at.getTime()!==Date.parse(interval.endAt) || prior.supersedes_appointment_id!==(input.supersedesAppointmentId??null))
        throw conflict('The proposal key was already used with different appointment details.');
      return {appointmentId:prior.id,replayed:true};
    }
    const previous=(await tx.query<{id:string;state:string}>(`SELECT a.id,a.state FROM handyman_visit_appointments a
      WHERE a.warranty_rework_id=$1 AND NOT EXISTS (SELECT 1 FROM handyman_visit_appointments newer
        WHERE newer.warranty_rework_id=$1 AND newer.supersedes_appointment_id=a.id) LIMIT 1`,[reworkId])).rows[0];
    if ((!previous && input.supersedesAppointmentId) || (previous &&
        (previous.state!=='CANCELLED' || previous.id!==input.supersedesAppointmentId)))
      throw conflict('Cancel the latest rework visit and explicitly supersede it before rescheduling.');
    const created=await insertHandymanVisitProposal(tx,{handymanRequestId:ctx.handyman_request_id,kind:'EXECUTION',
      resourceId:lead.crewId,executionScopeId:ctx.execution_scope_id,interval:{...interval,timezone:req.timezone},
      createdByUserId:actor,warrantyReworkKey:idem,supersedesAppointmentId:input.supersedesAppointmentId??null});
    await recordOperationalEvent({clientId:ctx.client_id,buildingId:ctx.building_id,entityType:'HANDYMAN_VISIT_APPOINTMENT',
      entityId:created.id,actorUserId:actor,eventType:'HANDYMAN_REWORK_VISIT_PROPOSED',
      summary:'Warranty rework visit proposed; tenant consent and Operations confirmation remain required.',
      metadata:{reworkId,claimId:ctx.claim_id,assessmentId:ctx.assessment_id,executionScopeId:ctx.execution_scope_id,
        assignmentId:lead.assignmentId,leadUserId:lead.leadUserId,supersedesAppointmentId:input.supersedesAppointmentId??null}},tx);
    return {appointmentId:created.id,appointment:encode(created),replayed:false};
  });
}

/** Local authenticated PIC action: no Care actor, uploaded statement or request-level choice is accepted. */
export async function consentWarrantyReworkVisit(actor:string,sessionId:string,reworkId:string,appointmentId:string,input:{version:number;idempotencyKey:string}) {
  const expected=version(input.version), idem=key(input.idempotencyKey);
  return withTransaction(async tx=>{
    const {ctx,row}=await assertReworkVisitCurrent(tx,appointmentId,actor);
    if (ctx.rework_id!==reworkId) throw AppError.notFound('Rework appointment not found.');
    const pic=await exactPic(tx,ctx,actor,sessionId);
    const prior=(await tx.query<{id:string;tenant_user_id:string;appointment_version:number;idempotency_key:string}>(
      'SELECT id,tenant_user_id,appointment_version,idempotency_key FROM handyman_warranty_rework_visit_consents WHERE appointment_id=$1',[appointmentId])).rows[0];
    if (prior) {
      if (prior.tenant_user_id!==actor || prior.appointment_version!==expected || prior.idempotency_key!==idem)
        throw conflict('This appointment already has a different consent decision.');
      return {appointmentId,consentId:prior.id,state:row.state,version:row.version,replayed:true};
    }
    if (row.state!=='PROPOSED' || row.version!==expected || row.start_at.getTime()<=Date.now())
      throw conflict('Only the exact current future proposal can receive consent.');
    const consentId=randomUUID();
    await tx.query(`INSERT INTO handyman_warranty_rework_visit_consents
      (id,appointment_id,rework_id,execution_scope_id,claim_id,assessment_id,client_id,building_id,
       tenant_pic_id,tenant_user_id,tenant_session_id,appointment_version,start_at,end_at,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [consentId,appointmentId,reworkId,ctx.execution_scope_id,ctx.claim_id,ctx.assessment_id,ctx.client_id,
        ctx.building_id,pic,actor,sessionId,expected,row.start_at,row.end_at,idem]);
    const updated=(await tx.query<{state:string;version:number}>(`UPDATE handyman_visit_appointments
      SET state='TENANT_SELECTED',tenant_choice_evidence_ref=$2,version=version+1,updated_at=now()
      WHERE id=$1 AND state='PROPOSED' AND version=$3 RETURNING state,version`,[appointmentId,consentId,expected])).rows[0];
    if (!updated) throw conflict('The proposed visit changed during consent.');
    await recordOperationalEvent({clientId:ctx.client_id,buildingId:ctx.building_id,entityType:'HANDYMAN_VISIT_APPOINTMENT',
      entityId:appointmentId,actorUserId:actor,eventType:'HANDYMAN_REWORK_VISIT_TENANT_CONSENT',
      summary:'Authenticated request Tenant PIC consented to this exact warranty rework slot; booking is not confirmed.',
      metadata:{reworkId,claimId:ctx.claim_id,assessmentId:ctx.assessment_id,consentId,tenantPicId:pic,appointmentVersion:expected}},tx);
    return {appointmentId,consentId,...updated,replayed:false};
  });
}

export async function cancelWarrantyReworkVisit(actor:string,reworkId:string,appointmentId:string,input:{version:number;reason:string}) {
  const expected=version(input.version);
  const reason=typeof input.reason==='string'?input.reason.trim():'';
  if (!reason || reason.length>1000) throw AppError.validation('A cancellation reason is required.');
  return withTransaction(async tx=>{
    const {ctx}=await context(tx,reworkId); await operations(tx,ctx,actor); requireBeforeStart(ctx);
    const row=await visit(tx,reworkId,appointmentId);
    if (row.version!==expected || !['PROPOSED','TENANT_SELECTED','CONFIRMED'].includes(row.state))
      throw conflict('Only the current unstarted rework visit can be cancelled.');
    if ((await tx.query(`SELECT 1 FROM handyman_dispatch_releases WHERE execution_scope_id=$1
      AND status IN ('RELEASED','IN_PROGRESS')`,[ctx.execution_scope_id])).rowCount)
      throw conflict('Cancel the active dispatch release before cancelling this appointment.');
    const changed=(await tx.query<{state:string;version:number}>(`UPDATE handyman_visit_appointments
      SET state='CANCELLED',cancelled_by_user_id=$2,cancelled_at=now(),version=version+1,updated_at=now()
      WHERE id=$1 AND version=$3 RETURNING state,version`,[appointmentId,actor,expected])).rows[0];
    if (!changed) throw conflict('The appointment changed during cancellation.');
    await tx.query(`UPDATE handyman_visit_capacity_reservations SET active=false,released_at=now()
      WHERE appointment_id=$1 AND active`,[appointmentId]);
    await recordOperationalEvent({clientId:ctx.client_id,buildingId:ctx.building_id,entityType:'HANDYMAN_VISIT_APPOINTMENT',
      entityId:appointmentId,actorUserId:actor,eventType:'HANDYMAN_REWORK_VISIT_CANCELLED',
      summary:'Warranty rework visit cancelled; a replacement requires new tenant consent.',
      metadata:{reworkId,claimId:ctx.claim_id,reason,previousVersion:expected}},tx);
    return {appointmentId,...changed};
  });
}

/** Only appointment readiness is claimed: BM permits, access and dispatch remain separate. */
export async function readWarrantyReworkVisit(actor:string,reworkId:string) {
  return withTransaction(async tx=>{
    const {ctx}=await context(tx,reworkId);
    await assertBuildingScopedResourceAccess(actor,{clientId:ctx.client_id,buildingId:ctx.building_id},tx);
    const pic=(await tx.query('SELECT 1 FROM tenant_pics WHERE id=$1 AND user_id=$2 AND status=\'ACTIVE\'', [ctx.tenant_pic_id,actor])).rowCount;
    if (!pic) {
      const lead=await resolveHandymanAssignmentLead(ctx.execution_scope_id,actor,tx).catch(()=>null);
      if (lead?.leadUserId!==actor) await operations(tx,ctx,actor);
    }
    const latest=(await tx.query<{id:string}>(`SELECT a.id FROM handyman_visit_appointments a WHERE a.warranty_rework_id=$1
      AND NOT EXISTS (SELECT 1 FROM handyman_visit_appointments newer
        WHERE newer.warranty_rework_id=$1 AND newer.supersedes_appointment_id=a.id) LIMIT 1`,[reworkId])).rows[0];
    if (!latest) return {reworkId,executionScopeId:ctx.execution_scope_id,appointment:null,appointmentReady:false,
      dispatchAndBmChecksRequired:true};
    const row=await visit(tx,reworkId,latest.id);
    let current=false;
    if (ctx.rework_status==='REWORK_AUTHORIZED' && row.state==='CONFIRMED') {
      try { await assertReworkVisitCurrent(tx,row.id,actor); current=true; } catch { current=false; }
    }
    const consent=(await tx.query<{id:string}>(`SELECT id FROM handyman_warranty_rework_visit_consents
      WHERE appointment_id=$1 AND id::text=$2 AND start_at=$3 AND end_at=$4`,
      [row.id,row.tenant_choice_evidence_ref,row.start_at,row.end_at])).rows[0];
    const capacity=(await tx.query(`SELECT 1 FROM handyman_visit_capacity_reservations WHERE appointment_id=$1 AND active`,[row.id])).rowCount;
    return {reworkId,executionScopeId:ctx.execution_scope_id,claimId:ctx.claim_id,assessmentId:ctx.assessment_id,
      appointment:{id:row.id,state:row.state,version:row.version,startAt:row.start_at.toISOString(),endAt:row.end_at.toISOString(),
        crewId:row.crew_id,leadUserId:row.lead_user_id,supersedesAppointmentId:row.supersedes_appointment_id,
        tenantConsentVerified:!!consent},appointmentReady:!!(current && consent && capacity && row.end_at.getTime()>Date.now()),
      dispatchAndBmChecksRequired:true};
  });
}
