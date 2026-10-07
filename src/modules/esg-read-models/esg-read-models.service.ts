import type { Request, Response, NextFunction } from 'express';
import { getPool } from '../../database';
import { getAccessibleBuildingIds } from '../context-access';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';

async function read(req: Request) {
  if (!req.auth) throw authenticationRequiredError();
  const ids = await getAccessibleBuildingIds(req.auth.userId);
  const requested = typeof req.query.buildingIds === 'string' ? req.query.buildingIds.split(',') : ids;
  const buildings = requested.filter((id) => ids.includes(id));
  const from = typeof req.query.dateFrom === 'string' ? req.query.dateFrom : '1970-01-01';
  const to = typeof req.query.dateTo === 'string' ? req.query.dateTo : '9999-12-31';
  const p = getPool();
  const [values, waste] = await Promise.all([
    p.query(`SELECT metric_definition_id AS "metricDefinitionId", uom_id AS "uomId", count(*)::int AS count, count(*) FILTER (WHERE data_quality='ACTUAL')::int AS actual, count(*) FILTER (WHERE data_quality='ESTIMATED')::int AS estimated, count(*) FILTER (WHERE data_quality='MISSING')::int AS missing, count(*) FILTER (WHERE verification_status='VERIFIED')::int AS verified, count(*) FILTER (WHERE verification_status='PENDING')::int AS pending, count(*) FILTER (WHERE verification_status='REJECTED')::int AS rejected FROM esg_metric_values WHERE building_id = ANY($1::uuid[]) AND period_start >= $2 AND period_end <= $3 GROUP BY metric_definition_id,uom_id`, [buildings, from, to]),
    p.query(`SELECT waste_type AS "wasteType", disposal_method AS "disposalMethod", uom_id AS "uomId", sum(quantity)::text AS quantity FROM esg_waste_records WHERE building_id=ANY($1::uuid[]) AND record_date >= $2::date AND record_date <= $3::date GROUP BY waste_type,disposal_method,uom_id`, [buildings, from, to]),
  ]);
  return { period: { from, to }, buildingIds: buildings, metricValues: values.rows, waste: waste.rows, provenance: 'source records; no UOM conversion or utility recalculation' };
}
export async function getEsgKpiHandler(req: Request,res: Response,next: NextFunction){try{sendSuccess(res,await read(req));}catch(e){next(e)}}
export async function getManagementEsgSummaryHandler(req: Request,res: Response,next: NextFunction){try{sendSuccess(res,await read(req));}catch(e){next(e)}}
