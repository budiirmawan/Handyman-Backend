import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  PermitWorkFilters,
  PermitWorkLifecycleRecord,
} from './permit-work-lifecycle.types';

const SELECT=`pwl.id,pwl.permit_application_id AS "permitApplicationId",pa.permit_id AS "permitId",p.permit_number AS "permitReference",p.client_id AS "clientId",p.building_id AS "buildingId",p.contractor_context_type AS "contractorContextType",p.contractor_vendor_id AS "contractorVendorId",pwl.status,pwl.started_at AS "startedAt",pwl.started_by_user_id AS "startedByUserId",pwl.start_notes AS "startNotes",pwl.closed_at AS "closedAt",pwl.closed_by_user_id AS "closedByUserId",pwl.close_notes AS "closeNotes",pwl.created_at AS "createdAt",pwl.updated_at AS "updatedAt"`;
const JOINS=`FROM permit_work_lifecycles pwl JOIN permit_applications pa ON pa.id=pwl.permit_application_id JOIN permits p ON p.id=pa.permit_id`;

async function findById(id:string):Promise<PermitWorkLifecycleRecord|null>{const r=await getPool().query<PermitWorkLifecycleRecord>(`SELECT ${SELECT} ${JOINS} WHERE pwl.id=$1`,[id]);return r.rows[0]??null}
async function findByPermitId(permitId:string):Promise<PermitWorkLifecycleRecord|null>{const r=await getPool().query<PermitWorkLifecycleRecord>(`SELECT ${SELECT} ${JOINS} WHERE p.id=$1`,[permitId]);return r.rows[0]??null}
async function start(applicationId:string,actorUserId:string,notes:string|null):Promise<PermitWorkLifecycleRecord|null>{const id=randomUUID(),r=await getPool().query<{id:string}>(`INSERT INTO permit_work_lifecycles(id,permit_application_id,status,started_at,started_by_user_id,start_notes)VALUES($1,$2,'IN_PROGRESS',NOW(),$3,$4)ON CONFLICT(permit_application_id)DO NOTHING RETURNING id`,[id,applicationId,actorUserId,notes]);return r.rows[0]?findById(id):null}
async function close(id:string,actorUserId:string,notes:string|null):Promise<PermitWorkLifecycleRecord|null>{const r=await getPool().query<{id:string}>(`UPDATE permit_work_lifecycles SET status='CLOSED',closed_at=NOW(),closed_by_user_id=$2,close_notes=$3,updated_at=NOW() WHERE id=$1 AND status='IN_PROGRESS' RETURNING id`,[id,actorUserId,notes]);return r.rows[0]?findById(id):null}
async function list(filters:PermitWorkFilters,buildingIds:string[]):Promise<PermitWorkLifecycleRecord[]>{if(!buildingIds.length)return[];const v:unknown[]=[buildingIds],c=['p.building_id=ANY($1::uuid[])'];for(const[key,column]of[['buildingId','p.building_id'],['contractorContextType','p.contractor_context_type'],['contractorVendorId','p.contractor_vendor_id'],['status','pwl.status']]as[keyof PermitWorkFilters,string][])if(filters[key]!==undefined){v.push(filters[key]);c.push(`${column}=$${v.length}`)}const r=await getPool().query<PermitWorkLifecycleRecord>(`SELECT ${SELECT} ${JOINS} WHERE ${c.join(' AND ')} ORDER BY pwl.started_at DESC,pwl.id`,v);return r.rows}
export const permitWorkLifecycleRepository={close,findById,findByPermitId,list,start};
