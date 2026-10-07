import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  LogSheetBindingRecord,
  LogSheetBindingStatus,
} from './log-sheet-binding.types';

/**
 * BE-10D — Equipment Log Sheet Binding repository.
 *
 * Holds binding references, starts shared BE-07 Form Instances as log sheet
 * executions, and lists execution history references from BE-07's own
 * `form_instances` table. Responses stay BE-07's — this repository never
 * writes log data.
 */

type LogSheetBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  asset_id: string;
  form_template_id: string;
  form_template_version_id: string | null;
  functional_location_id: string | null;
  status: LogSheetBindingStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

export type LogSheetTemplateRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  status: string;
};

export type LogSheetVersionRow = {
  id: string;
  form_template_id: string;
  version_number: number;
  status: string;
  client_id: string;
};

/** A measurement field (NUMBER + UOM) that must reference a valid UOM. */
export type MeasurementFieldRow = {
  id: string;
  field_type: string;
  uom_id: string | null;
};

export type ExecutionRow = {
  id: string;
  client_id: string;
  form_template_version_id: string;
  log_sheet_binding_id: string | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type ExecutionContextRow = {
  execution_id: string;
  execution_version_id: string;
  execution_status: string;
  execution_started_at: Date | null;
  execution_completed_at: Date | null;
  execution_created_at: Date;
  execution_updated_at: Date;
  log_sheet_binding_id: string | null;
  asset_id: string | null;
  asset_code: string | null;
  asset_name: string | null;
  asset_status: string | null;
  building_id: string | null;
  building_code: string | null;
  building_name: string | null;
  functional_location_id: string | null;
  functional_location_code: string | null;
  functional_location_name: string | null;
  functional_location_status: string | null;
  template_id: string | null;
  template_code: string | null;
  template_name: string | null;
  version_number: number | null;
  version_status: string | null;
};

function mapRow(row: LogSheetBindingRow): LogSheetBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    assetId: row.asset_id,
    formTemplateId: row.form_template_id,
    formTemplateVersionId: row.form_template_version_id,
    functionalLocationId: row.functional_location_id,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: {
    clientId: string;
    buildingId: string;
    assetId: string;
    formTemplateId: string;
    formTemplateVersionId: string | null;
    functionalLocationId: string | null;
    status: LogSheetBindingStatus;
    createdByUserId: string;
  },
): Promise<LogSheetBindingRecord> {
  const result = await getPool().query<LogSheetBindingRow>(
    `INSERT INTO log_sheet_bindings
       (id, client_id, building_id, asset_id, form_template_id,
        form_template_version_id, functional_location_id, status,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, client_id, building_id, asset_id, form_template_id,
               form_template_version_id, functional_location_id, status,
               created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.assetId,
      input.formTemplateId,
      input.formTemplateVersionId,
      input.functionalLocationId,
      input.status,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<LogSheetBindingRecord | null> {
  const result = await getPool().query<LogSheetBindingRow>(
    `SELECT id, client_id, building_id, asset_id, form_template_id,
            form_template_version_id, functional_location_id, status,
            created_by_user_id, created_at, updated_at
     FROM log_sheet_bindings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findActiveByAssetAndTemplate(
  assetId: string,
  formTemplateId: string,
): Promise<LogSheetBindingRecord | null> {
  const result = await getPool().query<LogSheetBindingRow>(
    `SELECT id, client_id, building_id, asset_id, form_template_id,
            form_template_version_id, functional_location_id, status,
            created_by_user_id, created_at, updated_at
     FROM log_sheet_bindings
     WHERE asset_id = $1 AND form_template_id = $2 AND status = 'ACTIVE'`,
    [assetId, formTemplateId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByAssetId(
  assetId: string,
): Promise<LogSheetBindingRecord[]> {
  const result = await getPool().query<LogSheetBindingRow>(
    `SELECT id, client_id, building_id, asset_id, form_template_id,
            form_template_version_id, functional_location_id, status,
            created_by_user_id, created_at, updated_at
     FROM log_sheet_bindings
     WHERE asset_id = $1
     ORDER BY created_at DESC`,
    [assetId],
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingId(
  buildingId: string,
): Promise<LogSheetBindingRecord[]> {
  const result = await getPool().query<LogSheetBindingRow>(
    `SELECT id, client_id, building_id, asset_id, form_template_id,
            form_template_version_id, functional_location_id, status,
            created_by_user_id, created_at, updated_at
     FROM log_sheet_bindings
     WHERE building_id = $1
     ORDER BY created_at DESC`,
    [buildingId],
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: {
    formTemplateVersionId?: string | null;
    functionalLocationId?: string | null;
    status?: LogSheetBindingStatus;
  },
): Promise<LogSheetBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.formTemplateVersionId !== undefined) {
    values.push(input.formTemplateVersionId);
    sets.push(`form_template_version_id = $${values.length}`);
  }
  if (input.functionalLocationId !== undefined) {
    values.push(input.functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  values.push(id);
  const result = await getPool().query<LogSheetBindingRow>(
    `UPDATE log_sheet_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, client_id, building_id, asset_id, form_template_id,
               form_template_version_id, functional_location_id, status,
               created_by_user_id, created_at, updated_at`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findTemplate(
  templateId: string,
): Promise<LogSheetTemplateRow | null> {
  const result = await getPool().query<LogSheetTemplateRow>(
    `SELECT id, client_id, code, name, status
     FROM form_templates WHERE id = $1`,
    [templateId],
  );
  return result.rows[0] ?? null;
}

export async function findVersion(
  versionId: string,
): Promise<LogSheetVersionRow | null> {
  const result = await getPool().query<LogSheetVersionRow>(
    `SELECT v.id, v.form_template_id, v.version_number, v.status, t.client_id
     FROM form_template_versions v
     JOIN form_templates t ON t.id = v.form_template_id
     WHERE v.id = $1`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

export async function findLatestPublishedVersion(
  templateId: string,
): Promise<{ id: string; versionNumber: number } | null> {
  const result = await getPool().query<{ id: string; version_number: number }>(
    `SELECT id, version_number
     FROM form_template_versions
     WHERE form_template_id = $1 AND status = 'PUBLISHED'
     ORDER BY version_number DESC
     LIMIT 1`,
    [templateId],
  );
  return result.rows[0]
    ? { id: result.rows[0].id, versionNumber: result.rows[0].version_number }
    : null;
}

/**
 * Measurement fields configured in a published version snapshot: NUMBER
 * version fields whose source Form Field carries a UOM (BE-07 measurement
 * config). Used to validate that every bound measurement field uses a valid,
 * same-Client, ACTIVE UOM.
 */
export async function listVersionMeasurementFields(
  versionId: string,
): Promise<MeasurementFieldRow[]> {
  const result = await getPool().query<MeasurementFieldRow>(
    `SELECT vf.id, vf.field_type, ff.uom_id
     FROM form_template_version_fields vf
     JOIN form_template_version_sections vs ON vs.id = vf.version_section_id
     JOIN form_fields ff ON ff.id = vf.field_id
     WHERE vs.version_id = $1 AND vf.field_type = 'NUMBER'`,
    [versionId],
  );
  return result.rows;
}

/** Measurement fields configured on the template's current ACTIVE fields. */
export async function listTemplateMeasurementFields(
  templateId: string,
): Promise<MeasurementFieldRow[]> {
  const result = await getPool().query<MeasurementFieldRow>(
    `SELECT f.id, f.field_type, f.uom_id
     FROM form_fields f
     JOIN form_sections s ON s.id = f.form_section_id
     WHERE s.form_template_id = $1
       AND f.field_type = 'NUMBER'
       AND f.status = 'ACTIVE'`,
    [templateId],
  );
  return result.rows;
}

export async function countVersionFields(versionId: string): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM form_template_version_fields vf
     JOIN form_template_version_sections vs ON vs.id = vf.version_section_id
     WHERE vs.version_id = $1`,
    [versionId],
  );
  return Number(result.rows[0].count);
}

export async function findUom(
  uomId: string,
): Promise<{ id: string; client_id: string; status: string } | null> {
  const result = await getPool().query<{ id: string; client_id: string; status: string }>(
    `SELECT id, client_id, status FROM units_of_measure WHERE id = $1`,
    [uomId],
  );
  return result.rows[0] ?? null;
}

/** Starts the shared BE-07 form instance (the log sheet execution). */
export async function insertExecution(
  input: {
    bindingId: string;
    clientId: string;
    versionId: string;
  },
): Promise<ExecutionRow> {
  const result = await getPool().query<ExecutionRow>(
    `INSERT INTO form_instances
       (id, client_id, form_template_version_id, log_sheet_binding_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, client_id, form_template_version_id,
               log_sheet_binding_id, status, started_at, completed_at,
               created_at, updated_at`,
    [randomUUID(), input.clientId, input.versionId, input.bindingId],
  );
  return result.rows[0];
}

/** Historical execution references for a binding (BE-07 instances, newest first). */
export async function listExecutionsByBinding(
  bindingId: string,
): Promise<ExecutionRow[]> {
  const result = await getPool().query<ExecutionRow>(
    `SELECT id, client_id, form_template_version_id, log_sheet_binding_id,
            status, started_at, completed_at, created_at, updated_at
     FROM form_instances
     WHERE log_sheet_binding_id = $1
     ORDER BY created_at DESC`,
    [bindingId],
  );
  return result.rows;
}

/**
 * Resolves the log sheet execution context: instance → binding → Asset /
 * Building / Functional Location plus template / version. One authoritative
 * join — never stored separately.
 */
export async function findExecutionContext(
  instanceId: string,
): Promise<ExecutionContextRow | null> {
  const result = await getPool().query<ExecutionContextRow>(
    `SELECT
       fi.id AS execution_id,
       fi.form_template_version_id AS execution_version_id,
       fi.status AS execution_status,
       fi.started_at AS execution_started_at,
       fi.completed_at AS execution_completed_at,
       fi.created_at AS execution_created_at,
       fi.updated_at AS execution_updated_at,
       lsb.id AS log_sheet_binding_id,
       a.id AS asset_id,
       a.asset_code AS asset_code,
       a.asset_name AS asset_name,
       a.status AS asset_status,
       b.id AS building_id,
       b.code AS building_code,
       b.name AS building_name,
       fl.id AS functional_location_id,
       fl.code AS functional_location_code,
       fl.name AS functional_location_name,
       fl.status AS functional_location_status,
       ft.id AS template_id,
       ft.code AS template_code,
       ft.name AS template_name,
       v.version_number AS version_number,
       v.status AS version_status
     FROM form_instances fi
     LEFT JOIN log_sheet_bindings lsb
       ON lsb.id = fi.log_sheet_binding_id
     LEFT JOIN assets a ON a.id = lsb.asset_id
     LEFT JOIN buildings b ON b.id = lsb.building_id
     LEFT JOIN functional_locations fl ON fl.id = lsb.functional_location_id
     LEFT JOIN form_templates ft ON ft.id = lsb.form_template_id
     LEFT JOIN form_template_versions v
       ON v.id = fi.form_template_version_id
     WHERE fi.id = $1`,
    [instanceId],
  );
  return result.rows[0] ?? null;
}

export const logSheetBindingRepository = {
  countVersionFields,
  create,
  findActiveByAssetAndTemplate,
  findById,
  findExecutionContext,
  findLatestPublishedVersion,
  findTemplate,
  findUom,
  findVersion,
  insertExecution,
  listByAssetId,
  listByBuildingId,
  listExecutionsByBinding,
  listTemplateMeasurementFields,
  listVersionMeasurementFields,
  update,
};
