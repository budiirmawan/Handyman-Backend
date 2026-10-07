import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ContractorVisitorListFilters,
  ContractorVisitorRecord,
  ContractorVisitorStatus,
  UpdateContractorVisitorInput,
} from './contractor-visitor.types';

type ContractorVisitorRow = {
  id: string;
  client_id: string;
  building_id: string;
  visitor_id: string;
  expected_visitor_id: string | null;
  walk_in_visit_id: string | null;
  contractor_company: string;
  contractor_purpose: string;
  responsible_host_user_id: string | null;
  responsible_host_workforce_id: string | null;
  responsible_host_name: string | null;
  functional_location_id: string | null;
  work_location: string | null;
  notes: string | null;
  status: ContractorVisitorStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const CONTRACTOR_VISITOR_COLUMNS = `
  id, client_id, building_id, visitor_id,
  expected_visitor_id, walk_in_visit_id,
  contractor_company, contractor_purpose,
  responsible_host_user_id, responsible_host_workforce_id,
  responsible_host_name, functional_location_id, work_location,
  notes, status, created_by_user_id, created_at, updated_at
`;

function mapRow(row: ContractorVisitorRow): ContractorVisitorRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    visitorId: row.visitor_id,
    expectedVisitorId: row.expected_visitor_id,
    walkInVisitId: row.walk_in_visit_id,
    contractorCompany: row.contractor_company,
    contractorPurpose: row.contractor_purpose,
    responsibleHostUserId: row.responsible_host_user_id,
    responsibleHostWorkforceId: row.responsible_host_workforce_id,
    responsibleHostName: row.responsible_host_name,
    functionalLocationId: row.functional_location_id,
    workLocation: row.work_location,
    notes: row.notes,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(input: {
  clientId: string;
  buildingId: string;
  visitorId: string;
  expectedVisitorId: string | null;
  walkInVisitId: string | null;
  contractorCompany: string;
  contractorPurpose: string;
  responsibleHostUserId: string | null;
  responsibleHostWorkforceId: string | null;
  responsibleHostName: string | null;
  functionalLocationId: string | null;
  workLocation: string | null;
  notes: string | null;
  createdByUserId: string;
}): Promise<ContractorVisitorRecord> {
  const result = await getPool().query<ContractorVisitorRow>(
    `INSERT INTO contractor_visitors
       (id, client_id, building_id, visitor_id,
        expected_visitor_id, walk_in_visit_id,
        contractor_company, contractor_purpose,
        responsible_host_user_id, responsible_host_workforce_id,
        responsible_host_name, functional_location_id, work_location,
        notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, $15)
     RETURNING ${CONTRACTOR_VISITOR_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.visitorId,
      input.expectedVisitorId,
      input.walkInVisitId,
      input.contractorCompany,
      input.contractorPurpose,
      input.responsibleHostUserId,
      input.responsibleHostWorkforceId,
      input.responsibleHostName,
      input.functionalLocationId,
      input.workLocation,
      input.notes,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<ContractorVisitorRecord | null> {
  const result = await getPool().query<ContractorVisitorRow>(
    `SELECT ${CONTRACTOR_VISITOR_COLUMNS}
     FROM contractor_visitors WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByExpectedVisitor(
  expectedVisitorId: string,
): Promise<ContractorVisitorRecord | null> {
  const result = await getPool().query<ContractorVisitorRow>(
    `SELECT ${CONTRACTOR_VISITOR_COLUMNS}
     FROM contractor_visitors WHERE expected_visitor_id = $1`,
    [expectedVisitorId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByWalkInVisit(
  walkInVisitId: string,
): Promise<ContractorVisitorRecord | null> {
  const result = await getPool().query<ContractorVisitorRow>(
    `SELECT ${CONTRACTOR_VISITOR_COLUMNS}
     FROM contractor_visitors WHERE walk_in_visit_id = $1`,
    [walkInVisitId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingIds(
  buildingIds: string[],
  filters: ContractorVisitorListFilters = {},
): Promise<ContractorVisitorRecord[]> {
  if (buildingIds.length === 0) return [];

  const conditions = ['building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.visitorId) {
    values.push(filters.visitorId);
    conditions.push(`visitor_id = $${values.length}`);
  }
  if (filters.expectedVisitorId) {
    values.push(filters.expectedVisitorId);
    conditions.push(`expected_visitor_id = $${values.length}`);
  }
  if (filters.walkInVisitId) {
    values.push(filters.walkInVisitId);
    conditions.push(`walk_in_visit_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.search) {
    values.push(`%${filters.search}%`);
    const index = values.length;
    conditions.push(`(
      contractor_company ILIKE $${index}
      OR contractor_purpose ILIKE $${index}
      OR responsible_host_name ILIKE $${index}
      OR work_location ILIKE $${index}
      OR notes ILIKE $${index}
    )`);
  }

  const result = await getPool().query<ContractorVisitorRow>(
    `SELECT ${CONTRACTOR_VISITOR_COLUMNS}
     FROM contractor_visitors
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateContractorVisitorInput,
): Promise<ContractorVisitorRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  const add = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (input.contractorCompany !== undefined) {
    add('contractor_company', input.contractorCompany);
  }
  if (input.contractorPurpose !== undefined) {
    add('contractor_purpose', input.contractorPurpose);
  }
  if (input.responsibleHostUserId !== undefined) {
    add('responsible_host_user_id', input.responsibleHostUserId);
  }
  if (input.responsibleHostWorkforceId !== undefined) {
    add('responsible_host_workforce_id', input.responsibleHostWorkforceId);
  }
  if (input.responsibleHostName !== undefined) {
    add('responsible_host_name', input.responsibleHostName);
  }
  if (input.functionalLocationId !== undefined) {
    add('functional_location_id', input.functionalLocationId);
  }
  if (input.workLocation !== undefined) {
    add('work_location', input.workLocation);
  }
  if (input.notes !== undefined) add('notes', input.notes);
  if (input.status !== undefined) add('status', input.status);

  if (sets.length === 0) return findById(id);
  values.push(id);

  const result = await getPool().query<ContractorVisitorRow>(
    `UPDATE contractor_visitors
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${CONTRACTOR_VISITOR_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const contractorVisitorRepository = {
  create,
  findByExpectedVisitor,
  findById,
  findByWalkInVisit,
  listByBuildingIds,
  update,
};
