import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError, canAccessBuildingScopedResource } from '../context-access';
import { permissionRepository } from '../permissions';
import type { BuyerBindingDecision, BuyerBindingPin, BuyerBindingSnapshot, BuyerBindingView, DecideBuyerBinding,
  ProposeBuyerBinding, ResolveBuyerBinding, VerifiedBuyerBinding } from './handyman-buyer-binding.types';

type Code = 'HANDYMAN_BUYER_INVALID' | 'HANDYMAN_BUYER_MISSING' | 'HANDYMAN_BUYER_CONFLICT' |
  'HANDYMAN_BUYER_STALE' | 'HANDYMAN_BUYER_UNVERIFIED' | 'HANDYMAN_BUYER_INTEGRITY_ERROR';
const error = (code:Code,message:string,statusCode=409) => new AppError({code:ERROR_CODES[code],message,statusCode});
const invalid = (field:string) => error('HANDYMAN_BUYER_INVALID',`Invalid ${field}.`,400);
const missing = () => error('HANDYMAN_BUYER_MISSING','No current buyer binding exists for this request.');
const conflict = () => error('HANDYMAN_BUYER_CONFLICT','Buyer designation or version conflicts with the request.');
const stale = () => error('HANDYMAN_BUYER_STALE','Buyer binding is superseded or its source facts have changed.');
const unverified = () => error('HANDYMAN_BUYER_UNVERIFIED','Buyer or binding is not independently verified at the required instant.');
const integrity = () => error('HANDYMAN_BUYER_INTEGRITY_ERROR','Buyer binding provenance failed integrity checks.');
const hash = (value:unknown) => createHash('sha256').update(stableJson(value),'utf8').digest('hex');
function keys(value:unknown,allowed:readonly string[],field:string):void {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k))) throw invalid(field);
}
function uuid(value:unknown,field:string):string {
  if(typeof value!=='string' || !isValidUuid(value)) throw invalid(field);return value.toLowerCase();
}
function number(value:unknown,field:string):number {
  if(!Number.isSafeInteger(value) || (value as number)<1 || (value as number)>2_147_483_647) throw invalid(field);return value as number;
}
function digest(value:unknown,field:string):string {
  if(typeof value!=='string' || !/^[0-9a-f]{64}$/.test(value)) throw invalid(field);return value;
}
function text(value:unknown,field:string,max:number):string {
  if(typeof value!=='string' || value!==value.trim() || value.length<1 || value.length>max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(field);
  return value;
}
export function buyerInstant(value:unknown):string {
  const m=typeof value==='string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-](\d\d):(\d\d))$/.exec(value);
  if(!m)throw invalid('at');
  const y=+m[1],month=+m[2],day=+m[3], leap=y%4===0 && (y%100!==0 || y%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(y<1 || month<1 || month>12 || day<1 || day>days[month-1] || +m[4]>23 || +m[5]>59 || +m[6]>59 ||
    (m[8] && (+m[8]>14 || +m[9]>59 || (+m[8]===14 && +m[9]!==0))))throw invalid('at');
  const parsed=new Date(value as string);if(!Number.isFinite(parsed.getTime()))throw invalid('at');return parsed.toISOString();
}
function parsePin(input:BuyerBindingPin):BuyerBindingPin {
  keys(input,['bindingId','bindingVersion','bindingDigest','decisionId','decisionDigest'],'pin');
  return {bindingId:uuid(input.bindingId,'pin.bindingId'),bindingVersion:number(input.bindingVersion,'pin.bindingVersion'),
    bindingDigest:digest(input.bindingDigest,'pin.bindingDigest'),decisionId:uuid(input.decisionId,'pin.decisionId'),
    decisionDigest:digest(input.decisionDigest,'pin.decisionDigest')};
}
function pgConflict(err:unknown):never {
  const code=(err as {code?:string})?.code;
  if(code==='23505' || code==='40001' || code==='40P01') throw conflict();
  throw err;
}

async function access(tx:PoolClient,actor:string,clientId:string,requestId:string,mode:'maker'|'checker'|'read'):Promise<string> {
  const user=await tx.query('SELECT status FROM users WHERE id=$1',[actor]);
  if(user.rows[0]?.status!=='ACTIVE')throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'An active Finance actor is required.'});
  const permissions=await permissionRepository.listActivePermissionCodesForUser(actor,tx);
  if(!permissions.includes(mode==='maker'?'handyman.finance.manage':'handyman.finance.read') ||
     (mode==='checker' && !permissions.includes('handyman.tax_identity.approve')))
    throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Explicit Finance authority is required.'});
  const r=await tx.query('SELECT building_id FROM handyman_service_requests WHERE id=$1 AND client_id=$2',[requestId,clientId]);
  if(!r.rows[0] || !(await canAccessBuildingScopedResource(actor,{clientId,buildingId:r.rows[0].building_id},tx))) throw buildingAccessDeniedError();
  return r.rows[0].building_id as string;
}

