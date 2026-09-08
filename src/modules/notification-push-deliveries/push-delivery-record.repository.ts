import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { NewPushDelivery, PushDeliveryRecord } from './push-delivery-record.types';

/**
 * CR-BE-PUSH-01 PART 03C — per-device push attempt evidence repository.
 *
 * GOVERNANCE: §10.2, §12.7. Shaped after the BE-26F email attempt repository
 * (`email-delivery.repository.ts`), deliberately: the two tables serve the
 * same purpose for different channels, so they behave the same way.
 *
 * APPEND-ONLY. There is no update and no delete surface — a recorded attempt
 * is immutable evidence. Reads are recipient- or delivery-scoped; isolation
 * is inherited from the ledger row that produced the attempt (§10.1) and is
 * never re-derived from a device or a token.
 *
 * TITLE/BODY BOUNDS. `0336` enforces title ≤ 200 and body ≤ 500 in the
 * database. The values written here come from the §9 payload builder, which
 * clamps far tighter (100/240), so the DB CHECK is a backstop, not the
 * primary bound. Clamping again here would silently mask a payload defect.
 */

const SELECT_COLUMNS = `id,
  client_id AS "clientId",
  building_id AS "buildingId",
  recipient_user_id AS "recipientUserId",
  push_token_id AS "pushTokenId",
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

async function create(input: NewPushDelivery): Promise<PushDeliveryRecord> {
  const result = await getPool().query<PushDeliveryRecord>(
    `INSERT INTO notification_push_deliveries (
       id, client_id, building_id, recipient_user_id, push_token_id,
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
      input.pushTokenId,
      input.deviceId,
      input.platform,
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
 * All per-device attempts recorded for ONE ledger row, oldest first. This is
 * the fan-out audit trail: it answers "this delivery says SENT — which of the
 * recipient's devices actually accepted it?".
 */
async function listByDeliveryId(deliveryId: string): Promise<PushDeliveryRecord[]> {
  const result = await getPool().query<PushDeliveryRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_push_deliveries
      WHERE delivery_id = $1
      ORDER BY created_at ASC, id ASC`,
    [deliveryId],
  );
  return result.rows;
}

/** Recipient-scoped history (ownership expressed in SQL, as in BE-26F). */
async function listByRecipient(recipientUserId: string): Promise<PushDeliveryRecord[]> {
  const result = await getPool().query<PushDeliveryRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_push_deliveries
      WHERE recipient_user_id = $1
      ORDER BY created_at DESC, id DESC`,
    [recipientUserId],
  );
  return result.rows;
}

export const pushDeliveryRecordRepository = {
  create,
  listByDeliveryId,
  listByRecipient,
};
