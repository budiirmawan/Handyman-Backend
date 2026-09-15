import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewProperty,
  PropertyRecord,
  PropertyStatus,
} from './property.types';

type PropertyRow = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: PropertyStatus;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const PROPERTY_SELECT = `
  id,
  client_id AS "clientId",
  code,
  name,
  description,
  status,
  address_line AS "addressLine",
  city,
  province,
  postal_code AS "postalCode",
  country_code AS "countryCode",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapPropertyRow(row: PropertyRow): PropertyRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    addressLine: row.addressLine,
    city: row.city,
    province: row.province,
    postalCode: row.postalCode,
    countryCode: row.countryCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createProperty(input: NewProperty): Promise<PropertyRecord> {
  const result = await getPool().query<PropertyRow>(
    `INSERT INTO properties
       (id, client_id, code, name, description, status,
        address_line, city, province, postal_code, country_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${PROPERTY_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.description,
      input.status,
      input.addressLine,
      input.city,
      input.province,
      input.postalCode,
      input.countryCode,
    ],
  );

  return mapPropertyRow(result.rows[0]);
}

async function findById(id: string): Promise<PropertyRecord | null> {
  const result = await getPool().query<PropertyRow>(
    `SELECT ${PROPERTY_SELECT} FROM properties WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapPropertyRow(row) : null;
}

async function findByCodeForClient(
  clientId: string,
  code: string,
): Promise<PropertyRecord | null> {
  const result = await getPool().query<PropertyRow>(
    `SELECT ${PROPERTY_SELECT} FROM properties
     WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );

  const row = result.rows[0];
  return row ? mapPropertyRow(row) : null;
}

async function listProperties(): Promise<PropertyRecord[]> {
  const result = await getPool().query<PropertyRow>(
    `SELECT ${PROPERTY_SELECT} FROM properties ORDER BY code ASC`,
  );

  return result.rows.map(mapPropertyRow);
}

async function listByClient(clientId: string): Promise<PropertyRecord[]> {
  const result = await getPool().query<PropertyRow>(
    `SELECT ${PROPERTY_SELECT} FROM properties
     WHERE client_id = $1 ORDER BY code ASC`,
    [clientId],
  );

  return result.rows.map(mapPropertyRow);
}

async function updateStatus(
  id: string,
  status: PropertyStatus,
): Promise<PropertyRecord | null> {
  const result = await getPool().query<PropertyRow>(
    `UPDATE properties SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${PROPERTY_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapPropertyRow(row) : null;
}

export const propertyRepository = {
  createProperty,
  findByCodeForClient,
  findById,
  listByClient,
  listProperties,
  updateStatus,
};
