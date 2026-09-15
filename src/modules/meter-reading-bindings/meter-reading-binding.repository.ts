import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  MeterReadingBindingRecord,
  MeterReadingBindingStatus,
} from './meter-reading-binding.types';

/**
 * BE-10C — Meter Reading Binding repository.
 *
 * Holds binding references, starts shared BE-07 Form Instances as reading
 * executions, and submits numeric readings into BE-07's own `form_responses`
 * store (same table and upsert idiom as BE-07's response save — no second
 * response or measurement service exists).
 */

type MeterReadingBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  asset_id: string;
  form_field_id: string;
  uom_id: string;
  functional_location_id: string | null;
  minimum_value: string | null;
  maximum_value: string | null;
  status: MeterReadingBindingStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

export type ReadingFieldRow = {
  id: string;
  client_id: string;
  template_id: string;
  section_id: string;
  code: string;
  label: string;
  field_type: string;
  status: string;
  uom_id: string | null;
  minimum_value: string | null;
  maximum_value: string | null;
  decimal_precision: number | null;
};

export type UomRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  symbol: string;
  status: string;
};

export type ExecutionRow = {
  id: string;
  client_id: string;
  form_template_version_id: string;
  meter_reading_binding_id: string | null;
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
  meter_reading_binding_id: string | null;
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
  uom_id: string | null;
  uom_code: string | null;
  uom_name: string | null;
  uom_symbol: string | null;
  binding_minimum_value: string | null;
  binding_maximum_value: string | null;
  field_minimum_value: string | null;
  field_maximum_value: string | null;
  current_value: unknown | null;
};

