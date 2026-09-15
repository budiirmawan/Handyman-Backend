import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewPermitEquipment,
  PermitEquipmentFilters,
  PermitEquipmentRecord,
  UpdatePermitEquipmentInput,
} from './permit-equipment.types';

const SELECT = `
  pe.id,
  pe.permit_application_id AS "permitApplicationId",
  pa.permit_id AS "permitId",
  p.permit_number AS "permitReference",
  p.client_id AS "clientId",
  p.building_id AS "buildingId",
  p.contractor_context_type AS "contractorContextType",
  COALESCE(p.tenant_contractor_relationship_id, p.contractor_vendor_id)
    AS "contractorContextId",
  p.contractor_vendor_id AS "contractorVendorId",
  a.id AS "assetId",
  a.asset_code AS "assetCode",
  a.asset_name AS "assetName",
  a.status AS "assetStatus",
  a.asset_type_id AS "assetTypeId",
  at.code AS "assetTypeCode",
  at.name AS "assetTypeName",
  ep.id AS "equipmentProfileId",
  ep.equipment_code AS "equipmentCode",
  COALESCE(ep.equipment_name, a.asset_name) AS "equipmentName",
  ep.status AS "equipmentProfileStatus",
  COALESCE(at.code, CASE WHEN ep.id IS NOT NULL THEN 'EQUIPMENT' ELSE 'ASSET' END)
    AS "equipmentType",
  ai.id AS "assetIdentifierId",
  ai.identifier_type AS "identifierType",
  COALESCE(ai.identifier_value, ep.equipment_code, a.asset_code)
    AS "identifierReference",
  ai.status AS "identifierStatus",
  ac.id AS "assetCertificationId",
  ac.certification_type AS "certificationType",
  ac.certificate_number AS "certificationReference",
  ac.status AS "certificationStatus",
  ac.issue_date AS "certificationIssueDate",
  ac.expiry_date AS "certificationExpiryDate",
  ib.id AS "inspectionBindingId",
  ib.status AS "inspectionBindingStatus",
  ce.id AS "inspectionExecutionId",
  ce.status AS "inspectionStatus",
  pe.status,
  pe.valid_from AS "validFrom",
  pe.valid_until AS "validUntil",
  CASE
    WHEN pv.status = 'REVOKED' THEN 'REVOKED'
    WHEN pv.valid_until <= NOW() THEN 'EXPIRED'
    WHEN pv.valid_from <= NOW() THEN 'VALID'
    WHEN pv.id IS NOT NULL THEN 'PENDING'
    ELSE NULL
  END AS "permitValidityStatus",
  pe.notes,
  pe.created_by_user_id AS "createdByUserId",
  pe.updated_by_user_id AS "updatedByUserId",
  pe.deactivated_at AS "deactivatedAt",
  pe.deactivated_by_user_id AS "deactivatedByUserId",
  pe.created_at AS "createdAt",
  pe.updated_at AS "updatedAt"
`;

const JOINS = `
  FROM permit_equipment pe
  JOIN permit_applications pa ON pa.id = pe.permit_application_id
  JOIN permits p ON p.id = pa.permit_id
  JOIN assets a ON a.id = pe.asset_id
  LEFT JOIN asset_types at ON at.id = a.asset_type_id
  LEFT JOIN equipment_profiles ep ON ep.id = pe.equipment_profile_id
  LEFT JOIN asset_identifiers ai ON ai.id = pe.asset_identifier_id
  LEFT JOIN asset_certifications ac ON ac.id = pe.asset_certification_id
  LEFT JOIN inspection_bindings ib ON ib.id = pe.inspection_binding_id
  LEFT JOIN checklist_executions ce ON ce.id = pe.inspection_execution_id
  LEFT JOIN LATERAL (
    SELECT latest.* FROM permit_validities latest
    WHERE latest.permit_application_id = pa.id
    ORDER BY latest.created_at DESC, latest.id DESC
    LIMIT 1
  ) pv ON TRUE
`;

