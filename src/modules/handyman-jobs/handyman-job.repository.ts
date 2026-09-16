import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanJobAssignmentRecord,
  HandymanJobFilters,
  HandymanJobRecord,
  NewHandymanJob,
  NewHandymanJobAssignment,
} from './handyman-job.types';

type Executor = Pick<PoolClient, 'query'>;

const JOB_SELECT = `
  id,
  client_id                        AS "clientId",
  handyman_request_id              AS "handymanRequestId",
  handyman_quotation_id            AS "handymanQuotationId",
  handyman_quotation_revision_id   AS "handymanQuotationRevisionId",
  work_order_id                    AS "workOrderId",
  created_by_user_id               AS "createdByUserId",
  created_at                       AS "createdAt",
  updated_at                       AS "updatedAt"
`;

const ASSIGNMENT_SELECT = `
  id,
  client_id                AS "clientId",
  handyman_job_id          AS "handymanJobId",
  vendor_assignment_id     AS "vendorAssignmentId",
  handyman_work_crew_id    AS "handymanWorkCrewId",
  status,
  assigned_at              AS "assignedAt",
  assigned_by_user_id      AS "assignedByUserId",
  superseded_at            AS "supersededAt",
  superseded_by_user_id    AS "supersededByUserId",
  created_at               AS "createdAt",
  updated_at               AS "updatedAt"
`;

/* ------------------------------------------------------------------ */
/* handyman_jobs                                                       */
/* ------------------------------------------------------------------ */