function mapRow(row: MeterReadingBindingRow): MeterReadingBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    assetId: row.asset_id,
    formFieldId: row.form_field_id,
    uomId: row.uom_id,
    functionalLocationId: row.functional_location_id,
    minimumValue: row.minimum_value,
    maximumValue: row.maximum_value,
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
    formFieldId: string;
    uomId: string;
    functionalLocationId: string | null;
    minimumValue: number | null;
    maximumValue: number | null;
    status: MeterReadingBindingStatus;
    createdByUserId: string;
  },
): Promise<MeterReadingBindingRecord> {
  const result = await getPool().query<MeterReadingBindingRow>(
    `INSERT INTO meter_reading_bindings
       (id, client_id, building_id, asset_id, form_field_id, uom_id,
        functional_location_id, minimum_value, maximum_value, status,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, client_id, building_id, asset_id, form_field_id, uom_id,
               functional_location_id, minimum_value, maximum_value, status,
               created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.assetId,
      input.formFieldId,
      input.uomId,
      input.functionalLocationId,
      input.minimumValue,
      input.maximumValue,
      input.status,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<MeterReadingBindingRecord | null> {
  const result = await getPool().query<MeterReadingBindingRow>(
    `SELECT id, client_id, building_id, asset_id, form_field_id, uom_id,
            functional_location_id, minimum_value, maximum_value, status,
            created_by_user_id, created_at, updated_at
     FROM meter_reading_bindings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findActiveByAssetAndField(
  assetId: string,
  formFieldId: string,
): Promise<MeterReadingBindingRecord | null> {
  const result = await getPool().query<MeterReadingBindingRow>(
    `SELECT id, client_id, building_id, asset_id, form_field_id, uom_id,
            functional_location_id, minimum_value, maximum_value, status,
            created_by_user_id, created_at, updated_at
     FROM meter_reading_bindings
     WHERE asset_id = $1 AND form_field_id = $2 AND status = 'ACTIVE'`,
    [assetId, formFieldId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByAssetId(
  assetId: string,
): Promise<MeterReadingBindingRecord[]> {
  const result = await getPool().query<MeterReadingBindingRow>(
    `SELECT id, client_id, building_id, asset_id, form_field_id, uom_id,
            functional_location_id, minimum_value, maximum_value, status,
            created_by_user_id, created_at, updated_at
     FROM meter_reading_bindings
     WHERE asset_id = $1
     ORDER BY created_at DESC`,
    [assetId],
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingId(
  buildingId: string,
): Promise<MeterReadingBindingRecord[]> {
  const result = await getPool().query<MeterReadingBindingRow>(
    `SELECT id, client_id, building_id, asset_id, form_field_id, uom_id,
            functional_location_id, minimum_value, maximum_value, status,
            created_by_user_id, created_at, updated_at
     FROM meter_reading_bindings
     WHERE building_id = $1
     ORDER BY created_at DESC`,
    [buildingId],
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: {
    uomId?: string;
    functionalLocationId?: string | null;
    minimumValue?: number;
    maximumValue?: number;
    status?: MeterReadingBindingStatus;
  },
): Promise<MeterReadingBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.uomId !== undefined) {
    values.push(input.uomId);
    sets.push(`uom_id = $${values.length}`);
  }
  if (input.functionalLocationId !== undefined) {
    values.push(input.functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }
  if (input.minimumValue !== undefined) {
    values.push(input.minimumValue);
    sets.push(`minimum_value = $${values.length}`);
  }
  if (input.maximumValue !== undefined) {
    values.push(input.maximumValue);
    sets.push(`maximum_value = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  values.push(id);
  const result = await getPool().query<MeterReadingBindingRow>(
    `UPDATE meter_reading_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, client_id, building_id, asset_id, form_field_id, uom_id,
               functional_location_id, minimum_value, maximum_value, status,
               created_by_user_id, created_at, updated_at`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** The BE-07 numeric Form Field plus its owning template / client context. */
export async function findReadingField(
  formFieldId: string,
): Promise<ReadingFieldRow | null> {
  const result = await getPool().query<ReadingFieldRow>(
    `SELECT
       f.id,
       t.client_id,
       t.id AS template_id,
       f.form_section_id AS section_id,
       f.code,
       f.label,
       f.field_type,
       f.status,
       f.uom_id,
       f.minimum_value,
       f.maximum_value,
       f.decimal_precision
     FROM form_fields f
     JOIN form_sections s ON s.id = f.form_section_id
     JOIN form_templates t ON t.id = s.form_template_id
     WHERE f.id = $1`,
    [formFieldId],
  );
  return result.rows[0] ?? null;
}

export async function findUom(uomId: string): Promise<UomRow | null> {
  const result = await getPool().query<UomRow>(
    `SELECT id, client_id, code, name, symbol, status
     FROM units_of_measure WHERE id = $1`,
    [uomId],
  );
  return result.rows[0] ?? null;
}

/** The latest PUBLISHED version of the reading field's template (BE-07). */
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

/** The version field snapshot of the reading field within a version. */
export async function findVersionField(
  versionId: string,
  formFieldId: string,
): Promise<{ id: string; fieldType: string } | null> {
  const result = await getPool().query<{ id: string; field_type: string }>(
    `SELECT vf.id, vf.field_type
     FROM form_template_version_fields vf
     JOIN form_template_version_sections vs ON vs.id = vf.version_section_id
     WHERE vs.version_id = $1 AND vf.field_id = $2`,
    [versionId, formFieldId],
  );
  return result.rows[0]
    ? { id: result.rows[0].id, fieldType: result.rows[0].field_type }
    : null;
}

/** Starts the shared BE-07 form instance (the reading execution). */
export async function insertExecution(
  input: {
    bindingId: string;
    clientId: string;
    versionId: string;
  },
): Promise<ExecutionRow> {
  const result = await getPool().query<ExecutionRow>(
    `INSERT INTO form_instances
       (id, client_id, form_template_version_id, meter_reading_binding_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, client_id, form_template_version_id,
               meter_reading_binding_id, status, started_at, completed_at,
               created_at, updated_at`,
    [randomUUID(), input.clientId, input.versionId, input.bindingId],
  );
  return result.rows[0];
}

export async function findExecution(
  instanceId: string,
): Promise<ExecutionRow | null> {
  const result = await getPool().query<ExecutionRow>(
    `SELECT id, client_id, form_template_version_id, meter_reading_binding_id,
            status, started_at, completed_at, created_at, updated_at
     FROM form_instances WHERE id = $1`,
    [instanceId],
  );
  return result.rows[0] ?? null;
}

/**
 * Writes the numeric reading into BE-07's own `form_responses` store using
 * the same table and upsert idiom as BE-07's response save. The conflict
 * target must match BE-07's occurrence-aware unique index exactly (meter
 * readings never use repeatable occurrences). Returns the written row so the
 * API can echo the submitted reading.
 */
export async function upsertReadingResponse(
  input: {
    formInstanceId: string;
    versionFieldId: string;
    value: number;
  },
): Promise<{ value: number; updatedAt: Date }> {
  const result = await getPool().query<{ value: number; updated_at: Date }>(
    `INSERT INTO form_responses (id, form_instance_id, version_field_id, value)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (
       form_instance_id,
       version_field_id,
       (COALESCE(occurrence_id, '00000000-0000-0000-0000-000000000000'))
     )
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
     RETURNING value, updated_at`,
    [
      randomUUID(),
      input.formInstanceId,
      input.versionFieldId,
      JSON.stringify(input.value),
    ],
  );
  return {
    value: Number(result.rows[0].value),
    updatedAt: result.rows[0].updated_at,
  };
}

/**
 * Resolves the reading execution context: instance → binding → Asset /
 * Building / Functional Location / UOM plus the effective range and the
 * current BE-07 response value. One authoritative join — never stored twice.
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
       mrb.id AS meter_reading_binding_id,
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
       uom.id AS uom_id,
       uom.code AS uom_code,
       uom.name AS uom_name,
       uom.symbol AS uom_symbol,
       mrb.minimum_value AS binding_minimum_value,
       mrb.maximum_value AS binding_maximum_value,
       ff.minimum_value AS field_minimum_value,
       ff.maximum_value AS field_maximum_value,
       r.value AS current_value
     FROM form_instances fi
     LEFT JOIN meter_reading_bindings mrb
       ON mrb.id = fi.meter_reading_binding_id
     LEFT JOIN assets a ON a.id = mrb.asset_id
     LEFT JOIN buildings b ON b.id = mrb.building_id
     LEFT JOIN functional_locations fl ON fl.id = mrb.functional_location_id
     LEFT JOIN units_of_measure uom ON uom.id = mrb.uom_id
     LEFT JOIN form_fields ff ON ff.id = mrb.form_field_id
     LEFT JOIN form_template_version_fields vf ON vf.field_id = mrb.form_field_id
     LEFT JOIN form_template_version_sections vs ON vs.id = vf.version_section_id
       AND vs.version_id = fi.form_template_version_id
     LEFT JOIN form_responses r
       ON r.form_instance_id = fi.id AND r.version_field_id = vf.id
     WHERE fi.id = $1`,
    [instanceId],
  );
  return result.rows[0] ?? null;
}

export const meterReadingBindingRepository = {
  create,
  findActiveByAssetAndField,
  findById,
  findExecutionContext,
  findExecution,
  findLatestPublishedVersion,
  findReadingField,
  findUom,
  findVersionField,
  insertExecution,
  listByAssetId,
  listByBuildingId,
  update,
  upsertReadingResponse,
};
