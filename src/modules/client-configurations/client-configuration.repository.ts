import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ClientConfigurationFilters,
  ClientConfigurationRecord,
  NewClientConfiguration,
  UpdateClientConfigurationInput,
} from './client-configuration.types';

const CLIENT_CONFIGURATION_SELECT = `
  id,
  client_id AS "clientId",
  key,
  value,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(
  input: NewClientConfiguration,
): Promise<ClientConfigurationRecord> {
  const result = await getPool().query<ClientConfigurationRecord>(
    `INSERT INTO client_configurations (id, client_id, key, value, status)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING ${CLIENT_CONFIGURATION_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.key,
      JSON.stringify(input.value),
      input.status,
    ],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<ClientConfigurationRecord | null> {
  const result = await getPool().query<ClientConfigurationRecord>(
    `SELECT ${CLIENT_CONFIGURATION_SELECT}
       FROM client_configurations
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByClientAndKey(
  clientId: string,
  key: string,
): Promise<ClientConfigurationRecord | null> {
  const result = await getPool().query<ClientConfigurationRecord>(
    `SELECT ${CLIENT_CONFIGURATION_SELECT}
       FROM client_configurations
      WHERE client_id = $1 AND key = $2`,
    [clientId, key],
  );
  return result.rows[0] ?? null;
}

async function listByClient(
  clientId: string,
  filters: ClientConfigurationFilters = {},
): Promise<ClientConfigurationRecord[]> {
  const values: unknown[] = [clientId];
  const where = ['client_id = $1'];
  if (filters.status) {
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }

  const result = await getPool().query<ClientConfigurationRecord>(
    `SELECT ${CLIENT_CONFIGURATION_SELECT}
       FROM client_configurations
      WHERE ${where.join(' AND ')}
      ORDER BY key ASC`,
    values,
  );
  return result.rows;
}

async function listActiveByClient(
  clientId: string,
): Promise<ClientConfigurationRecord[]> {
  return listByClient(clientId, { status: 'ACTIVE' });
}

async function update(
  id: string,
  input: UpdateClientConfigurationInput,
): Promise<ClientConfigurationRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.value !== undefined) {
    values.push(JSON.stringify(input.value));
    sets.push(`value = $${values.length}::jsonb`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<ClientConfigurationRecord>(
    `UPDATE client_configurations
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING ${CLIENT_CONFIGURATION_SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

export const clientConfigurationRepository = {
  create,
  findByClientAndKey,
  findById,
  listActiveByClient,
  listByClient,
  update,
};