async function create(
  input: NewHandymanJob,
  executor: Executor = getPool(),
): Promise<HandymanJobRecord> {
  const result = await executor.query<HandymanJobRecord>(
    `INSERT INTO handyman_jobs
       (id, client_id, handyman_request_id, handyman_quotation_id,
        handyman_quotation_revision_id, work_order_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${JOB_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanRequestId,
      input.handymanQuotationId,
      input.handymanQuotationRevisionId,
      input.workOrderId,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
  executor: Executor = getPool(),
): Promise<HandymanJobRecord | null> {
  const result = await executor.query<HandymanJobRecord>(
    `SELECT ${JOB_SELECT} FROM handyman_jobs WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Locks the job row for a composition transaction (per-job serialization). */
async function lockById(
  id: string,
  executor: Executor,
): Promise<HandymanJobRecord | null> {
  const result = await executor.query<HandymanJobRecord>(
    `SELECT ${JOB_SELECT} FROM handyman_jobs WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByRequestId(
  handymanRequestId: string,
  executor: Executor = getPool(),
): Promise<HandymanJobRecord | null> {
  const result = await executor.query<HandymanJobRecord>(
    `SELECT ${JOB_SELECT} FROM handyman_jobs WHERE handyman_request_id = $1`,
    [handymanRequestId],
  );
  return result.rows[0] ?? null;
}

async function findByWorkOrderId(
  workOrderId: string,
  executor: Executor = getPool(),
): Promise<HandymanJobRecord | null> {
  const result = await executor.query<HandymanJobRecord>(
    `SELECT ${JOB_SELECT} FROM handyman_jobs WHERE work_order_id = $1`,
    [workOrderId],
  );
  return result.rows[0] ?? null;
}

async function listByClient(
  clientId: string,
  filters: HandymanJobFilters = {},
  executor: Executor = getPool(),
): Promise<HandymanJobRecord[]> {
  const clauses: string[] = ['client_id = $1'];
  const values: unknown[] = [clientId];

  if (filters.handymanRequestId) {
    values.push(filters.handymanRequestId);
    clauses.push(`handyman_request_id = $${values.length}`);
  }
  if (filters.workOrderId) {
    values.push(filters.workOrderId);
    clauses.push(`work_order_id = $${values.length}`);
  }

  const result = await executor.query<HandymanJobRecord>(
    `SELECT ${JOB_SELECT} FROM handyman_jobs
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows;
}

/* ------------------------------------------------------------------ */
/* handyman_job_assignments (append-only composition history)          */
/* ------------------------------------------------------------------ */

async function createAssignment(
  input: NewHandymanJobAssignment,
  executor: Executor,
): Promise<HandymanJobAssignmentRecord> {
  const result = await executor.query<HandymanJobAssignmentRecord>(
    `INSERT INTO handyman_job_assignments
       (id, client_id, handyman_job_id, vendor_assignment_id,
        handyman_work_crew_id, assigned_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ASSIGNMENT_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanJobId,
      input.vendorAssignmentId,
      input.handymanWorkCrewId,
      input.assignedByUserId,
    ],
  );
  return result.rows[0];
}

async function findActiveByJobId(
  handymanJobId: string,
  executor: Executor = getPool(),
): Promise<HandymanJobAssignmentRecord | null> {
  const result = await executor.query<HandymanJobAssignmentRecord>(
    `SELECT ${ASSIGNMENT_SELECT} FROM handyman_job_assignments
     WHERE handyman_job_id = $1 AND status = 'ACTIVE'`,
    [handymanJobId],
  );
  return result.rows[0] ?? null;
}

async function listAssignmentsByJobId(
  handymanJobId: string,
  executor: Executor = getPool(),
): Promise<HandymanJobAssignmentRecord[]> {
  const result = await executor.query<HandymanJobAssignmentRecord>(
    `SELECT ${ASSIGNMENT_SELECT} FROM handyman_job_assignments
     WHERE handyman_job_id = $1
     ORDER BY created_at DESC`,
    [handymanJobId],
  );
  return result.rows;
}

/**
 * Guarded ACTIVE→SUPERSEDED closure with attribution. Returns null when the
 * row was no longer ACTIVE (a concurrent reassignment won) — the caller
 * translates that into a domain 409; nothing rewrites history.
 */
async function supersedeActiveAssignment(
  id: string,
  supersededByUserId: string,
  executor: Executor,
): Promise<HandymanJobAssignmentRecord | null> {
  const result = await executor.query<HandymanJobAssignmentRecord>(
    `UPDATE handyman_job_assignments
     SET status = 'SUPERSEDED',
         superseded_at = NOW(),
         superseded_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${ASSIGNMENT_SELECT}`,
    [id, supersededByUserId],
  );
  return result.rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Composition reads/writes against the EXISTING BE-08/BE-15 tables.   */
/*                                                                     */
/* The BE-15A/BE-15B services and repositories have NO executor        */
/* support (verified), so the Handyman composition reproduces their    */
/* exact column semantics inside ONE transaction here, while their     */
/* structural constraints (vendor_assignments_active_unique,           */
/* vendor_works_assignment_unique) remain the shared final authority.  */
/* Every function below is a plain row read/write — no BE-08/BE-15     */
/* business rule is re-implemented: validation stays in the service    */
/* through the owning modules' authorities.                            */
/* ------------------------------------------------------------------ */

export type CompositionWorkOrderRow = {
  id: string;
  clientId: string;
  buildingId: string;
  workOrderNumber: string;
  workType: string;
  status: string;
};

/** Locks and re-reads the work order inside a composition transaction. */
async function lockWorkOrderForComposition(
  workOrderId: string,
  executor: Executor,
): Promise<CompositionWorkOrderRow | null> {
  const result = await executor.query<CompositionWorkOrderRow>(
    `SELECT id,
            client_id         AS "clientId",
            building_id       AS "buildingId",
            work_order_number AS "workOrderNumber",
            work_type         AS "workType",
            status
     FROM work_orders
     WHERE id = $1
     FOR UPDATE`,
    [workOrderId],
  );
  return result.rows[0] ?? null;
}

export type CompositionProviderRow = {
  id: string;
  clientId: string;
  vendorId: string;
  status: string;
};

/** Locks the CR-HM-BE-02 designation row for in-transaction revalidation. */
async function lockProviderDesignation(
  handymanProviderId: string,
  executor: Executor,
): Promise<CompositionProviderRow | null> {
  const result = await executor.query<CompositionProviderRow>(
    `SELECT id,
            client_id AS "clientId",
            vendor_id AS "vendorId",
            status
     FROM handyman_providers
     WHERE id = $1
     FOR UPDATE`,
    [handymanProviderId],
  );
  return result.rows[0] ?? null;
}

export type CompositionVendorRow = {
  id: string;
  clientId: string;
  status: string;
};

/** Locks the BE-06A vendor row for in-transaction revalidation. */
async function lockVendor(
  vendorId: string,
  executor: Executor,
): Promise<CompositionVendorRow | null> {
  const result = await executor.query<CompositionVendorRow>(
    `SELECT id, client_id AS "clientId", status
     FROM vendors
     WHERE id = $1
     FOR UPDATE`,
    [vendorId],
  );
  return result.rows[0] ?? null;
}

/** Same predicate as BE-06D `findActiveByVendorAndBuilding`, under executor. */
async function findActiveVendorBuildingRelationship(
  vendorId: string,
  buildingId: string,
  executor: Executor,
): Promise<{ id: string } | null> {
  const result = await executor.query<{ id: string }>(
    `SELECT id FROM vendor_building_relationships
     WHERE vendor_id = $1 AND building_id = $2 AND status = 'ACTIVE'`,
    [vendorId, buildingId],
  );
  return result.rows[0] ?? null;
}

export type CompositionVendorAssignmentRow = {
  id: string;
  vendorId: string;
  workOrderId: string;
  buildingId: string;
  status: string;
};

async function findVendorAssignmentById(
  id: string,
  executor: Executor = getPool(),
): Promise<CompositionVendorAssignmentRow | null> {
  const result = await executor.query<CompositionVendorAssignmentRow>(
    `SELECT id,
            vendor_id     AS "vendorId",
            work_order_id AS "workOrderId",
            building_id   AS "buildingId",
            status
     FROM vendor_assignments
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveVendorAssignmentByVendorAndWorkOrder(
  vendorId: string,
  workOrderId: string,
  executor: Executor,
): Promise<CompositionVendorAssignmentRow | null> {
  const result = await executor.query<CompositionVendorAssignmentRow>(
    `SELECT id,
            vendor_id     AS "vendorId",
            work_order_id AS "workOrderId",
            building_id   AS "buildingId",
            status
     FROM vendor_assignments
     WHERE vendor_id = $1 AND work_order_id = $2 AND status = 'ACTIVE'`,
    [vendorId, workOrderId],
  );
  return result.rows[0] ?? null;
}

/** Inserts the BE-15A row with its exact column semantics (ACTIVE). */
async function createVendorAssignment(
  input: {
    vendorId: string;
    workOrderId: string;
    buildingId: string;
    assignedByUserId: string;
  },
  executor: Executor,
): Promise<CompositionVendorAssignmentRow> {
  const result = await executor.query<CompositionVendorAssignmentRow>(
    `INSERT INTO vendor_assignments
       (id, vendor_id, work_order_id, building_id, notes,
        assigned_by_user_id, assigned_at, status)
     VALUES ($1, $2, $3, $4, NULL, $5, NOW(), 'ACTIVE')
     RETURNING id,
               vendor_id     AS "vendorId",
               work_order_id AS "workOrderId",
               building_id   AS "buildingId",
               status`,
    [
      randomUUID(),
      input.vendorId,
      input.workOrderId,
      input.buildingId,
      input.assignedByUserId,
    ],
  );
  return result.rows[0];
}

/**
 * Guarded BE-15A deactivation (never a delete). Returns null when the row
 * was already INACTIVE — tolerated: the composition may legitimately repair
 * a vendor assignment deactivated through the BM surface.
 */
async function deactivateVendorAssignmentIfActive(
  id: string,
  executor: Executor,
): Promise<{ id: string } | null> {
  const result = await executor.query<{ id: string }>(
    `UPDATE vendor_assignments
     SET status = 'INACTIVE', updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING id`,
    [id],
  );
  return result.rows[0] ?? null;
}

export type CompositionVendorWorkRow = {
  id: string;
  status: string;
};

async function findVendorWorkByAssignmentId(
  vendorAssignmentId: string,
  executor: Executor = getPool(),
): Promise<CompositionVendorWorkRow | null> {
  const result = await executor.query<CompositionVendorWorkRow>(
    `SELECT id, status FROM vendor_works WHERE vendor_assignment_id = $1`,
    [vendorAssignmentId],
  );
  return result.rows[0] ?? null;
}

/**
 * Inserts the BE-15B row with its exact column semantics — `status` is
 * omitted so the table default 'NOT_STARTED' applies (the composition must
 * never advance the vendor work lifecycle).
 */
async function createVendorWork(
  input: {
    vendorAssignmentId: string;
    vendorId: string;
    workOrderId: string;
    buildingId: string;
  },
  executor: Executor,
): Promise<CompositionVendorWorkRow> {
  const result = await executor.query<CompositionVendorWorkRow>(
    `INSERT INTO vendor_works
       (id, vendor_assignment_id, vendor_id, work_order_id, building_id, notes)
     VALUES ($1, $2, $3, $4, $5, NULL)
     RETURNING id, status`,
    [
      randomUUID(),
      input.vendorAssignmentId,
      input.vendorId,
      input.workOrderId,
      input.buildingId,
    ],
  );
  return result.rows[0];
}

export const handymanJobRepository = {
  create,
  createAssignment,
  createVendorAssignment,
  createVendorWork,
  deactivateVendorAssignmentIfActive,
  findActiveByJobId,
  findActiveVendorAssignmentByVendorAndWorkOrder,
  findActiveVendorBuildingRelationship,
  findById,
  findByRequestId,
  findVendorAssignmentById,
  findVendorWorkByAssignmentId,
  findByWorkOrderId,
  listAssignmentsByJobId,
  listByClient,
  lockById,
  lockProviderDesignation,
  lockVendor,
  lockWorkOrderForComposition,
  supersedeActiveAssignment,
};