async function create(input: NewPermitEquipment): Promise<PermitEquipmentRecord> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO permit_equipment
       (id, permit_application_id, asset_id, equipment_profile_id,
        asset_identifier_id, asset_certification_id, inspection_binding_id,
        inspection_execution_id, valid_from, valid_until, notes,
        created_by_user_id, updated_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [id, input.permitApplicationId, input.assetId, input.equipmentProfileId,
      input.assetIdentifierId, input.assetCertificationId,
      input.inspectionBindingId, input.inspectionExecutionId, input.validFrom,
      input.validUntil, input.notes, input.actorUserId],
  );
  return (await findById(id)) as PermitEquipmentRecord;
}

async function findById(id: string): Promise<PermitEquipmentRecord | null> {
  const result = await getPool().query<PermitEquipmentRecord>(
    `SELECT ${SELECT} ${JOINS} WHERE pe.id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveDuplicate(
  permitApplicationId: string,
  assetId: string,
): Promise<PermitEquipmentRecord | null> {
  const result = await getPool().query<PermitEquipmentRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE pe.permit_application_id = $1 AND pe.asset_id = $2
       AND pe.status = 'ACTIVE'`,
    [permitApplicationId, assetId],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: PermitEquipmentFilters,
  accessibleBuildingIds: string[],
): Promise<PermitEquipmentRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['p.building_id = ANY($1::uuid[])'];
  const fields: [keyof PermitEquipmentFilters, string][] = [
    ['permitId', 'p.id'],
    ['permitApplicationId', 'pa.id'],
    ['buildingId', 'p.building_id'],
    ['contractorContextType', 'p.contractor_context_type'],
    ['contractorVendorId', 'p.contractor_vendor_id'],
    ['assetId', 'a.id'],
    ['status', 'pe.status'],
  ];
  for (const [key, column] of fields) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      conditions.push(`${column} = $${values.length}`);
    }
  }
  if (filters.contractorContextId) {
    values.push(filters.contractorContextId);
    conditions.push(`(p.contractor_vendor_id = $${values.length}
      OR p.tenant_contractor_relationship_id = $${values.length})`);
  }
  const result = await getPool().query<PermitEquipmentRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE ${conditions.join(' AND ')}
     ORDER BY pe.created_at, pe.id`,
    values,
  );
  return result.rows;
}

async function updateActive(
  id: string,
  input: UpdatePermitEquipmentInput,
  actorUserId: string,
): Promise<PermitEquipmentRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const fields: [keyof UpdatePermitEquipmentInput, string][] = [
    ['assetIdentifierId', 'asset_identifier_id'],
    ['assetCertificationId', 'asset_certification_id'],
    ['inspectionBindingId', 'inspection_binding_id'],
    ['inspectionExecutionId', 'inspection_execution_id'],
    ['validFrom', 'valid_from'],
    ['validUntil', 'valid_until'],
    ['notes', 'notes'],
  ];
  for (const [key, column] of fields) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  values.push(actorUserId);
  sets.push(`updated_by_user_id = $${values.length}`);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<{ id: string }>(
    `UPDATE permit_equipment SET ${sets.join(', ')}
     WHERE id = $${values.length} AND status = 'ACTIVE' RETURNING id`,
    values,
  );
  return result.rows[0] ? findById(id) : null;
}

async function deactivate(
  id: string,
  actorUserId: string,
): Promise<PermitEquipmentRecord | null> {
  const result = await getPool().query<{ id: string }>(
    `UPDATE permit_equipment
     SET status='INACTIVE', deactivated_at=NOW(), deactivated_by_user_id=$2,
         updated_by_user_id=$2, updated_at=NOW()
     WHERE id=$1 AND status='ACTIVE' RETURNING id`,
    [id, actorUserId],
  );
  return result.rows[0] ? findById(id) : null;
}

export const permitEquipmentRepository = {
  create,
  deactivate,
  findActiveDuplicate,
  findById,
  list,
  updateActive,
};
