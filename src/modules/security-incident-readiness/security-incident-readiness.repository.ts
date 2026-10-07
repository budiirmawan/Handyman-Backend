import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateSecurityIncidentReadinessInput,
  SecurityIncidentReadinessBindingStatus,
  SecurityIncidentReadinessCategory,
  SecurityIncidentReadinessListFilters,
  SecurityIncidentReadinessRecord,
  SecurityIncidentReadinessStatus,
  UpdateSecurityIncidentReadinessInput,
} from './security-incident-readiness.types';

/**
 * BE-12I — Security Incident Readiness repository.
 *
 * Holds the readiness configuration row and resolves the supporting
 * cross-module references (Team, Workforce Building Assignment,
 * Security Post status). No incident master record, no workflow.
 */

type SecurityIncidentReadinessRow = {
  id: string;
  client_id: string;
  building_id: string;
  security_post_id: string | null;
  category: SecurityIncidentReadinessCategory;
  readiness_status: SecurityIncidentReadinessStatus;
  status: SecurityIncidentReadinessBindingStatus;
  responsible_team_id: string | null;
  responsible_workforce_id: string | null;
  escalation_contact: string | null;
  reporting_instructions: string | null;
  evidence_requirement_id: string | null;
  notes: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const SECURITY_INCIDENT_READINESS_COLUMNS = `
  id, client_id, building_id, security_post_id, category,
  readiness_status, status, responsible_team_id, responsible_workforce_id,
  escalation_contact, reporting_instructions, evidence_requirement_id,
  notes, created_by_user_id, created_at, updated_at
`;

function mapRow(
  row: SecurityIncidentReadinessRow,
): SecurityIncidentReadinessRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    securityPostId: row.security_post_id,
    category: row.category,
    readinessStatus: row.readiness_status,
    status: row.status,
    responsibleTeamId: row.responsible_team_id,
    responsibleWorkforceId: row.responsible_workforce_id,
    escalationContact: row.escalation_contact,
    reportingInstructions: row.reporting_instructions,
    evidenceRequirementId: row.evidence_requirement_id,
    notes: row.notes,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: CreateSecurityIncidentReadinessInput & { clientId: string },
): Promise<SecurityIncidentReadinessRecord> {
  const result = await getPool().query<SecurityIncidentReadinessRow>(
    `INSERT INTO security_incident_readiness
       (id, client_id, building_id, security_post_id, category,
        readiness_status, status, responsible_team_id, responsible_workforce_id,
        escalation_contact, reporting_instructions, evidence_requirement_id,
        notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${SECURITY_INCIDENT_READINESS_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.securityPostId ?? null,
      input.category,
      input.readinessStatus ?? 'NOT_READY',
      input.status ?? 'ACTIVE',
      input.responsibleTeamId ?? null,
      input.responsibleWorkforceId ?? null,
      input.escalationContact ?? null,
      input.reportingInstructions ?? null,
      input.evidenceRequirementId ?? null,
      input.notes ?? null,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<SecurityIncidentReadinessRecord | null> {
  const result = await getPool().query<SecurityIncidentReadinessRow>(
    `SELECT ${SECURITY_INCIDENT_READINESS_COLUMNS}
     FROM security_incident_readiness WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findActiveByPostAndCategory(
  buildingId: string,
  securityPostId: string | null,
  category: SecurityIncidentReadinessCategory,
): Promise<SecurityIncidentReadinessRecord | null> {
  const result = await getPool().query<SecurityIncidentReadinessRow>(
    `SELECT ${SECURITY_INCIDENT_READINESS_COLUMNS}
     FROM security_incident_readiness
     WHERE building_id = $1
       AND category = $2
       AND status = 'ACTIVE'
       AND (($3::uuid IS NULL AND security_post_id IS NULL)
            OR security_post_id = $3)`,
    [buildingId, category, securityPostId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function list(
  filter: SecurityIncidentReadinessListFilters = {},
): Promise<SecurityIncidentReadinessRecord[]> {
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
  if (filter.category) {
    values.push(filter.category);
    conditions.push(`category = $${values.length}`);
  }
  if (filter.readinessStatus) {
    values.push(filter.readinessStatus);
    conditions.push(`readiness_status = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<SecurityIncidentReadinessRow>(
    `SELECT ${SECURITY_INCIDENT_READINESS_COLUMNS}
     FROM security_incident_readiness
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingIds(
  buildingIds: string[],
  filter: SecurityIncidentReadinessListFilters = {},
): Promise<SecurityIncidentReadinessRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const conditions = [`building_id = ANY($1::uuid[])`];
  const values: unknown[] = [buildingIds];

  if (filter.securityPostId) {
    values.push(filter.securityPostId);
    conditions.push(`security_post_id = $${values.length}`);
  }
  if (filter.category) {
    values.push(filter.category);
    conditions.push(`category = $${values.length}`);
  }
  if (filter.readinessStatus) {
    values.push(filter.readinessStatus);
    conditions.push(`readiness_status = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<SecurityIncidentReadinessRow>(
    `SELECT ${SECURITY_INCIDENT_READINESS_COLUMNS}
     FROM security_incident_readiness
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateSecurityIncidentReadinessInput,
): Promise<SecurityIncidentReadinessRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.securityPostId !== undefined) {
    values.push(input.securityPostId);
    sets.push(`security_post_id = $${values.length}`);
  }
  if (input.category !== undefined) {
    values.push(input.category);
    sets.push(`category = $${values.length}`);
  }
  if (input.readinessStatus !== undefined) {
    values.push(input.readinessStatus);
    sets.push(`readiness_status = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }
  if (input.responsibleTeamId !== undefined) {
    values.push(input.responsibleTeamId);
    sets.push(`responsible_team_id = $${values.length}`);
  }
  if (input.responsibleWorkforceId !== undefined) {
    values.push(input.responsibleWorkforceId);
    sets.push(`responsible_workforce_id = $${values.length}`);
  }
  if (input.escalationContact !== undefined) {
    values.push(input.escalationContact);
    sets.push(`escalation_contact = $${values.length}`);
  }
  if (input.reportingInstructions !== undefined) {
    values.push(input.reportingInstructions);
    sets.push(`reporting_instructions = $${values.length}`);
  }
  if (input.evidenceRequirementId !== undefined) {
    values.push(input.evidenceRequirementId);
    sets.push(`evidence_requirement_id = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<SecurityIncidentReadinessRow>(
    `UPDATE security_incident_readiness
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${SECURITY_INCIDENT_READINESS_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const securityIncidentReadinessRepository = {
  create,
  findActiveByPostAndCategory,
  findById,
  list,
  listByBuildingIds,
  update,
};
