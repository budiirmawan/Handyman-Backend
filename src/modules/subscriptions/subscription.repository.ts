import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewSubscription,
  SubscriptionRecord,
  SubscriptionStatus,
} from './subscription.types';

type SubscriptionRow = {
  id: string;
  clientId: string;
  code: string;
  planCode: string;
  status: SubscriptionStatus;
  startsAt: Date;
  endsAt: Date | null;
  /** CR-BE-SAAS-01 (0364): bound SaaS package — nullable for legacy rows. */
  packageId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const SUBSCRIPTION_SELECT = `
  id,
  client_id AS "clientId",
  code,
  plan_code AS "planCode",
  status,
  starts_at AS "startsAt",
  ends_at AS "endsAt",
  package_id AS "packageId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapSubscriptionRow(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    code: row.code,
    planCode: row.planCode,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    packageId: row.packageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createSubscription(
  input: NewSubscription,
): Promise<SubscriptionRecord> {
  const result = await getPool().query<SubscriptionRow>(
    `INSERT INTO subscriptions
       (id, client_id, code, plan_code, status, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SUBSCRIPTION_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.planCode,
      input.status,
      input.startsAt,
      input.endsAt,
    ],
  );

  return mapSubscriptionRow(result.rows[0]);
}

async function findById(id: string): Promise<SubscriptionRecord | null> {
  const result = await getPool().query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_SELECT} FROM subscriptions WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapSubscriptionRow(row) : null;
}

async function findByCode(code: string): Promise<SubscriptionRecord | null> {
  const result = await getPool().query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_SELECT} FROM subscriptions WHERE code = $1`,
    [code],
  );

  const row = result.rows[0];
  return row ? mapSubscriptionRow(row) : null;
}

async function findByClientId(clientId: string): Promise<SubscriptionRecord[]> {
  const result = await getPool().query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_SELECT} FROM subscriptions
     WHERE client_id = $1 ORDER BY starts_at DESC`,
    [clientId],
  );

  return result.rows.map(mapSubscriptionRow);
}

async function listSubscriptions(): Promise<SubscriptionRecord[]> {
  const result = await getPool().query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_SELECT} FROM subscriptions ORDER BY starts_at DESC`,
  );

  return result.rows.map(mapSubscriptionRow);
}

async function updateStatus(
  id: string,
  status: SubscriptionStatus,
): Promise<SubscriptionRecord | null> {
  const result = await getPool().query<SubscriptionRow>(
    `UPDATE subscriptions SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${SUBSCRIPTION_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapSubscriptionRow(row) : null;
}

export const subscriptionRepository = {
  createSubscription,
  findByClientId,
  findByCode,
  findById,
  listSubscriptions,
  updateStatus,
};
