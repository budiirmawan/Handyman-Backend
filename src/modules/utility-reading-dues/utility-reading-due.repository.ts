import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type { CreateUtilityReadingDueInput, UtilityReadingDueFilters, UtilityReadingDueRecord } from './utility-reading-due.types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 01 — optional executor seam, mirroring the
 * convention `recordOperationalEvent` and BE-18E already use. Every existing
 * management caller omits it and behaves exactly as before.
 */
export type UtilityReadingDueExecutor = Pick<PoolClient, 'query'>;
const SELECT=`id,client_id AS "clientId",building_id AS "buildingId",meter_id AS "meterId",utility_type AS "utilityType",period_start AS "periodStart",period_end AS "periodEnd",due_at AS "dueAt",CASE WHEN status='DUE' AND due_at<NOW() THEN 'OVERDUE' ELSE status END AS status,schedule_definition_id AS "scheduleDefinitionId",generated_task_id AS "generatedTaskId",meter_reading_id AS "meterReadingId",completed_at AS "completedAt",completed_by_user_id AS "completedByUserId",cancelled_at AS "cancelledAt",cancelled_by_user_id AS "cancelledByUserId",cancellation_reason AS "cancellationReason",created_by_user_id AS "createdByUserId",created_at AS "createdAt",updated_at AS "updatedAt"`;
async function create(input:CreateUtilityReadingDueInput&{clientId:string;buildingId:string;utilityType:string;createdByUserId:string}){return(await getPool().query<UtilityReadingDueRecord>(`INSERT INTO utility_reading_dues(id,client_id,building_id,meter_id,utility_type,period_start,period_end,due_at,schedule_definition_id,generated_task_id,created_by_user_id)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)RETURNING ${SELECT}`,[randomUUID(),input.clientId,input.buildingId,input.meterId,input.utilityType,input.periodStart,input.periodEnd,input.dueAt,input.scheduleDefinitionId??null,input.generatedTaskId??null,input.createdByUserId])).rows[0]}
async function findById(id:string,executor:UtilityReadingDueExecutor=getPool()){const r=await executor.query<UtilityReadingDueRecord>(`SELECT ${SELECT} FROM utility_reading_dues WHERE id=$1`,[id]);return r.rows[0]??null}
/**
 * Row-locked read of one Reading Due, for callers that must serialize a field
 * execution against concurrent submissions for the SAME due.
 *
 * `FOR UPDATE` is used deliberately instead of a pg advisory lock: the lock is
 * transaction-scoped, so it is released by COMMIT/ROLLBACK and can never leak
 * if the caller throws, and it needs no separate pooled connection. It also
 * requires an executor by design — a lock taken on the pool outside a
 * transaction would be meaningless, so there is no default here.
 */
async function findByIdForUpdate(id:string,executor:UtilityReadingDueExecutor){const r=await executor.query<UtilityReadingDueRecord>(`SELECT ${SELECT} FROM utility_reading_dues WHERE id=$1 FOR UPDATE`,[id]);return r.rows[0]??null}
/**
 * CR-BE-RN12-METER-FIELD-01 PART 02 — the field execution a Meter Reading was
 * produced by, addressed from the READING side.
 *
 * `utility_reading_dues.meter_reading_id` is `UNIQUE` (0281) and
 * `utility_reading_due_state_check` only allows it to be set on a COMPLETED
 * due, so this resolves AT MOST ONE row and that row is necessarily the due the
 * reading completed. A reading with no row here was never a field execution —
 * it is a management / engineering / import reading, and the field authority
 * seam treats that as "not field-accessible" rather than falling back to a
 * weaker gate.
 *
 * Read-only and additive: no existing caller or query is changed.
 */
async function findByMeterReadingId(meterReadingId:string){const r=await getPool().query<UtilityReadingDueRecord>(`SELECT ${SELECT} FROM utility_reading_dues WHERE meter_reading_id=$1`,[meterReadingId]);return r.rows[0]??null}
function statusClause(status:string,index:number){if(status==='OVERDUE')return`status='DUE' AND due_at<NOW()`;if(status==='DUE')return`status='DUE' AND due_at>=NOW()`;return`status=$${index}`}
async function list(scope:{column:'meter_id'|'building_id'|'client_id';value:string},filters:UtilityReadingDueFilters,buildingIds?:string[]){const v:unknown[]=[scope.value],w=[`${scope.column}=$1`];if(buildingIds){if(!buildingIds.length)return[];v.push(buildingIds);w.push(`building_id=ANY($${v.length}::uuid[])`)}if(filters.status){const c=statusClause(filters.status,v.length+1);w.push(c);if(!['DUE','OVERDUE'].includes(filters.status))v.push(filters.status)}return(await getPool().query<UtilityReadingDueRecord>(`SELECT ${SELECT} FROM utility_reading_dues WHERE ${w.join(' AND ')} ORDER BY due_at,meter_id`,v)).rows}
async function complete(id:string,meterReadingId:string,userId:string,executor:UtilityReadingDueExecutor=getPool()){const r=await executor.query<UtilityReadingDueRecord>(`UPDATE utility_reading_dues SET status='COMPLETED',meter_reading_id=$2,completed_at=NOW(),completed_by_user_id=$3,updated_at=NOW() WHERE id=$1 AND status='DUE' RETURNING ${SELECT}`,[id,meterReadingId,userId]);return r.rows[0]??null}
async function cancel(id:string,reason:string,userId:string){const r=await getPool().query<UtilityReadingDueRecord>(`UPDATE utility_reading_dues SET status='CANCELLED',cancelled_at=NOW(),cancelled_by_user_id=$3,cancellation_reason=$2,updated_at=NOW() WHERE id=$1 AND status='DUE' RETURNING ${SELECT}`,[id,reason,userId]);return r.rows[0]??null}
export const utilityReadingDueRepository={cancel,complete,create,findById,findByIdForUpdate,findByMeterReadingId,list};
