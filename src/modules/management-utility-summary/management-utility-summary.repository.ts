import { getPool } from '../../database';
import type {
  BuildingMeterOperationalSummary,
  BuildingUtilityBillingReadinessSummary,
  BuildingUtilityExceptionSummary,
  BuildingUtilityReconciliationSummary,
} from './management-utility-summary.types';

type ReconciliationRow = {
  reconciliationId: string; utilityType: 'ELECTRICITY'|'WATER';
  periodStart: Date; periodEnd: Date; sourceConsumption: string;
  tenantConsumption: string; commonAreaConsumption: string;
  unallocatedConsumption: string; reconciliationPercentage: string|null;
  performanceMetric: 'IKE'|'IKA'; performanceValue: string;
  applicableAreaSqm: string; consumptionUomId: string; calculatedAt: Date;
};
export async function resolveBuildingClient(buildingId: string) {
  const result = await getPool().query<{ clientId: string }>(
    `SELECT property.client_id AS "clientId" FROM buildings building
     JOIN properties property ON property.id=building.property_id
     WHERE building.id=$1`, [buildingId],
  );
  return result.rows[0]?.clientId ?? null;
}
export async function readReconciliations(buildingId: string, start: Date, end: Date): Promise<BuildingUtilityReconciliationSummary[]> {
  const rows = (await getPool().query<ReconciliationRow>(
    `SELECT id AS "reconciliationId",utility_type AS "utilityType",
      period_start AS "periodStart",period_end AS "periodEnd",
      source_consumption::text AS "sourceConsumption",
      tenant_consumption::text AS "tenantConsumption",
      common_area_consumption::text AS "commonAreaConsumption",
      unallocated_consumption::text AS "unallocatedConsumption",
      reconciliation_percentage::text AS "reconciliationPercentage",
      performance_metric AS "performanceMetric",
      performance_value::text AS "performanceValue",
      applicable_area_sqm::text AS "applicableAreaSqm",
      uom_id AS "consumptionUomId",calculated_at AS "calculatedAt"
     FROM building_utility_reconciliations
     WHERE building_id=$1 AND period_start=$2 AND period_end=$3
     ORDER BY utility_type`, [buildingId, start, end],
  )).rows;
  return rows.map(row => ({
    reconciliationId: row.reconciliationId, utilityType: row.utilityType,
    periodStart: row.periodStart.toISOString(), periodEnd: row.periodEnd.toISOString(),
    sourceConsumption: Number(row.sourceConsumption),
    tenantConsumption: Number(row.tenantConsumption),
    commonAreaConsumption: Number(row.commonAreaConsumption),
    unallocatedConsumption: Number(row.unallocatedConsumption),
    reconciliationPercentage: row.reconciliationPercentage === null ? null : Number(row.reconciliationPercentage),
    performanceMetric: row.performanceMetric,
    performanceValue: Number(row.performanceValue),
    applicableAreaSqm: Number(row.applicableAreaSqm),
    consumptionUomId: row.consumptionUomId,
    performanceUom: row.performanceMetric === 'IKE' ? 'kWh/m²' : 'm³/m²',
    calculatedAt: row.calculatedAt.toISOString(),
  }));
}
export async function readMeterOperations(buildingId: string, start: Date, end: Date): Promise<BuildingMeterOperationalSummary> {
  const [meters, dues] = await Promise.all([
    getPool().query<any>(`SELECT COUNT(*) FILTER(WHERE status='ACTIVE')::int total,
      COUNT(*) FILTER(WHERE status='ACTIVE' AND purpose='TENANT')::int tenant,
      COUNT(*) FILTER(WHERE status='ACTIVE' AND purpose='BUILDING')::int building,
      COUNT(*) FILTER(WHERE status='ACTIVE' AND purpose='COMMON_AREA')::int common,
      COUNT(*) FILTER(WHERE status='ACTIVE' AND purpose='ENERGY_SOURCE')::int source
      FROM utility_meters WHERE building_id=$1`, [buildingId]),
    getPool().query<any>(`SELECT
      COUNT(*) FILTER(WHERE status='DUE' AND due_at>=NOW())::int due,
      COUNT(*) FILTER(WHERE status='DUE' AND due_at<NOW())::int overdue,
      COUNT(*) FILTER(WHERE status='COMPLETED')::int completed,
      COUNT(*) FILTER(WHERE status='CANCELLED')::int cancelled
      FROM utility_reading_dues
      WHERE building_id=$1 AND period_start=$2 AND period_end=$3`, [buildingId, start, end]),
  ]);
  const m=meters.rows[0],d=dues.rows[0];
  return { totalActiveMeters:m.total, byPurpose:{TENANT:m.tenant,BUILDING:m.building,COMMON_AREA:m.common,ENERGY_SOURCE:m.source},
    readingDue:{due:d.due,overdue:d.overdue,completed:d.completed,cancelled:d.cancelled} };
}
const EXCEPTION_TYPES=['ABNORMAL_CONSUMPTION','MISSING_OR_LATE_READING','OCR_MANUAL_FOLLOW_UP','RECONCILIATION_VARIANCE','UNALLOCATED_CONSUMPTION','OTHER'];
export async function readExceptionSummary(buildingId: string): Promise<BuildingUtilityExceptionSummary> {
  const rows=(await getPool().query<{exceptionType:string;severity:string;status:string;count:number}>(
    `SELECT exception_type AS "exceptionType",severity,status,COUNT(*)::int count
     FROM utility_operational_exceptions WHERE building_id=$1
     GROUP BY exception_type,severity,status`,[buildingId])).rows;
  const result:BuildingUtilityExceptionSummary={total:0,byType:Object.fromEntries(EXCEPTION_TYPES.map(x=>[x,0])),
    bySeverity:{LOW:0,MEDIUM:0,HIGH:0,CRITICAL:0},byStatus:{OPEN:0,UNDER_REVIEW:0,RESOLVED:0,CANCELLED:0}};
  for(const row of rows){result.total+=row.count;result.byType[row.exceptionType]=(result.byType[row.exceptionType]??0)+row.count;result.bySeverity[row.severity as keyof typeof result.bySeverity]+=row.count;result.byStatus[row.status as keyof typeof result.byStatus]+=row.count}
  return result;
}
export async function readBillingReadiness(buildingId: string,start:Date,end:Date):Promise<BuildingUtilityBillingReadinessSummary>{
  const [calculations,bills]=await Promise.all([
    getPool().query<any>(`SELECT
      COUNT(*) FILTER(WHERE latest.status IS NULL OR latest.status='PENDING')::int awaiting,
      COUNT(*) FILTER(WHERE latest.status='APPROVED')::int approved,
      COUNT(*) FILTER(WHERE latest.status='REJECTED')::int rejected
      FROM utility_calculations calculation
      JOIN utility_meters meter ON meter.id=calculation.meter_id
      LEFT JOIN LATERAL(SELECT approval.status FROM tenant_approval_bindings approval
        WHERE approval.utility_calculation_id=calculation.id
        ORDER BY CASE WHEN approval.status='PENDING' THEN 0 ELSE 1 END,
          approval.updated_at DESC,approval.created_at DESC,approval.id DESC LIMIT 1)latest ON TRUE
      WHERE calculation.building_id=$1 AND calculation.period_start=$2
        AND calculation.period_end=$3 AND calculation.status='FINALIZED'
        AND calculation.utility_type IN ('ELECTRICITY','WATER')
        AND calculation.tariff_id IS NOT NULL AND calculation.currency IS NOT NULL
        AND calculation.tenant_company_id IS NOT NULL
        AND calculation.tenant_assignment_id IS NOT NULL
        AND meter.purpose='TENANT'`,[buildingId,start,end]),
    getPool().query<any>(`SELECT COUNT(*)::int created,
      COUNT(*) FILTER(WHERE status<>'CANCELLED' AND consumption_quantity IS NOT NULL
        AND uom_id IS NOT NULL AND tariff_rate IS NOT NULL AND currency IS NOT NULL)::int ready
      FROM utility_bills WHERE building_id=$1 AND period_start=$2 AND period_end=$3`,[buildingId,start,end]),
  ]);
  const c=calculations.rows[0],b=bills.rows[0];return{calculationsAwaitingApproval:c.awaiting,
    approvedCalculations:c.approved,rejectedCalculations:c.rejected,
    utilityBillsCreated:b.created,invoiceReadyUtilityBills:b.ready};
}
export const managementUtilitySummaryRepository={readBillingReadiness,readExceptionSummary,readMeterOperations,readReconciliations,resolveBuildingClient};