type Context = Omit<BuyerBindingSnapshot,'schema'|'id'|'version'|'previousBindingId'|'evidenceSource'|'evidenceReference'|'createdByUserId'>;
/** Re-proves the request, master party, location, designation and provenance; never infers buyer from PIC/creator. */
async function context(tx:PoolClient,clientId:string,requestId:string,buyerId:string,lock:boolean,at?:string):Promise<Context> {
  const row=(await tx.query(`SELECT r.id AS request_id,r.client_id,r.building_id,b.property_id,r.space_id,
    r.tenant_company_id AS represented_id,r.tenant_pic_id,r.created_by_user_id AS request_creator,
    r.channel_attribution_id,r.unlisted_intake_case_id,r.intake_source,r.origin_channel,r.origin_reference,
    a.client_id AS attr_client,a.building_id AS attr_building,a.tenant_company_id AS attr_tenant,a.tenant_pic_id AS attr_pic,
    a.space_id AS attr_space,a.origin_channel AS attr_channel,a.origin_reference AS attr_reference,a.actor_type,a.care_actor_id,
    t.id AS buyer_id,t.client_id AS buyer_client,t.party_kind,t.tenant_name,t.legal_name,t.status AS buyer_status,
    t.verification_status,t.identity_document_type,t.identity_document_number,
    EXISTS (SELECT 1 FROM handyman_bm_legal_counterparties bm WHERE bm.id=t.id AND bm.client_id=r.client_id) AS colliding_bm_id,
    pic.tenant_company_id AS pic_tenant,
    rp.id AS cost_id,rp.tenant_company_id AS cost_buyer,
    uc.id AS case_id,uc.client_id AS case_client,uc.building_id AS case_building,uc.tenant_company_id AS case_tenant,
    uc.tenant_pic_id AS case_pic,uc.space_id AS case_space,uc.cost_responsible_tenant_company_id AS case_buyer,
    uc.origin_channel AS case_channel,uc.created_by_care_actor_id AS case_care_actor,st.converted_request_id,
    ur.id AS unit_role_id,ur.party_role AS unit_role_kind,
    to_char(ur.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS unit_role_from,
    to_char(ur.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS unit_role_until,
    (ur.id IS NOT NULL AND ($4::timestamptz IS NULL OR (ur.effective_from<=$4 AND (ur.effective_until IS NULL OR ur.effective_until>$4)))) AS role_at,
    (r.space_id IS NULL OR EXISTS (SELECT 1 FROM spaces s JOIN rooms rm ON rm.id=s.room_id
      JOIN areas ar ON ar.id=rm.area_id JOIN floors fl ON fl.id=ar.floor_id
      WHERE s.id=r.space_id AND s.status='ACTIVE' AND fl.building_id=r.building_id)) AS valid_space
    FROM handyman_service_requests r
    JOIN buildings b ON b.id=r.building_id JOIN properties p ON p.id=b.property_id AND p.client_id=r.client_id
    JOIN tenant_companies represented ON represented.id=r.tenant_company_id AND represented.client_id=r.client_id AND represented.status='ACTIVE'
    JOIN tenant_companies t ON t.id=$3 AND t.client_id=r.client_id
    LEFT JOIN tenant_pics pic ON pic.id=r.tenant_pic_id
    LEFT JOIN handyman_channel_attributions a ON a.id=r.channel_attribution_id
    LEFT JOIN handyman_request_parties rp ON rp.request_id=r.id AND rp.client_id=r.client_id AND rp.party_role='COST_RESPONSIBILITY'
    LEFT JOIN LATERAL (SELECT role.id,role.party_role,role.effective_from,role.effective_until FROM unit_party_roles role
      WHERE role.client_id=r.client_id AND role.building_id=r.building_id AND role.space_id=r.space_id AND role.tenant_company_id=t.id
        AND role.status='ACTIVE' AND role.effective_from<=clock_timestamp()
        AND (role.effective_until IS NULL OR role.effective_until>clock_timestamp())
        AND (role.party_role IN ('OWNER','OCCUPANT') OR (role.party_role='PIC' AND rp.tenant_company_id=t.id))
      ORDER BY role.id LIMIT 1) ur ON true
    LEFT JOIN handyman_unlisted_service_intake_cases uc ON uc.id=r.unlisted_intake_case_id
    LEFT JOIN handyman_unlisted_intake_triage_state st ON st.intake_case_id=uc.id
    WHERE r.id=$1 AND r.client_id=$2 ${lock?'FOR SHARE OF r,b,p,t,represented':''}`,[requestId,clientId,buyerId,at??null])).rows[0];
  if(!row || !row.valid_space || row.colliding_bm_id)throw conflict();
  if(row.buyer_status!=='ACTIVE' || row.verification_status!=='VERIFIED')throw unverified();
  if(!['INDIVIDUAL','LEGAL_ENTITY'].includes(row.party_kind))throw unverified();
  const legalName=row.party_kind==='INDIVIDUAL'?row.tenant_name:row.legal_name;
  if(typeof legalName!=='string' || legalName.length<1 || legalName.length>200 || legalName!==legalName.trim() || /[\u0000-\u001f\u007f]/.test(legalName)) throw unverified();
  if(row.tenant_pic_id && row.pic_tenant!==row.represented_id)throw conflict();
  if(row.channel_attribution_id && (row.attr_client!==clientId || row.attr_building!==row.building_id || row.attr_tenant!==row.represented_id ||
    row.attr_pic!==row.tenant_pic_id || row.attr_space!==row.space_id || row.attr_channel!==row.origin_channel || row.attr_reference!==row.origin_reference))throw conflict();
  if(row.intake_source==='CATALOG' && !row.channel_attribution_id)throw conflict();
  if(row.intake_source==='UNLISTED_TRIAGE' && (row.case_id!==row.unlisted_intake_case_id || row.case_client!==clientId ||
    row.case_building!==row.building_id || row.case_tenant!==row.represented_id || row.case_pic!==row.tenant_pic_id || row.case_space!==row.space_id ||
    row.case_channel!==row.origin_channel || row.converted_request_id!==requestId || row.case_buyer!==buyerId))throw conflict();
  if(row.cost_id && row.cost_buyer!==buyerId)throw conflict();
  const represented=row.represented_id===buyerId;
  if(!represented && (!row.unit_role_id || !row.role_at))throw conflict();
  if(lock && row.unit_role_id && !represented){
    const role=await tx.query(`SELECT id FROM unit_party_roles WHERE id=$1 AND status='ACTIVE' AND effective_from<=clock_timestamp()
      AND (effective_until IS NULL OR effective_until>clock_timestamp()) FOR SHARE`,[row.unit_role_id]);
    if(!role.rowCount)throw conflict();
  }
  const master={id:row.buyer_id,clientId:row.buyer_client,partyKind:row.party_kind,tenantName:row.tenant_name,legalName:row.legal_name,
    status:row.buyer_status,verificationStatus:row.verification_status,identityDocumentType:row.identity_document_type,identityDocumentNumber:row.identity_document_number};
  return {clientId,requestId,buildingId:row.building_id,propertyId:row.property_id,spaceId:row.space_id,
    representedTenantCompanyId:row.represented_id,tenantPicId:row.tenant_pic_id,requestCreatedByUserId:row.request_creator,
    channelAttributionId:row.channel_attribution_id,unlistedIntakeCaseId:row.unlisted_intake_case_id,originChannel:row.origin_channel,
    originActorType:row.actor_type ?? (row.case_care_actor?'CUSTOMER_CARE':null),originCareActorId:row.care_actor_id ?? row.case_care_actor ?? null,
    costResponsibilityId:row.cost_id,buyerTenantCompanyId:buyerId,buyerKind:row.party_kind,buyerLegalName:legalName,
    buyerMasterDigest:hash(master),relationKind:represented?'REPRESENTED_TENANT':'UNIT_ROLE',unitPartyRoleId:represented?null:row.unit_role_id,
    unitRoleKind:represented?null:row.unit_role_kind,unitRoleFrom:represented?null:row.unit_role_from,
    unitRoleUntil:represented?null:row.unit_role_until,consentAuthority:'NOT_ASSERTED'};
}
const SNAPSHOT_KEYS = new Set([
  'schema','id','version','previousBindingId','clientId','requestId','buildingId','propertyId','spaceId',
  'representedTenantCompanyId','tenantPicId','requestCreatedByUserId','channelAttributionId','unlistedIntakeCaseId',
  'originChannel','originActorType','originCareActorId','costResponsibilityId','buyerTenantCompanyId','buyerKind','buyerLegalName',
  'buyerMasterDigest','relationKind','unitPartyRoleId','unitRoleKind','unitRoleFrom','unitRoleUntil','consentAuthority',
  'evidenceSource','evidenceReference','createdByUserId',
]);
function view(row:{snapshot:BuyerBindingSnapshot;digest:string;created_at:Date}):BuyerBindingView {
  const s=row.snapshot;
  if(!s || Object.keys(s).length!==SNAPSHOT_KEYS.size || Object.keys(s).some(k=>!SNAPSHOT_KEYS.has(k)) ||
    row.digest!==hash(s) || s.schema!=='HANDYMAN_BUYER_BINDING_V1' || s.consentAuthority!=='NOT_ASSERTED' ||
    !/^[0-9a-f]{64}$/.test(s.buyerMasterDigest) || !Number.isSafeInteger(s.version) || s.version<1 ||
    typeof s.evidenceSource!=='string' || s.evidenceSource!==s.evidenceSource.trim() || s.evidenceSource.length<1 || s.evidenceSource.length>200 ||
    typeof s.evidenceReference!=='string' || s.evidenceReference!==s.evidenceReference.trim() || s.evidenceReference.length<1 || s.evidenceReference.length>500 ||
    /[\u0000-\u001f\u007f]/.test(s.evidenceSource+s.evidenceReference) ||
    !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime()))throw integrity();
  return Object.freeze({snapshot:Object.freeze({...s}),digestAlgorithm:'SHA-256',digest:row.digest,createdAt:row.created_at.toISOString()});
}
function decision(row:Record<string,any>):BuyerBindingDecision {
  const body={id:row.id,bindingId:row.binding_id,requestId:row.request_id,clientId:row.client_id,buildingId:row.building_id,
    bindingVersion:row.binding_version,bindingDigest:row.binding_digest,decision:row.decision,evidenceSource:row.evidence_source,
    evidenceReference:row.evidence_reference,actorUserId:row.actor_user_id,occurredAt:row.occurred_at.toISOString()};
  if(row.decision_digest!==hash(body))throw integrity();
  return Object.freeze({...body,decisionDigest:row.decision_digest});
}
function assertCurrent(snapshot:BuyerBindingSnapshot,current:Context):void {
  for(const [key,value] of Object.entries(current)) if((snapshot as unknown as Record<string,unknown>)[key]!==value)throw stale();
}
async function currentContext(tx:PoolClient,clientId:string,requestId:string,buyerId:string,lock:boolean,at?:string):Promise<Context> {
  try{return await context(tx,clientId,requestId,buyerId,lock,at);}catch(e){
    if(['HANDYMAN_BUYER_CONFLICT','HANDYMAN_BUYER_UNVERIFIED'].includes((e as {code?:string}).code??''))throw stale();throw e;
  }
}

