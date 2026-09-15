import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateSecurityVisitorBindingInput,
  SecurityVisitorBindingListFilters,
  SecurityVisitorBindingRecord,
  SecurityVisitorBindingStatus,
  UpdateSecurityVisitorBindingInput,
} from './security-visitor-binding.types';

/**
 * BE-12J — Visitor / Security Binding repository.
 *
 * Holds the Security-side binding row. No visitor personal data is
 * stored; the binding only carries an opaque `external_visit_reference`
 * for future integration with an authoritative Visitor / Visit
 * domain.
 */

type SecurityVisitorBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  security_post_id: string | null;
  security_workforce_id: string | null;
  external_visit_reference: string;
  security_context: string | null;
  status: SecurityVisitorBindingStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const SECURITY_VISITOR_BINDING_COLUMNS = `
  id, client_id, building_id, security_post_id, security_workforce_id,
  external_visit_reference, security_context, status,
  created_by_user_id, created_at, updated_at
`;

function mapRow(
  row: SecurityVisitorBindingRow,
): SecurityVisitorBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    securityPostId: row.security_post_id,
    securityWorkforceId: row.security_workforce_id,
    externalVisitReference: row.external_visit_reference,
    securityContext: row.security_context,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: CreateSecurityVisitorBindingInput & { clientId: string },
): Promise<SecurityVisitorBindingRecord> {
  const result = await getPool().query<SecurityVisitorBindingRow>(
    `INSERT INTO security_visitor_bindings
       (id, client_id, building_id, security_post_id, security_workforce_id,
        external_visit_reference, security_context, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SECURITY_VISITOR_BINDING_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.securityPostId ?? null,
      input.securityWorkforceId ?? null,
      input.externalVisitReference,
      input.securityContext ?? null,
      input.status ?? 'ACTIVE',
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<SecurityVisitorBindingRecord | null> {
  const result = await getPool().query<SecurityVisitorBindingRow>(
    `SELECT ${SECURITY_VISITOR_BINDING_COLUMNS}
     FROM security_visitor_bindings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findActiveByBuildingAndReference(
  buildingId: string,
  externalVisitReference: string,
): Promise<SecurityVisitorBindingRecord | null> {
  const result = await getPool().query<SecurityVisitorBindingRow>(
    `SELECT ${SECURITY_VISITOR_BINDING_COLUMNS}
     FROM security_visitor_bindings
     WHERE building_id = $1
       AND external_visit_reference = $2
       AND status = 'ACTIVE'`,
    [buildingId, externalVisitReference],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function list(
  filter: SecurityVisitorBindingListFilters = {},
): Promise<SecurityVisitorBindingRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`building_id = $${values.length}`);
  }
  if (filter.securityPostId) {
    values.push(filter.securityPostId);
    conditions.push(`security_post_id = $${values.length}`);
  }
  if (filter.securityWorkforceId) {
    values.push(filter.securityWorkforceId);
    conditions.push(`security_workforce_id = $${values.length}`);
  }
  if (filter.externalVisitReference) {
    values.push(filter.externalVisitReference);
    conditions.push(`external_visit_reference = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<SecurityVisitorBindingRow>(
    `SELECT ${SECURITY_VISITOR_BINDING_COLUMNS}
     FROM security_visitor_bindings
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingIds(
  buildingIds: string[],
  filter: SecurityVisitorBindingListFilters = {},
): Promise<SecurityVisitorBindingRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const conditions = [`building_id = ANY($1::uuid[])`];
  const values: unknown[] = [buildingIds];

  if (filter.securityPostId) {
    values.push(filter.securityPostId);
    conditions.push(`security_post_id = $${values.length}`);
  }
  if (filter.securityWorkforceId) {
    values.push(filter.securityWorkforceId);
    conditions.push(`security_workforce_id = $${values.length}`);
  }
  if (filter.externalVisitReference) {
    values.push(filter.externalVisitReference);
    conditions.push(`external_visit_reference = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<SecurityVisitorBindingRow>(
    `SELECT ${SECURITY_VISITOR_BINDING_COLUMNS}
     FROM security_visitor_bindings
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateSecurityVisitorBindingInput,
): Promise<SecurityVisitorBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.securityPostId !== undefined) {
    values.push(input.securityPostId);
    sets.push(`security_post_id = $${values.length}`);
  }
  if (input.securityWorkforceId !== undefined) {
    values.push(input.securityWorkforceId);
    sets.push(`security_workforce_id = $${values.length}`);
  }
  if (input.externalVisitReference !== undefined) {
    values.push(input.externalVisitReference);
    sets.push(`external_visit_reference = $${values.length}`);
  }
  if (input.securityContext !== undefined) {
    values.push(input.securityContext);
    sets.push(`security_context = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<SecurityVisitorBindingRow>(
    `UPDATE security_visitor_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${SECURITY_VISITOR_BINDING_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const securityVisitorBindingRepository = {
  create,
  findActiveByBuildingAndReference,
  findById,
  list,
  listByBuildingIds,
  update,
};
