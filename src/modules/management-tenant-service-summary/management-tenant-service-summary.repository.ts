import { getPool } from '../../database';
import { IN_PROGRESS_WORK_ORDER_STATUSES } from '../engineering-daily-operations';
import { TENANT_SERVICE_COMPLETED_WORK_ORDER_STATUSES } from '../vendor-tenant-kpi';
import type { ManagementTenantComplaintSummary } from './management-tenant-service-summary.types';

type ProgressRow = {
  in_progress: number;
  overdue: number;
};

type ComplaintRow = {
  total: number;
  open: number;
  escalated: number;
  cancelled: number;
};

/**
 * Supplementary measures absent from BE-23H. Request/Complaint statuses are
 * read verbatim; fulfilment status is read from the existing BE-08 Work Order.
 */
export async function getTenantServiceSupplement(
  buildingIds: string[],
  start: Date | null,
  end: Date | null,
  overdueBefore: Date,
): Promise<{
  inProgressRequests: number;
  overdueRequests: number;
  complaints: ManagementTenantComplaintSummary;
}> {
  if (buildingIds.length === 0) {
    return {
      inProgressRequests: 0,
      overdueRequests: 0,
      complaints: { total: 0, open: 0, escalated: 0, cancelled: 0 },
    };
  }

  const [progress, complaints] = await Promise.all([
    getPool().query<ProgressRow>(
      `SELECT
         count(*) FILTER (
           WHERE tsr.status = 'CONVERTED'
             AND wo.status = ANY($5::text[])
         )::int AS in_progress,
         count(*) FILTER (
           WHERE tsr.status <> 'CANCELLED'
             AND NOT (
               wo.id IS NOT NULL AND wo.status = ANY($6::text[])
             )
             AND tsr.requested_at < $4
         )::int AS overdue
       FROM tenant_service_requests tsr
       LEFT JOIN work_orders wo ON wo.id = tsr.work_order_id
       WHERE tsr.building_id = ANY($1::uuid[])
         AND ($2::timestamptz IS NULL OR tsr.requested_at >= $2)
         AND ($3::timestamptz IS NULL OR tsr.requested_at < $3)`,
      [
        buildingIds,
        start,
        end,
        overdueBefore,
        IN_PROGRESS_WORK_ORDER_STATUSES,
        TENANT_SERVICE_COMPLETED_WORK_ORDER_STATUSES,
      ],
    ),
    getPool().query<ComplaintRow>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE tc.status = 'OPEN')::int AS open,
         count(*) FILTER (WHERE tc.status = 'ESCALATED')::int AS escalated,
         count(*) FILTER (WHERE tc.status = 'CANCELLED')::int AS cancelled
       FROM tenant_complaints tc
       WHERE tc.building_id = ANY($1::uuid[])
         AND ($2::timestamptz IS NULL OR tc.reported_at >= $2)
         AND ($3::timestamptz IS NULL OR tc.reported_at < $3)`,
      [buildingIds, start, end],
    ),
  ]);

  const progressRow = progress.rows[0];
  const complaintRow = complaints.rows[0];
  return {
    inProgressRequests: progressRow?.in_progress ?? 0,
    overdueRequests: progressRow?.overdue ?? 0,
    complaints: {
      total: complaintRow?.total ?? 0,
      open: complaintRow?.open ?? 0,
      escalated: complaintRow?.escalated ?? 0,
      cancelled: complaintRow?.cancelled ?? 0,
    },
  };
}

export const managementTenantServiceSummaryRepository = {
  getTenantServiceSupplement,
};
