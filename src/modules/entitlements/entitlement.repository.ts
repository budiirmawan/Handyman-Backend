import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  EntitlementRecord,
  EntitlementStatus,
  NewEntitlement,
} from './entitlement.types';

type EntitlementRow = {
  id: string;
  subscriptionId: string;
  moduleId: string;
  status: EntitlementStatus;
  startsAt: Date;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const ENTITLEMENT_SELECT = `
  id,
  subscription_id AS "subscriptionId",
  module_id AS "moduleId",
  status,
  starts_at AS "startsAt",
  ends_at AS "endsAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapEntitlementRow(row: EntitlementRow): EntitlementRecord {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    moduleId: row.moduleId,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createEntitlement(
  input: NewEntitlement,
): Promise<EntitlementRecord> {
  const result = await getPool().query<EntitlementRow>(
    `INSERT INTO module_entitlements
       (id, subscription_id, module_id, status, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ENTITLEMENT_SELECT}`,
    [
      randomUUID(),
      input.subscriptionId,
      input.moduleId,
      input.status,
      input.startsAt,
      input.endsAt,
    ],
  );

  return mapEntitlementRow(result.rows[0]);
}

async function findById(id: string): Promise<EntitlementRecord | null> {
  const result = await getPool().query<EntitlementRow>(
    `SELECT ${ENTITLEMENT_SELECT} FROM module_entitlements WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapEntitlementRow(row) : null;
}

async function findBySubscriptionId(
  subscriptionId: string,
): Promise<EntitlementRecord[]> {
  const result = await getPool().query<EntitlementRow>(
    `SELECT ${ENTITLEMENT_SELECT} FROM module_entitlements
     WHERE subscription_id = $1 ORDER BY starts_at DESC`,
    [subscriptionId],
  );

  return result.rows.map(mapEntitlementRow);
}

async function findBySubscriptionAndModule(
  subscriptionId: string,
  moduleId: string,
): Promise<EntitlementRecord | null> {
  const result = await getPool().query<EntitlementRow>(
    `SELECT ${ENTITLEMENT_SELECT} FROM module_entitlements
     WHERE subscription_id = $1 AND module_id = $2 AND status = 'ACTIVE'`,
    [subscriptionId, moduleId],
  );

  const row = result.rows[0];
  return row ? mapEntitlementRow(row) : null;
}

async function listEntitlements(): Promise<EntitlementRecord[]> {
  const result = await getPool().query<EntitlementRow>(
    `SELECT ${ENTITLEMENT_SELECT} FROM module_entitlements ORDER BY starts_at DESC`,
  );

  return result.rows.map(mapEntitlementRow);
}

async function updateStatus(
  id: string,
  status: EntitlementStatus,
): Promise<EntitlementRecord | null> {
  const result = await getPool().query<EntitlementRow>(
    `UPDATE module_entitlements SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ENTITLEMENT_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapEntitlementRow(row) : null;
}

export const entitlementRepository = {
  createEntitlement,
  findBySubscriptionAndModule,
  findBySubscriptionId,
  findById,
  listEntitlements,
  updateStatus,
};
