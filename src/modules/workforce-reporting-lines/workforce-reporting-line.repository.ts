import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CurrentSupervisor,
  DirectReport,
  NewWorkforceReportingLine,
  UpdateWorkforceReportingLineInput,
  WorkforceReportingLineRecord,
  WorkforceReportingLineStatus,
} from './workforce-reporting-line.types';

type WorkforceReportingLineRow = {
  id: string;
  workforce_profile_id: string;
  supervisor_workforce_profile_id: string;
  effective_from: Date | null;
  effective_until: Date | null;
  status: WorkforceReportingLineStatus;
  created_at: Date;
  updated_at: Date;
};

type CurrentSupervisorRow = {
  reporting_line_id: string;
  workforce_profile_id: string;
  supervisor_workforce_profile_id: string;
  employee_code: string;
  full_name: string;
  effective_from: Date | null;
  effective_until: Date | null;
};

type DirectReportRow = {
  reporting_line_id: string;
  workforce_profile_id: string;
  employee_code: string;
  full_name: string;
  status: WorkforceReportingLineStatus;
  effective_from: Date | null;
  effective_until: Date | null;
};

const REPORTING_LINE_SELECT = `
  id,
  workforce_profile_id,
  supervisor_workforce_profile_id,
  effective_from,
  effective_until,
  status,
  created_at,
  updated_at
`;