/** Proposes one immutable buyer assertion; never changes request, quotation, invoice or financial facts. */
export async function proposeHandymanBuyerBinding(actorInput:string,input:ProposeBuyerBinding):Promise<BuyerBindingView> {
  keys(input,['clientId','requestId','buyerTenantCompanyId','expectedVersion','evidenceSource','evidenceReference'],'input');
  const actor=uuid(actorInput,'actor'),clientId=uuid(input.clientId,'clientId'),requestId=uuid(input.requestId,'requestId'),buyerId=uuid(input.buyerTenantCompanyId,'buyerTenantCompanyId');
  const expected=input.expectedVersion===null?0:number(input.expectedVersion,'expectedVersion');
  const evidenceSource=text(input.evidenceSource,'evidenceSource',200),evidenceReference=text(input.evidenceReference,'evidenceReference',500);
  try{return await withTransaction(async tx=>{
    const buildingId=await access(tx,actor,clientId,requestId,'maker');
    await tx.query(`INSERT INTO handyman_buyer_binding_heads(request_id,client_id,building_id) VALUES ($1,$2,$3) ON CONFLICT(request_id) DO NOTHING`,[requestId,clientId,buildingId]);
    const h=(await tx.query('SELECT * FROM handyman_buyer_binding_heads WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
    if(!h || h.version!==expected)throw conflict();
    const ctx=await context(tx,clientId,requestId,buyerId,true),id=randomUUID();
    const snapshot:BuyerBindingSnapshot={schema:'HANDYMAN_BUYER_BINDING_V1',id,version:h.version+1,previousBindingId:h.binding_id,
      ...ctx,evidenceSource,evidenceReference,createdByUserId:actor};
    const result=await tx.query(`INSERT INTO handyman_buyer_bindings(id,request_id,client_id,building_id,version,previous_binding_id,
      buyer_tenant_company_id,snapshot,digest,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING snapshot,digest,created_at`,
      [id,requestId,clientId,buildingId,snapshot.version,h.binding_id,buyerId,JSON.stringify(snapshot),hash(snapshot),actor]);
    await tx.query('UPDATE handyman_buyer_binding_heads SET version=$2,binding_id=$3,decision_id=NULL WHERE request_id=$1',[requestId,snapshot.version,id]);
    return view(result.rows[0]);
  });}catch(e){return pgConflict(e);}
}

/** Finance checker attests buyer identity/relationship, not tax status or consent. */
export async function decideHandymanBuyerBinding(actorInput:string,input:DecideBuyerBinding):Promise<BuyerBindingDecision> {
  keys(input,['clientId','requestId','bindingId','bindingVersion','bindingDigest','decision','evidenceSource','evidenceReference'],'input');
  const actor=uuid(actorInput,'actor'),clientId=uuid(input.clientId,'clientId'),requestId=uuid(input.requestId,'requestId'),bindingId=uuid(input.bindingId,'bindingId');
  const v=number(input.bindingVersion,'bindingVersion'),d=digest(input.bindingDigest,'bindingDigest');
  if(input.decision!=='VERIFY' && input.decision!=='REJECT')throw invalid('decision');
  const evidenceSource=text(input.evidenceSource,'evidenceSource',200),evidenceReference=text(input.evidenceReference,'evidenceReference',500);
  try{return await withTransaction(async tx=>{
    const buildingId=await access(tx,actor,clientId,requestId,'checker');
    const h=(await tx.query('SELECT * FROM handyman_buyer_binding_heads WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
    if(!h || h.binding_id!==bindingId || h.version!==v || h.decision_id)throw stale();
    const b=(await tx.query('SELECT * FROM handyman_buyer_bindings WHERE id=$1',[bindingId])).rows[0];
    if(!b || b.digest!==d || b.client_id!==clientId || b.request_id!==requestId || b.building_id!==buildingId)throw integrity();
    const original=view(b);if(original.snapshot.createdByUserId===actor)throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'The buyer author cannot verify their own assertion.'});
    assertCurrent(original.snapshot,await currentContext(tx,clientId,requestId,b.buyer_tenant_company_id,true));
    const id=randomUUID();
    const inserted=await tx.query(`INSERT INTO handyman_buyer_binding_decisions(id,binding_id,request_id,client_id,building_id,binding_version,
      binding_digest,decision,evidence_source,evidence_reference,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id,bindingId,requestId,clientId,buildingId,v,d,input.decision,evidenceSource,evidenceReference,actor]);
    await tx.query('UPDATE handyman_buyer_binding_heads SET decision_id=$2 WHERE request_id=$1',[requestId,id]);
    return decision(inserted.rows[0]);
  });}catch(e){return pgConflict(e);}
}

/** Trusted callers must already hold a repeatable-read snapshot, including their read-only calculation. */
export async function requireVerifiedBuyerBindingInSnapshot(tx:PoolClient,actorInput:string,input:ResolveBuyerBinding):Promise<VerifiedBuyerBinding> {
  keys(input,['clientId','requestId','pin','at'],'input');
  const actor=uuid(actorInput,'actor'),clientId=uuid(input.clientId,'clientId'),requestId=uuid(input.requestId,'requestId'),pin=parsePin(input.pin),at=buyerInstant(input.at);
  const buildingId=await access(tx,actor,clientId,requestId,'read');
  const h=(await tx.query('SELECT * FROM handyman_buyer_binding_heads WHERE request_id=$1',[requestId])).rows[0];
  if(!h || !h.binding_id)throw missing();
  if(h.client_id!==clientId || h.building_id!==buildingId || h.binding_id!==pin.bindingId || h.version!==pin.bindingVersion)throw stale();
  if(!h.decision_id)throw unverified();
  if(h.decision_id!==pin.decisionId)throw stale();
  const b=(await tx.query('SELECT * FROM handyman_buyer_bindings WHERE id=$1',[h.binding_id])).rows[0];
  const d=(await tx.query('SELECT * FROM handyman_buyer_binding_decisions WHERE id=$1',[h.decision_id])).rows[0];
  if(!b || !d || b.digest!==pin.bindingDigest || b.request_id!==requestId || b.client_id!==clientId || b.building_id!==buildingId ||
    b.version!==h.version || d.binding_id!==b.id || d.request_id!==requestId || d.client_id!==clientId || d.building_id!==buildingId ||
    d.binding_version!==b.version || d.binding_digest!==b.digest || d.decision_digest!==pin.decisionDigest || d.actor_user_id===b.created_by_user_id ||
    !d.evidence_source || !d.evidence_reference || d.occurred_at.getTime()<=b.created_at.getTime())throw integrity();
  const original=view(b);
  if(original.snapshot.id!==b.id || original.snapshot.version!==b.version || original.snapshot.previousBindingId!==b.previous_binding_id ||
    original.snapshot.buyerTenantCompanyId!==b.buyer_tenant_company_id || original.snapshot.createdByUserId!==b.created_by_user_id)throw integrity();
  if(d.decision!=='VERIFY')throw unverified();
  const now=(await tx.query("SELECT date_trunc('milliseconds',transaction_timestamp()) AS now")).rows[0].now as Date;
  if(d.occurred_at.getTime()>Math.min(new Date(at).getTime(),now.getTime()))throw unverified();
  assertCurrent(original.snapshot,await currentContext(tx,clientId,requestId,b.buyer_tenant_company_id,false,at));
  return Object.freeze({binding:original,decision:decision(d),taxIdentityApproval:'NOT_ASSERTED'});
}
export async function requireVerifiedHandymanBuyerBinding(actor:string,input:ResolveBuyerBinding):Promise<VerifiedBuyerBinding> {
  const tx=await getPool().connect();
  try{await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const value=await requireVerifiedBuyerBindingInSnapshot(tx,actor,input);await tx.query('COMMIT');return value;}
  catch(e){await tx.query('ROLLBACK').catch(()=>undefined);throw e;}finally{tx.release();}
}
