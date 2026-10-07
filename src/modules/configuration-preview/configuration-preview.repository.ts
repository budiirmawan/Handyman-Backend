import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { ConfigurationPreviewContextRecord } from './configuration-preview.types';

const SELECT = `
  id,
  configuration_version_id AS "configurationVersionId",
  client_id AS "clientId",
  building_id AS "buildingId",
  created_by_user_id AS "createdByUserId",
  status,
  expires_at AS "expiresAt",
  revoked_at AS "revokedAt",
  revoked_by_user_id AS "revokedByUserId",
  created_at AS "createdAt"
`;

async function create(input: {
  configurationVersionId: string;
  clientId: string;
  buildingId: string | null;
  createdByUserId: string;
  expiresAt: Date;
}): Promise<ConfigurationPreviewContextRecord> {
  const result = await getPool().query<ConfigurationPreviewContextRecord>(
    `INSERT INTO configuration_preview_contexts(
       id,configuration_version_id,client_id,building_id,created_by_user_id,expires_at
     ) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.configurationVersionId,
      input.clientId,
      input.buildingId,
      input.createdByUserId,
      input.expiresAt,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<ConfigurationPreviewContextRecord | null> {
  const result = await getPool().query<ConfigurationPreviewContextRecord>(
    `SELECT ${SELECT} FROM configuration_preview_contexts WHERE id=$1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function revoke(
  id: string,
  userId: string,
): Promise<ConfigurationPreviewContextRecord | null> {
  const result = await getPool().query<ConfigurationPreviewContextRecord>(
    `UPDATE configuration_preview_contexts
      SET status='REVOKED',revoked_at=NOW(),revoked_by_user_id=$1
      WHERE id=$2 AND status='ACTIVE'
      RETURNING ${SELECT}`,
    [userId, id],
  );
  return result.rows[0] ?? findById(id);
}

export const configurationPreviewRepository = { create, findById, revoke };