function mapRow(row: WorkforceReportingLineRow): WorkforceReportingLineRecord {
  return {
    id: row.id,
    workforceProfileId: row.workforce_profile_id,
    supervisorWorkforceProfileId: row.supervisor_workforce_profile_id,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(
  input: NewWorkforceReportingLine,
): Promise<WorkforceReportingLineRecord> {
  const result = await getPool().query<WorkforceReportingLineRow>(
    `INSERT INTO workforce_reporting_lines
       (id, workforce_profile_id, supervisor_workforce_profile_id,
        effective_from, effective_until, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${REPORTING_LINE_SELECT}`,
    [
      randomUUID(),
      input.workforceProfileId,
      input.supervisorWorkforceProfileId,
      input.effectiveFrom,
      input.effectiveUntil,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(
  id: string,
): Promise<WorkforceReportingLineRecord | null> {
  const result = await getPool().query<WorkforceReportingLineRow>(
    `SELECT ${REPORTING_LINE_SELECT} FROM workforce_reporting_lines WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * The reporting line addressed by `/workforce/:workforceId/supervisor`.
 * Prefers the ACTIVE row so a PATCH targets the live line rather than
 * deactivated history.
 */
async function findByWorkforceProfileId(
  workforceProfileId: string,
): Promise<WorkforceReportingLineRecord | null> {
  const result = await getPool().query<WorkforceReportingLineRow>(
    `SELECT ${REPORTING_LINE_SELECT} FROM workforce_reporting_lines
     WHERE workforce_profile_id = $1
     ORDER BY (status = 'ACTIVE') DESC, created_at DESC
     LIMIT 1`,
    [workforceProfileId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** The single ACTIVE reporting line of a Workforce Profile, if any. */
async function findActiveByWorkforceProfileId(
  workforceProfileId: string,
): Promise<WorkforceReportingLineRecord | null> {
  const result = await getPool().query<WorkforceReportingLineRow>(
    `SELECT ${REPORTING_LINE_SELECT} FROM workforce_reporting_lines
     WHERE workforce_profile_id = $1 AND status = 'ACTIVE'`,
    [workforceProfileId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Every reporting line ever recorded for a Workforce Profile, history included. */
async function listByWorkforceProfileId(
  workforceProfileId: string,
): Promise<WorkforceReportingLineRecord[]> {
  const result = await getPool().query<WorkforceReportingLineRow>(
    `SELECT ${REPORTING_LINE_SELECT} FROM workforce_reporting_lines
     WHERE workforce_profile_id = $1
     ORDER BY created_at ASC`,
    [workforceProfileId],
  );

  return result.rows.map(mapRow);
}

/**
 * BE-03F resolver query — the Supervisor genuinely in force at `asOf`.
 *
 * Effectiveness is decided entirely in SQL so the database is the single
 * arbiter:
 *   1. the reporting line is ACTIVE,
 *   2. the supervisor's Workforce Profile is still ACTIVE,
 *   3. effective_from is absent or already reached,
 *   4. effective_until is absent or not yet passed.
 *
 * `asOf` is a parameter rather than NOW() so the caller controls the reference
 * instant and the behaviour is deterministic under test.
 */
async function findCurrentSupervisor(
  workforceProfileId: string,
  asOf: Date,
): Promise<CurrentSupervisor | null> {
  const result = await getPool().query<CurrentSupervisorRow>(
    `SELECT
       rl.id AS reporting_line_id,
       rl.workforce_profile_id,
       rl.supervisor_workforce_profile_id,
       sup.employee_code,
       sup.full_name,
       rl.effective_from,
       rl.effective_until
     FROM workforce_reporting_lines rl
     JOIN workforce_profiles sup
       ON sup.id = rl.supervisor_workforce_profile_id
     WHERE rl.workforce_profile_id = $1
       AND rl.status = 'ACTIVE'
       AND sup.status = 'ACTIVE'
       AND (rl.effective_from IS NULL OR rl.effective_from <= $2)
       AND (rl.effective_until IS NULL OR rl.effective_until >= $2)
     LIMIT 1`,
    [workforceProfileId, asOf],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    reportingLineId: row.reporting_line_id,
    workforceProfileId: row.workforce_profile_id,
    supervisorWorkforceProfileId: row.supervisor_workforce_profile_id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
  };
}

/**
 * BE-03F resolver query — the Workforce Profiles currently reporting to one
 * Supervisor. Mirrors `findCurrentSupervisor`, but filters on the subordinate's
 * profile being ACTIVE instead of the supervisor's.
 */
async function listDirectReports(
  supervisorWorkforceProfileId: string,
  asOf: Date,
): Promise<DirectReport[]> {
  const result = await getPool().query<DirectReportRow>(
    `SELECT
       rl.id AS reporting_line_id,
       rl.workforce_profile_id,
       wp.employee_code,
       wp.full_name,
       rl.status,
       rl.effective_from,
       rl.effective_until
     FROM workforce_reporting_lines rl
     JOIN workforce_profiles wp ON wp.id = rl.workforce_profile_id
     WHERE rl.supervisor_workforce_profile_id = $1
       AND rl.status = 'ACTIVE'
       AND wp.status = 'ACTIVE'
       AND (rl.effective_from IS NULL OR rl.effective_from <= $2)
       AND (rl.effective_until IS NULL OR rl.effective_until >= $2)
     ORDER BY wp.employee_code ASC`,
    [supervisorWorkforceProfileId, asOf],
  );

  return result.rows.map((row) => ({
    reportingLineId: row.reporting_line_id,
    workforceProfileId: row.workforce_profile_id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
  }));
}

/**
 * Circular-case probe: is `candidateSupervisorId` currently reporting to
 * `workforceProfileId`? Only the direct two-node cycle is examined.
 */
async function existsActiveLine(
  workforceProfileId: string,
  supervisorWorkforceProfileId: string,
): Promise<boolean> {
  const result = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM workforce_reporting_lines
       WHERE workforce_profile_id = $1
         AND supervisor_workforce_profile_id = $2
         AND status = 'ACTIVE'
     ) AS exists`,
    [workforceProfileId, supervisorWorkforceProfileId],
  );

  return result.rows[0]?.exists === true;
}

/**
 * Partial update. Only fields explicitly present in `input` are written, so an
 * absent key leaves the stored value untouched while an explicit `null` clears
 * an effective bound. The row is never deleted — deactivation is a status
 * change so the reporting history survives.
 */
async function update(
  id: string,
  input: UpdateWorkforceReportingLineInput,
): Promise<WorkforceReportingLineRecord | null> {
  const assignments: string[] = [];
  const values: unknown[] = [id];

  if (input.supervisorWorkforceProfileId !== undefined) {
    values.push(input.supervisorWorkforceProfileId);
    assignments.push(`supervisor_workforce_profile_id = $${values.length}`);
  }
  if (input.effectiveFrom !== undefined) {
    values.push(input.effectiveFrom);
    assignments.push(`effective_from = $${values.length}`);
  }
  if (input.effectiveUntil !== undefined) {
    values.push(input.effectiveUntil);
    assignments.push(`effective_until = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    assignments.push(`status = $${values.length}`);
  }

  if (assignments.length === 0) {
    return findById(id);
  }

  const result = await getPool().query<WorkforceReportingLineRow>(
    `UPDATE workforce_reporting_lines
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $1
     RETURNING ${REPORTING_LINE_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const workforceReportingLineRepository = {
  create,
  existsActiveLine,
  findActiveByWorkforceProfileId,
  findById,
  findByWorkforceProfileId,
  findCurrentSupervisor,
  listByWorkforceProfileId,
  listDirectReports,
  update,
};
