import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ExternalWorkforceLinkRecord,
  ExternalWorkforceLinkStatus,
  NewExternalWorkforceLink,
  UpdateExternalWorkforceLinkInput,
} from './external-workforce.types';

type ExternalWorkforceLinkRow = {
  id: string;
  workforce_profile_id: string;
  external_organization_id: string;
  external_personnel_code: string;
  status: ExternalWorkforceLinkStatus;
  effective_from: Date | null;
  effective_until: Date | null;
  created_at: Date;
  updated_at: Date;
};

const LINK_SELECT = `
  id,
  workforce_profile_id,
  external_organization_id,
  external_personnel_code,
  status,
  effective_from,
  effective_until,
  created_at,
  updated_at
`;

function mapRow(row: ExternalWorkforceLinkRow): ExternalWorkforceLinkRecord {
  return {
    id: row.id,
    workforceProfileId: row.workforce_profile_id,
    externalOrganizationId: row.external_organization_id,
    externalPersonnelCode: row.external_personnel_code,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(
  input: NewExternalWorkforceLink,
): Promise<ExternalWorkforceLinkRecord> {
  const result = await getPool().query<ExternalWorkforceLinkRow>(
    `INSERT INTO external_workforce_links
       (id, workforce_profile_id, external_organization_id, external_personnel_code,
        effective_from, effective_until, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${LINK_SELECT}`,
    [
      randomUUID(),
      input.workforceProfileId,
      input.externalOrganizationId,
      input.externalPersonnelCode,
      input.effectiveFrom,
      input.effectiveUntil,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<ExternalWorkforceLinkRecord | null> {
  const result = await getPool().query<ExternalWorkforceLinkRow>(
    `SELECT ${LINK_SELECT} FROM external_workforce_links WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Resolves the affiliation addressed by the API route
 * (`/workforce/:workforceId/external-affiliations/:externalOrganizationId`).
 * Prefers the ACTIVE row so an update targets the live affiliation rather
 * than deactivated history.
 */
async function findByWorkforceAndOrganization(
  workforceProfileId: string,
  externalOrganizationId: string,
): Promise<ExternalWorkforceLinkRecord | null> {
  const result = await getPool().query<ExternalWorkforceLinkRow>(
    `SELECT ${LINK_SELECT} FROM external_workforce_links
     WHERE workforce_profile_id = $1 AND external_organization_id = $2
     ORDER BY (status = 'ACTIVE') DESC, created_at DESC
     LIMIT 1`,
    [workforceProfileId, externalOrganizationId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findActiveByWorkforceAndOrganization(
  workforceProfileId: string,
  externalOrganizationId: string,
): Promise<ExternalWorkforceLinkRecord | null> {
  const result = await getPool().query<ExternalWorkforceLinkRow>(
    `SELECT ${LINK_SELECT} FROM external_workforce_links
     WHERE workforce_profile_id = $1
       AND external_organization_id = $2
       AND status = 'ACTIVE'`,
    [workforceProfileId, externalOrganizationId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Any affiliation (active or historical) using the vendor's personnel code
 * within one External Organization. Codes stay reserved, so this is the
 * duplicate pre-check behind the UNIQUE constraint.
 */
async function findByOrganizationAndPersonnelCode(
  externalOrganizationId: string,
  externalPersonnelCode: string,
): Promise<ExternalWorkforceLinkRecord | null> {
  const result = await getPool().query<ExternalWorkforceLinkRow>(
    `SELECT ${LINK_SELECT} FROM external_workforce_links
     WHERE external_organization_id = $1 AND external_personnel_code = $2
     LIMIT 1`,
    [externalOrganizationId, externalPersonnelCode],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Every affiliation held by one Workforce Profile, history included. */
async function listByWorkforceProfileId(
  workforceProfileId: string,
): Promise<ExternalWorkforceLinkRecord[]> {
  const result = await getPool().query<ExternalWorkforceLinkRow>(
    `SELECT ${LINK_SELECT} FROM external_workforce_links
     WHERE workforce_profile_id = $1
     ORDER BY created_at ASC`,
    [workforceProfileId],
  );

  return result.rows.map(mapRow);
}

/** Every workforce member affiliated with one External Organization. */
async function listByExternalOrganizationId(
  externalOrganizationId: string,
): Promise<ExternalWorkforceLinkRecord[]> {
  const result = await getPool().query<ExternalWorkforceLinkRow>(
    `SELECT ${LINK_SELECT} FROM external_workforce_links
     WHERE external_organization_id = $1
     ORDER BY created_at ASC`,
    [externalOrganizationId],
  );

  return result.rows.map(mapRow);
}

/**
 * Partial update. Only the fields explicitly present in `input` are written,
 * so an absent key leaves the stored value untouched while an explicit `null`
 * clears an effective bound.
 */
async function update(
  id: string,
  input: UpdateExternalWorkforceLinkInput,
): Promise<ExternalWorkforceLinkRecord | null> {
  const assignments: string[] = [];
  const values: unknown[] = [id];

  if (input.externalPersonnelCode !== undefined) {
    values.push(input.externalPersonnelCode);
    assignments.push(`external_personnel_code = $${values.length}`);
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

  const result = await getPool().query<ExternalWorkforceLinkRow>(
    `UPDATE external_workforce_links
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $1
     RETURNING ${LINK_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const externalWorkforceRepository = {
  create,
  findActiveByWorkforceAndOrganization,
  findById,
  findByOrganizationAndPersonnelCode,
  findByWorkforceAndOrganization,
  listByExternalOrganizationId,
  listByWorkforceProfileId,
  update,
};
