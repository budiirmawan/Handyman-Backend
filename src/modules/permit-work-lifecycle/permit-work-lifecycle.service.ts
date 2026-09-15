import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { permitApplicationRepository } from '../permit-applications/permit-application.repository';
import { permitRepository } from '../permits/permit.repository';
import { assertPermitWorkActionAllowed, resolvePermitWorkAuthority } from './permit-work-lifecycle.authority';
import {
  permitWorkAlreadyClosedError,
  permitWorkAlreadyStartedError,
  permitWorkCloseBeforeStartError,
  permitWorkContextInvalidError,
  permitWorkNotReadyError,
} from './permit-work-lifecycle.errors';
import { permitWorkLifecycleRepository } from './permit-work-lifecycle.repository';
import type {
  PermitWorkFilters,
  PermitWorkLifecycleRecord,
  PermitWorkNotesInput,
  PermitWorkStartReadiness,
  PermitWorkStatusView,
  PublicPermitWorkLifecycle,
} from './permit-work-lifecycle.types';

export function toPublicPermitWorkLifecycle(r:PermitWorkLifecycleRecord):PublicPermitWorkLifecycle{return{...r,startedAt:r.startedAt?.toISOString()??null,closedAt:r.closedAt?.toISOString()??null,createdAt:r.createdAt.toISOString(),updatedAt:r.updatedAt.toISOString()}}

export async function resolvePermitWorkStartReadiness(permitId:string,actorUserId:string):Promise<PermitWorkStartReadiness>{
 const authority=await resolvePermitWorkAuthority(permitId,actorUserId);
 if(!authority.readiness){
  const status=await getPermitWorkStatus(permitId,actorUserId);
  return{permitId:status.permitId,permitApplicationId:status.permitApplicationId,permitReference:status.permitReference,buildingId:status.buildingId,contractorContextType:status.contractorContextType,contractorVendorId:status.contractorVendorId,workStatus:status.status,ready:false,approvalReady:false,validityStatus:null,safetyReady:false,safetyReadinessStatus:'NOT_RESOLVED',workerListReady:false,activeWorkerCount:0,configuredWorkerCount:0,equipmentRequired:false,equipmentReady:false,activeEquipmentCount:0,configuredEquipmentCount:0,evidenceConfigured:false,evidenceReady:false,blockers:['WORK_ALREADY_TRANSITIONED'],availableActions:status.availableActions};
 }
 return{...authority.readiness,availableActions:authority.isAllowed('START')?['START']:[]};
}

export async function startPermitWork(permitId:string,input:PermitWorkNotesInput,actorUserId:string):Promise<PublicPermitWorkLifecycle>{
 const existing=await permitWorkLifecycleRepository.findByPermitId(permitId);
 if(existing){if(existing.status==='CLOSED')throw permitWorkAlreadyClosedError();throw permitWorkAlreadyStartedError()}
 const authority=await resolvePermitWorkAuthority(permitId,actorUserId);
 if(!authority.readiness?.ready)throw permitWorkNotReadyError(authority.readiness?.blockers??['WORK_NOT_READY']);
 await assertPermitWorkActionAllowed(permitId,actorUserId,'START');
 const started=await permitWorkLifecycleRepository.start(authority.readiness.permitApplicationId,actorUserId,input.notes??null);
 if(!started)throw permitWorkAlreadyStartedError();
 await recordWorkEvent(started,actorUserId,'PERMIT_WORK_STARTED','Permit Work started',{readiness:authority.readiness});
 return toPublicPermitWorkLifecycle(started);
}

export async function closePermitWork(permitId:string,input:PermitWorkNotesInput,actorUserId:string):Promise<PublicPermitWorkLifecycle>{
 const existing=await permitWorkLifecycleRepository.findByPermitId(permitId);
 if(!existing)throw permitWorkCloseBeforeStartError();
 if(existing.status==='CLOSED')throw permitWorkAlreadyClosedError();
 if(existing.status!=='IN_PROGRESS')throw permitWorkCloseBeforeStartError();
 await assertPermitWorkActionAllowed(permitId,actorUserId,'CLOSE');
 const closed=await permitWorkLifecycleRepository.close(existing.id,actorUserId,input.notes??null);
 if(!closed)throw permitWorkAlreadyClosedError();
 await recordWorkEvent(closed,actorUserId,'PERMIT_WORK_CLOSED','Permit Work closed',{fromStatus:'IN_PROGRESS',toStatus:'CLOSED'});
 return toPublicPermitWorkLifecycle(closed);
}

export async function getPermitWorkStatus(permitId:string,actorUserId:string):Promise<PermitWorkStatusView>{
 const permit=await permitRepository.findById(permitId);if(!permit)throw permitWorkContextInvalidError();await contextAccessService.assertBuildingAccess(actorUserId,permit.buildingId);
 const application=await permitApplicationRepository.findByPermitId(permit.id);if(!application)throw permitWorkContextInvalidError();
 const record=await permitWorkLifecycleRepository.findByPermitId(permit.id),authority=await resolvePermitWorkAuthority(permit.id,actorUserId),status=permit.status==='CANCELLED'?'CANCELLED':record?.status??'READY';
 const actions=(['START','CLOSE']as const).filter(authority.isAllowed);
 return{lifecycleId:record?.id??null,permitId:permit.id,permitApplicationId:application.id,permitReference:permit.permitNumber,buildingId:permit.buildingId,contractorContextType:permit.contractorContextType,contractorVendorId:permit.contractorVendorId,status,startedAt:record?.startedAt?.toISOString()??null,startedByUserId:record?.startedByUserId??null,startNotes:record?.startNotes??null,closedAt:record?.closedAt?.toISOString()??null,closedByUserId:record?.closedByUserId??null,closeNotes:record?.closeNotes??null,availableActions:actions};
}

export async function listPermitWork(filters:PermitWorkFilters,actorUserId:string):Promise<PublicPermitWorkLifecycle[]>{if(filters.buildingId)await contextAccessService.assertBuildingAccess(actorUserId,filters.buildingId);const ids=await getAccessibleBuildingIds(actorUserId);return(await permitWorkLifecycleRepository.list(filters,ids)).map(toPublicPermitWorkLifecycle)}
async function recordWorkEvent(r:PermitWorkLifecycleRecord,u:string,eventType:string,summary:string,metadata:Record<string,unknown>){await recordOperationalEvent({clientId:r.clientId,buildingId:r.buildingId,entityType:'PERMIT_WORK',entityId:r.id,eventType,actorUserId:u,summary,metadata:{permitId:r.permitId,permitApplicationId:r.permitApplicationId,...metadata}})}
export const permitWorkLifecycleService={closePermitWork,getPermitWorkStatus,listPermitWork,resolvePermitWorkStartReadiness,startPermitWork,toPublicPermitWorkLifecycle};
