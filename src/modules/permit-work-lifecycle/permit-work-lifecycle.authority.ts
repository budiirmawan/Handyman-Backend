import { contextAccessService } from '../context-access';
import { permissionService } from '../permissions';
import { permitRepository } from '../permits/permit.repository';
import { permitWorkActionNotAllowedError, permitWorkContextInvalidError } from './permit-work-lifecycle.errors';
import { permitWorkLifecycleRepository } from './permit-work-lifecycle.repository';
import { resolvePermitWorkPrerequisites, type PermitWorkPrerequisites } from './permit-work-readiness.service';
import type { PermitWorkAction, PermitWorkStatus } from './permit-work-lifecycle.types';

export const PERMIT_WORK_ACTION_PERMISSIONS:Record<PermitWorkAction,string>={START:'permit.manage',CLOSE:'permit.manage'};
export type PermitWorkAuthority={permitId:string;status:PermitWorkStatus;readiness:PermitWorkPrerequisites|null;isAllowed:(action:PermitWorkAction)=>boolean};
/**
 * CR-BE-RN20-PERMIT-FIELD-01 — authority resolver seam. The BE-20K lifecycle
 * service resolves `PermitWorkAuthority` through this signature; the default
 * is the management resolver below (`permit.read` + `permit.manage`), and the
 * field surface supplies its own Permit-Worker-derived resolver. Persistence
 * and transition rules never vary by resolver.
 */
export type PermitWorkAuthorityResolver=(permitId:string,actorUserId:string)=>Promise<PermitWorkAuthority>;

/** BE-09-style single authority source for state-aware Permit Work actions. */
export async function resolvePermitWorkAuthority(permitId:string,actorUserId:string):Promise<PermitWorkAuthority>{
 const permit=await permitRepository.findById(permitId);if(!permit)throw permitWorkContextInvalidError();
 await contextAccessService.assertBuildingAccess(actorUserId,permit.buildingId);
 const lifecycle=await permitWorkLifecycleRepository.findByPermitId(permit.id),status:PermitWorkStatus=permit.status==='CANCELLED'?'CANCELLED':lifecycle?.status??'READY';
 const permissions=new Set(await permissionService.resolvePermissionsForUser(actorUserId));
 const authorized=permissions.has('permit.read')&&permissions.has('permit.manage');
 const readiness=status==='READY'?await resolvePermitWorkPrerequisites(permit.id,actorUserId):null;
 return{permitId:permit.id,status,readiness,isAllowed:(action)=>authorized&&((action==='START'&&status==='READY'&&readiness?.ready===true)||(action==='CLOSE'&&status==='IN_PROGRESS'))};
}
export async function assertPermitWorkActionAllowed(permitId:string,actorUserId:string,action:PermitWorkAction,resolveAuthority:PermitWorkAuthorityResolver=resolvePermitWorkAuthority){const authority=await resolveAuthority(permitId,actorUserId);if(!authority.isAllowed(action))throw permitWorkActionNotAllowedError(action);return authority}
