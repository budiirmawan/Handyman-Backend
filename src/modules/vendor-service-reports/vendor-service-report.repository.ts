import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ServiceReportStatus,
  VendorServiceReportRecord,
} from './vendor-service-report.types';

/**
 * BE-15G — Vendor Service Report repository.
 *
 * Holds service-report rows for a BE-15B Vendor Work. Change history is
 * preserved through the shared BE-07 operational-events timeline (recorded by
 * the service), not by extra rows here.
 */

type VendorServiceReportRow = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  completionReportId: string | null;
  workOrderId: string;
  buildingId: string;
  serviceReportNumber: string;
  serviceDate: string | Date;
  summary: string | null;
  workPerformed: string | null;
  recommendation: string | null;
  preparedByUserId: string;
  status: ServiceReportStatus;
  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const REPORT_SELECT = `
  id,
  client_id AS "clientId",
  vendor_work_id AS "vendorWorkId",
  completion_report_id AS "completionReportId",
  work_order_id AS "workOrderId",
  building_id AS "buildingId",
  service_report_number AS "serviceReportNumber",
  service_date AS "serviceDate",
  summary,
  work_performed AS "workPerformed",
  recommendation,
  prepared_by_user_id AS "preparedByUserId",
  status,
  finalized_at AS "finalizedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function toDateString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function mapRow(row: VendorServiceReportRow): VendorServiceReportRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    vendorWorkId: row.vendorWorkId,
    completionReportId: row.completionReportId,
    workOrderId: row.workOrderId,
    buildingId: row.buildingId,
    serviceReportNumber: row.serviceReportNumber,
    serviceDate: toDateString(row.serviceDate),
    summary: row.summary,
    workPerformed: row.workPerformed,
    recommendation: row.recommendation,
    preparedByUserId: row.preparedByUserId,
    status: row.status,
    finalizedAt: row.finalizedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type CreateVendorServiceReportRow = {
  clientId: string;
  vendorWorkId: string;
  completionReportId: string | null;
  workOrderId: string;
  buildingId: string;
  serviceReportNumber: string;
  serviceDate: string;
  summary: string | null;
  workPerformed: string | null;
  recommendation: string | null;
  preparedByUserId: string;
};

async function create(
  input: CreateVendorServiceReportRow,
): Promise<VendorServiceReportRecord> {
  const result = await getPool().query<VendorServiceReportRow>(
    `INSERT INTO vendor_service_reports
       (id, client_id, vendor_work_id, completion_report_id, work_order_id,
        building_id, service_report_number, service_date, summary,
        work_performed, recommendation, prepared_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${REPORT_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.vendorWorkId,
      input.completionReportId,
      input.workOrderId,
      input.buildingId,
      input.serviceReportNumber,
      input.serviceDate,
      input.summary,
      input.workPerformed,
      input.recommendation,
      input.preparedByUserId,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<VendorServiceReportRecord | null> {
  const result = await getPool().query<VendorServiceReportRow>(
    `SELECT ${REPORT_SELECT} FROM vendor_service_reports WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByVendorWorkId(
  vendorWorkId: string,
): Promise<VendorServiceReportRecord | null> {
  const result = await getPool().query<VendorServiceReportRow>(
    `SELECT ${REPORT_SELECT} FROM vendor_service_reports
     WHERE vendor_work_id = $1
     LIMIT 1`,
    [vendorWorkId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Lists reports scoped to the caller's accessible Building set, optionally
 * narrowed by Vendor Work / Vendor (via `vendor_works`) / Building.
 */
async function list(input: {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
  buildingIds: string[];
}): Promise<VendorServiceReportRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  values.push(input.buildingIds);
  conditions.push(`vsr.building_id = ANY($${values.length})`);

  if (input.vendorWorkId) {
    values.push(input.vendorWorkId);
    conditions.push(`vsr.vendor_work_id = $${values.length}`);
  }
  if (input.vendorId) {
    values.push(input.vendorId);
    conditions.push(`vw.vendor_id = $${values.length}`);
  }
  if (input.buildingId) {
    values.push(input.buildingId);
    conditions.push(`vsr.building_id = $${values.length}`);
  }

  const result = await getPool().query<VendorServiceReportRow>(
    `SELECT
       vsr.id,
       vsr.client_id AS "clientId",
       vsr.vendor_work_id AS "vendorWorkId",
       vsr.completion_report_id AS "completionReportId",
       vsr.work_order_id AS "workOrderId",
       vsr.building_id AS "buildingId",
       vsr.service_report_number AS "serviceReportNumber",
       vsr.service_date AS "serviceDate",
       vsr.summary,
       vsr.work_performed AS "workPerformed",
       vsr.recommendation,
       vsr.prepared_by_user_id AS "preparedByUserId",
       vsr.status,
       vsr.finalized_at AS "finalizedAt",
       vsr.created_at AS "createdAt",
       vsr.updated_at AS "updatedAt"
     FROM vendor_service_reports vsr
     LEFT JOIN vendor_works vw ON vw.id = vsr.vendor_work_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY vsr.created_at ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

/** Updates the mutable DRAFT fields. */
async function updateDraft(
  id: string,
  input: {
    serviceDate: string;
    summary: string | null;
    workPerformed: string | null;
    recommendation: string | null;
  },
): Promise<VendorServiceReportRecord | null> {
  const result = await getPool().query<VendorServiceReportRow>(
    `UPDATE vendor_service_reports
     SET service_date = $2,
         summary = $3,
         work_performed = $4,
         recommendation = $5,
         updated_at = NOW()
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING ${REPORT_SELECT}`,
    [
      id,
      input.serviceDate,
      input.summary,
      input.workPerformed,
      input.recommendation,
    ],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Finalizes a DRAFT report (DRAFT → FINALIZED). */
async function finalize(id: string): Promise<VendorServiceReportRecord | null> {
  const result = await getPool().query<VendorServiceReportRow>(
    `UPDATE vendor_service_reports
     SET status = 'FINALIZED',
         finalized_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING ${REPORT_SELECT}`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const vendorServiceReportRepository = {
  create,
  finalize,
  findById,
  findByVendorWorkId,
  list,
  updateDraft,
};
