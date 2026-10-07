import { getPool } from '../../database';
import type {
  ExternalOrganizationRecord,
  ExternalOrganizationStatus,
} from './external-organization.types';

type ExternalOrganizationRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  status: ExternalOrganizationStatus;
  created_at: Date;
  updated_at: Date;
};

const ORGANIZATION_SELECT = `
  id,
  client_id,
  code,
  name,
  status,
  created_at,
  updated_at
`;

function mapRow(row: ExternalOrganizationRow): ExternalOrganizationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    code: row.code,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * BE-03H deliberately exposes only reads for the External Organization
 * reference: rows are expected to come from a future Vendor module (or from
 * test seeding) — this Wave implements no Vendor workflows and no write
 * surface for the reference itself.
 */
async function findById(id: string): Promise<ExternalOrganizationRecord | null> {
  const result = await getPool().query<ExternalOrganizationRow>(
    `SELECT ${ORGANIZATION_SELECT} FROM external_organizations WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const externalOrganizationRepository = {
  findById,
};
