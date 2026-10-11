import { randomUUID } from 'node:crypto';
import { startDirectQuotationFixture, auth, status } from './handyman-direct-quotation';
import { api } from './http';
import type { PicWorkspaceAssertion } from '../../src/modules/handyman-pic-session';
export { auth, status, denied, closeDirectQuotationFixture } from './handyman-direct-quotation';
export const CARE='/api/v1/handyman/care';
export const PIC='/api/v1/handyman/pic';
export const HM='/api/v1/handyman/requests';
export const HV='/api/v1/handyman/quotation-versions';
export const HQ='/api/v1/handyman/quotations';
export async function startCareQuotationFixture(port: number) {
  const f=await startDirectQuotationFixture(port);
  const token=await f.careSession();
  const selection={propertyId:f.propertyId,tenantCompanyId:f.tenantCompanyId,buildingId:f.buildingId,spaceId:f.spaceId};
  status(await f.configure('DIRECT_ALLOWED'),200,'explicit fixture service policy');
  const base=(requestId:string,versionId:string)=>`${CARE}/requests/${requestId}/quotations/${versionId}`;
  const issue=(versionId:string,validUntil=new Date(Date.now()+3_600_000).toISOString())=>api().post(`${HV}/${versionId}/issue`).set(auth(f.ops.token)).send({validUntil});
  const addLine=async(versionId:string)=>status(await api().post(`${HV}/${versionId}/lines`).set(auth(f.ops.token))
    .send({lineType:'LABOR',description:'Resident-approved fixed repair',quantity:2,uomId:f.uomId,currency:'IDR',finalQuotedUnitAmount:150000}),201,'priced line');
  const prepare=async(options:{channel?:string;issue?:boolean;bind?:boolean}={})=>{
    const intake=await f.intake({residentIntakeChannel:options.channel??'WALK_IN'}); status(intake,201,'signed Care intake');
    const requestId=intake.body.data.id as string;
    status(await api().post(`${HM}/${requestId}/triage`).set(auth(f.ops.token)).send({disposition:'DIAGNOSIS',note:'Operations reviewed fixed scope.',
      scopeClarityConfirmed:true,directQuotationReason:'Documented dimensions and exact replacement specification make an inspection unnecessary.'}),201,'Operations triage');
    status(await api().post(`${HM}/${requestId}/diagnosis`).set(auth(f.ops.token)).send({disciplineId:f.disciplineId,diagnosis:'Replace the specified pipe joint.'}),201,'Operations diagnosis');
    const draft=await api().post(`${HM}/${requestId}/quotation`).set(auth(f.ops.token)).send({}); status(draft,201,'Operations draft');
    const quotationId=draft.body.data.quotation.id as string,versionId=draft.body.data.versions[0].id as string;
    await addLine(versionId);
    if(options.issue!==false) status(await issue(versionId),200,'issue to Care workspace');
    if(options.bind!==false) status(await api().post(`${HQ}/${quotationId}/approval-binding`).set(auth(f.ops.token))
      .set('Idempotency-Key',randomUUID()).send({tenantPicId:f.tenantPicId}),201,'explicit PIC binding');
    return {requestId,quotationId,versionId};
  };
  const present=(x:{requestId:string;versionId:string},channel='WALK_IN',key=randomUUID(),credential=token,scope:object=selection)=>
    api().post(`${base(x.requestId,x.versionId)}/presentations`).set(auth(credential)).set('Idempotency-Key',key).query(scope).send({channel});
  const handoff=(x:{requestId:string;versionId:string},presentationId:string)=>api().post(`${base(x.requestId,x.versionId)}/pic-handoffs`)
    .set(auth(token)).query(selection).send({presentationId});
  const preparedHandoff=async()=>{
    const x=await prepare();const p=await present(x);status(p,201,'resident presentation');
    const h=await handoff(x,p.body.data.id);status(h,201,'Care handoff');
    return {...x,presentation:p.body.data,handoff:h.body.data};
  };
  const picAssertion=(representation:PicWorkspaceAssertion['representation']={tenantCompanyId:f.tenantCompanyId,buildingId:f.buildingId,tenantPicId:f.tenantPicId,spaceId:f.spaceId}):PicWorkspaceAssertion=>({
    purpose:'HANDYMAN_PIC_WORKSPACE',integrationCode:f.picCode,assertionId:randomUUID(),issuedAt:new Date(Date.now()-1000).toISOString(),
    expiresAt:new Date(Date.now()+240000).toISOString(),representation});
  const admitPic=(assertion=picAssertion())=>api().post(`${PIC}/session`).set('x-hub-signature-256',f.signPic(assertion)).send(assertion);
  return {...f,careToken:token,selection,base,issue,addLine,prepare,present,handoff,preparedHandoff,picAssertion,admitPic,
    inbox:(credential=token,scope:object=selection)=>api().get(`${CARE}/quotation-inbox`).set(auth(credential)).query(scope),
    detail:(x:{requestId:string;versionId:string})=>api().get(base(x.requestId,x.versionId)).set(auth(token)).query(selection),
    claim:(id:string,credential:string)=>api().post(`${PIC}/quotation-handoffs/${id}/claim`).set(auth(credential)).send({}),
    decide:(id:string,credential:string,key=randomUUID(),decision='APPROVE')=>api().post(`${PIC}/quotation-handoffs/${id}/decision`)
      .set(auth(credential)).set('Idempotency-Key',key).send({decision}),
  };
}
