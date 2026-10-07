import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewUtilityTypeConfiguration,
  UpdateUtilityTypeConfigurationInput,
  UpdateUtilityTypeUomInput,
  UtilityTypeConfigurationFilters,
  UtilityTypeConfigurationRecord,
  UtilityTypeConfigurationStatus,
  UtilityTypeUomRecord,
  UtilityType,
} from './utility-type-configuration.types';

/** BE-18B — utility type configuration persistence. */

const CONFIGURATION_SELECT = `
  id,
  client_id AS "clientId",
  utility_type AS "utilityType",
  name,
  description,
  decimal_precision AS "decimalPrecision",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const UOM_SELECT = `
  id,
  utility_type_configuration_id AS "utilityTypeConfigurationId",
  uom_id AS "uomId",
  is_default AS "isDefault",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function createConfiguration(
  input: NewUtilityTypeConfiguration,
): Promise<UtilityTypeConfigurationRecord> {
  const result = await getPool().query<UtilityTypeConfigurationRecord>(
    `INSERT INTO utility_type_configurations
       (id, client_id, utility_type, name, description, decimal_precision, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${CONFIGURATION_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.utilityType,
      input.name,
      input.description,
      input.decimalPrecision,
      input.status,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<UtilityTypeConfigurationRecord | null> {
  const result = await getPool().query<UtilityTypeConfigurationRecord>(
    `SELECT ${CONFIGURATION_SELECT} FROM utility_type_configurations WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByClientAndType(
  clientId: string,
  utilityType: UtilityType,
): Promise<UtilityTypeConfigurationRecord | null> {
  const result = await getPool().query<UtilityTypeConfigurationRecord>(
    `SELECT ${CONFIGURATION_SELECT} FROM utility_type_configurations
     WHERE client_id = $1 AND utility_type = $2`,
    [clientId, utilityType],
  );
  return result.rows[0] ?? null;
}

async function listByClient(
  clientId: string,
  filters: UtilityTypeConfigurationFilters,
): Promise<UtilityTypeConfigurationRecord[]> {
  const conditions: string[] = ['client_id = $1'];
  const values: unknown[] = [clientId];
  let index = 2;

  if (filters.utilityType) {
    conditions.push(`utility_type = $${index++}`);
    values.push(filters.utilityType);
  }
  if (filters.status) {
    conditions.push(`status = $${index++}`);
    values.push(filters.status);
  }

  const result = await getPool().query<UtilityTypeConfigurationRecord>(
    `SELECT ${CONFIGURATION_SELECT} FROM utility_type_configurations
     WHERE ${conditions.join(' AND ')}
     ORDER BY utility_type ASC`,
    values,
  );
  return result.rows;
}

async function updateConfiguration(
  id: string,
  input: UpdateUtilityTypeConfigurationInput,
): Promise<UtilityTypeConfigurationRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  if (input.name !== undefined) {
    sets.push(`name = $${index++}`);
    values.push(input.name);
  }
  if (input.description !== undefined) {
    sets.push(`description = $${index++}`);
    values.push(input.description);
  }
  if (input.decimalPrecision !== undefined) {
    sets.push(`decimal_precision = $${index++}`);
    values.push(input.decimalPrecision);
  }
  if (input.status !== undefined) {
    sets.push(`status = $${index++}`);
    values.push(input.status);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  sets.push('updated_at = NOW()');
  values.push(id);

  const result = await getPool().query<UtilityTypeConfigurationRecord>(
    `UPDATE utility_type_configurations SET ${sets.join(', ')}
     WHERE id = $${index}
     RETURNING ${CONFIGURATION_SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

async function listUoms(
  configurationId: string,
): Promise<UtilityTypeUomRecord[]> {
  const result = await getPool().query<UtilityTypeUomRecord>(
    `SELECT ${UOM_SELECT} FROM utility_type_uoms
     WHERE utility_type_configuration_id = $1
     ORDER BY is_default DESC, created_at ASC`,
    [configurationId],
  );
  return result.rows;
}

async function listUomsForConfigurations(
  configurationIds: readonly string[],
): Promise<UtilityTypeUomRecord[]> {
  if (configurationIds.length === 0) {
    return [];
  }
  const result = await getPool().query<UtilityTypeUomRecord>(
    `SELECT ${UOM_SELECT} FROM utility_type_uoms
     WHERE utility_type_configuration_id = ANY($1)
     ORDER BY is_default DESC, created_at ASC`,
    [[...configurationIds]],
  );
  return result.rows;
}

async function findUomMapping(
  configurationId: string,
  uomId: string,
): Promise<UtilityTypeUomRecord | null> {
  const result = await getPool().query<UtilityTypeUomRecord>(
    `SELECT ${UOM_SELECT} FROM utility_type_uoms
     WHERE utility_type_configuration_id = $1 AND uom_id = $2`,
    [configurationId, uomId],
  );
  return result.rows[0] ?? null;
}

/**
 * Adds an allowed UOM. Promoting a mapping to default demotes the previous
 * ACTIVE default in the same transaction, so the partial unique index
 * `utility_type_uoms_default_unique` can never be violated by a race.
 */
async function addUom(input: {
  utilityTypeConfigurationId: string;
  uomId: string;
  isDefault: boolean;
  status: UtilityTypeConfigurationStatus;
}): Promise<UtilityTypeUomRecord> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT id FROM utility_type_configurations WHERE id = $1 FOR UPDATE',
      [input.utilityTypeConfigurationId],
    );

    if (input.isDefault && input.status === 'ACTIVE') {
      await client.query(
        `UPDATE utility_type_uoms
           SET is_default = FALSE, updated_at = NOW()
         WHERE utility_type_configuration_id = $1 AND is_default`,
        [input.utilityTypeConfigurationId],
      );
    }

    const result = await client.query<UtilityTypeUomRecord>(
      `INSERT INTO utility_type_uoms
         (id, utility_type_configuration_id, uom_id, is_default, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${UOM_SELECT}`,
      [
        randomUUID(),
        input.utilityTypeConfigurationId,
        input.uomId,
        input.isDefault,
        input.status,
      ],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function updateUom(
  id: string,
  configurationId: string,
  input: UpdateUtilityTypeUomInput,
): Promise<UtilityTypeUomRecord | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT id FROM utility_type_configurations WHERE id = $1 FOR UPDATE',
      [configurationId],
    );

    const promoting =
      input.isDefault === true && (input.status ?? 'ACTIVE') === 'ACTIVE';
    if (promoting) {
      await client.query(
        `UPDATE utility_type_uoms
           SET is_default = FALSE, updated_at = NOW()
         WHERE utility_type_configuration_id = $1 AND is_default AND id <> $2`,
        [configurationId, id],
      );
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    let index = 1;

    if (input.isDefault !== undefined) {
      sets.push(`is_default = $${index++}`);
      values.push(input.isDefault);
    }
    if (input.status !== undefined) {
      sets.push(`status = $${index++}`);
      values.push(input.status);
      // An INACTIVE mapping can never remain the default.
      if (input.status === 'INACTIVE' && input.isDefault === undefined) {
        sets.push('is_default = FALSE');
      }
    }

    if (sets.length === 0) {
      await client.query('COMMIT');
      return findUomById(id);
    }

    sets.push('updated_at = NOW()');
    values.push(id);

    const result = await client.query<UtilityTypeUomRecord>(
      `UPDATE utility_type_uoms SET ${sets.join(', ')}
       WHERE id = $${index}
       RETURNING ${UOM_SELECT}`,
      values,
    );

    await client.query('COMMIT');
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function findUomById(id: string): Promise<UtilityTypeUomRecord | null> {
  const result = await getPool().query<UtilityTypeUomRecord>(
    `SELECT ${UOM_SELECT} FROM utility_type_uoms WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const utilityTypeConfigurationRepository = {
  addUom,
  createConfiguration,
  findByClientAndType,
  findById,
  findUomById,
  findUomMapping,
  listByClient,
  listUoms,
  listUomsForConfigurations,
  updateConfiguration,
  updateUom,
};
