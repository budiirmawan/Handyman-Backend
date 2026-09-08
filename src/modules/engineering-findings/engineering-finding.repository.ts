import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { FindingSourceType } from '../findings/finding.types';
import type {
  EngineeringFindingLinkRecord,
  EngineeringFindingOperationType,
} from './engineering-finding.types';

/**
 * BE-10H — Engineering Finding Binding repository.
 *
 * Holds the Engineering context link for BE-09 Findings and resolves the
 * Building / Client of Engineering source executions. The Finding itself
 * lives exclusively in BE-09's `findings` table — this repository never
 * writes Finding lifecycle data.
 */

type EngineeringFindingLinkRow = {
  id: string;
  client_id: string;
  building_id: string;
  finding_id: string;
  asset_id: string | null;
  functional_location_id: string | null;
  operation_type: EngineeringFindingOperationType;
  source_type: FindingSourceType | null;
  source_id: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

export type EngineeringFindingListRow = EngineeringFindingLinkRow & {
  f_id: string;
  f_finding_number: string;
  f_title: string;
  f_description: string | null;
  f_classification_id: string | null;
  f_severity_id: string | null;
  f_status: string;
  f_reported_by_user_id: string;
  f_reported_at: Date;
  f_state_changed_at: Date;
  f_closed_at: Date | null;
  f_closed_by_user_id: string | null;
  f_closure_notes: string | null;
  f_created_at: Date;
  f_updated_at: Date;
};

function mapRow(row: EngineeringFindingLinkRow): EngineeringFindingLinkRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    findingId: row.finding_id,
    assetId: row.asset_id,
    functionalLocationId: row.functional_location_id,
    operationType: row.operation_type,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: {
    clientId: string;
    buildingId: string;
    findingId: string;
    assetId: string | null;
    functionalLocationId: string | null;
    operationType: EngineeringFindingOperationType;
    sourceType: FindingSourceType | null;
    sourceId: string | null;
    createdByUserId: string;
  },
): Promise<EngineeringFindingLinkRecord> {
  const result = await getPool().query<EngineeringFindingLinkRow>(
    `INSERT INTO engineering_finding_links
       (id, client_id, building_id, finding_id, asset_id,
        functional_location_id, operation_type, source_type, source_id,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, client_id, building_id, finding_id, asset_id,
               functional_location_id, operation_type, source_type, source_id,
               created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.findingId,
      input.assetId,
      input.functionalLocationId,
      input.operationType,
      input.sourceType,
      input.sourceId,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<EngineeringFindingLinkRecord | null> {
  const result = await getPool().query<EngineeringFindingLinkRow>(
    `SELECT id, client_id, building_id, finding_id, asset_id,
            functional_location_id, operation_type, source_type, source_id,
            created_by_user_id, created_at, updated_at
     FROM engineering_finding_links WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByFindingId(
  findingId: string,
): Promise<EngineeringFindingLinkRecord | null> {
  const result = await getPool().query<EngineeringFindingLinkRow>(
    `SELECT id, client_id, building_id, finding_id, asset_id,
            functional_location_id, operation_type, source_type, source_id,
            created_by_user_id, created_at, updated_at
     FROM engineering_finding_links WHERE finding_id = $1`,
    [findingId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findBySource(
  sourceType: FindingSourceType,
  sourceId: string,
): Promise<EngineeringFindingLinkRecord | null> {
  const result = await getPool().query<EngineeringFindingLinkRow>(
    `SELECT id, client_id, building_id, finding_id, asset_id,
            functional_location_id, operation_type, source_type, source_id,
            created_by_user_id, created_at, updated_at
     FROM engineering_finding_links
     WHERE source_type = $1 AND source_id = $2`,
    [sourceType, sourceId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingIds(
  buildingIds: string[],
  filters: { assetId?: string; sourceType?: FindingSourceType; status?: string },
): Promise<EngineeringFindingListRow[]> {
  const result = await getPool().query<EngineeringFindingListRow>(
    `SELECT
       l.id, l.client_id, l.building_id, l.finding_id, l.asset_id,
       l.functional_location_id, l.operation_type, l.source_type, l.source_id,
       l.created_by_user_id, l.created_at, l.updated_at,
       f.id AS f_id, f.finding_number AS f_finding_number,
       f.title AS f_title, f.description AS f_description,
       f.classification_id AS f_classification_id,
       f.severity_id AS f_severity_id, f.status AS f_status,
       f.reported_by_user_id AS f_reported_by_user_id,
       f.reported_at AS f_reported_at,
       f.state_changed_at AS f_state_changed_at,
       f.closed_at AS f_closed_at, f.closed_by_user_id AS f_closed_by_user_id,
       f.closure_notes AS f_closure_notes,
       f.created_at AS f_created_at, f.updated_at AS f_updated_at
     FROM engineering_finding_links l
     JOIN findings f ON f.id = l.finding_id
     WHERE l.building_id = ANY($1::uuid[])
       AND ($2::uuid IS NULL OR l.asset_id = $2)
       AND ($3::text IS NULL OR l.source_type = $3)
       AND ($4::text IS NULL OR f.status = $4)
     ORDER BY f.reported_at DESC
     LIMIT 200`,
    [
      buildingIds,
      filters.assetId ?? null,
      filters.sourceType ?? null,
      filters.status ?? null,
    ],
  );
  return result.rows;
}

/**
 * Resolves the Building / Client of an Engineering source execution. Only
 * Engineering-bound sources resolve: checklist executions started from an
 * inspection / engineering checklist binding, form instances started from a
 * meter reading / log sheet binding, and Work Orders. Plain BE-07 executions
 * resolve to NULL building and are rejected by the service.
 */
export async function resolveSourceContext(
  sourceType: FindingSourceType,
  sourceId: string,
): Promise<{ clientId: string; buildingId: string | null } | null> {
  if (sourceType === 'WORK_ORDER') {
    const result = await getPool().query<{ client_id: string; building_id: string }>(
      `SELECT client_id, building_id FROM work_orders WHERE id = $1`,
      [sourceId],
    );
    return result.rows[0]
      ? { clientId: result.rows[0].client_id, buildingId: result.rows[0].building_id }
      : null;
  }

  if (sourceType === 'CHECKLIST_EXECUTION') {
    const result = await getPool().query<{
      client_id: string;
      building_id: string | null;
    }>(
      `SELECT
         ce.client_id,
         COALESCE(ib.building_id, ecb.building_id) AS building_id
       FROM checklist_executions ce
       LEFT JOIN inspection_bindings ib ON ib.id = ce.inspection_binding_id
       LEFT JOIN engineering_checklist_bindings ecb
         ON ecb.id = ce.engineering_checklist_binding_id
       WHERE ce.id = $1`,
      [sourceId],
    );
    return result.rows[0]
      ? { clientId: result.rows[0].client_id, buildingId: result.rows[0].building_id }
      : null;
  }

  const result = await getPool().query<{
    client_id: string;
    building_id: string | null;
  }>(
    `SELECT
       fi.client_id,
       COALESCE(mrb.building_id, lsb.building_id) AS building_id
     FROM form_instances fi
     LEFT JOIN meter_reading_bindings mrb ON mrb.id = fi.meter_reading_binding_id
     LEFT JOIN log_sheet_bindings lsb ON lsb.id = fi.log_sheet_binding_id
     WHERE fi.id = $1`,
    [sourceId],
  );
  return result.rows[0]
    ? { clientId: result.rows[0].client_id, buildingId: result.rows[0].building_id }
    : null;
}

export const engineeringFindingRepository = {
  create,
  findById,
  findByFindingId,
  findBySource,
  listByBuildingIds,
  resolveSourceContext,
};
