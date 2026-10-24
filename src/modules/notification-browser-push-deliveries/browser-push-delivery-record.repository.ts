import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  BrowserPushDeliveryRecord,
  NewBrowserPushDelivery,
} from './browser-push-delivery-record.types';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — per-subscription browser push
 * attempt evidence repository (S-6).
 *
 * Shaped after the native per-device attempt repository
 * (`notification-push-deliveries`), deliberately: the two tables serve the
 * same purpose for two transports, so they behave the same way.
 *
 * APPEND-ONLY. There is no update and no delete surface — a recorded attempt
 * is immutable evidence. Reads are recipient- or delivery-scoped; isolation
 * is inherited from the ledger row that produced the attempt and is never
 * re-derived from a subscription.
 *
 * SECRETS. The row references the subscription by id. The endpoint, the
 * subscriber's public key and the auth secret are NEVER copied here, so the
 * browser delivery audit trail cannot be used to reconstruct a credential.
 */

const SELECT_COLUMNS = `id,
  client_id AS "clientId",
  building_id AS "buildingId",
  recipient_user_id AS "recipientUserId",
  browser_subscription_id AS "browserSubscriptionId",
  device_id AS "deviceId",
  platform,
  template_key AS "templateKey",
  title,
  body,
  status,
  provider,
  provider_reference AS "providerReference",
  error_message AS "errorMessage",
  error_code AS "errorCode",
  sent_at AS "sentAt",
  delivery_id AS "deliveryId",
  created_at AS "createdAt"`;

async function create(
  input: NewBrowserPushDelivery,
): Promise<BrowserPushDeliveryRecord> {
  const result = await getPool().query<BrowserPushDeliveryRecord>(
    `INSERT INTO notification_browser_push_deliveries (
       id, client_id, building_id, recipient_user_id, browser_subscription_id,
       device_id, platform, template_key, title, body, status, provider,
       provider_reference, error_message, error_code, sent_at, delivery_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING ${SELECT_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId ?? null,
      input.recipientUserId,
      input.browserSubscriptionId,
      input.deviceId,
      input.platform ?? 'BROWSER',
      input.templateKey ?? null,
      input.title,
      input.body ?? null,
      input.status,
      input.provider,
      input.providerReference ?? null,
      input.errorMessage ?? null,
      input.errorCode ?? null,
      input.sentAt ?? null,
      input.deliveryId ?? null,
    ],
  );
  return result.rows[0];
}

/**
 * All per-subscription attempts recorded for ONE ledger row, oldest first.
 * This is the browser fan-out audit trail.
 */
async function listByDeliveryId(
  deliveryId: string,
): Promise<BrowserPushDeliveryRecord[]> {
  const result = await getPool().query<BrowserPushDeliveryRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_browser_push_deliveries
      WHERE delivery_id = $1
      ORDER BY created_at ASC, id ASC`,
    [deliveryId],
  );
  return result.rows;
}

/** Recipient-scoped history (ownership expressed in SQL). */
async function listByRecipient(
  recipientUserId: string,
): Promise<BrowserPushDeliveryRecord[]> {
  const result = await getPool().query<BrowserPushDeliveryRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_browser_push_deliveries
      WHERE recipient_user_id = $1
      ORDER BY created_at DESC, id DESC`,
    [recipientUserId],
  );
  return result.rows;
}

export const browserPushDeliveryRecordRepository = {
  create,
  listByDeliveryId,
  listByRecipient,
};
