import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewWhatsAppDelivery,
  WhatsAppDeliveryRecord,
} from './whatsapp-delivery.types';

/**
 * BE-26G — WhatsApp delivery repository.
 *
 * Append-only delivery attempts. Reads are recipient-scoped (ownership in
 * SQL). No update/delete surface: a delivery attempt is immutable once
 * recorded.
 */

const SELECT_COLUMNS = `id,
  client_id AS "clientId",
  recipient_user_id AS "recipientUserId",
  recipient_phone AS "recipientPhone",
  template_key AS "templateKey",
  message_body AS "messageBody",
  status,
  provider,
  provider_reference AS "providerReference",
  error_message AS "errorMessage",
  sent_at AS "sentAt",
  delivery_id AS "deliveryId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

async function create(input: NewWhatsAppDelivery): Promise<WhatsAppDeliveryRecord> {
  const result = await getPool().query<WhatsAppDeliveryRecord>(
    `INSERT INTO notification_whatsapp_deliveries (
       id, client_id, recipient_user_id, recipient_phone, template_key,
       message_body, status, provider, provider_reference, error_message,
       sent_at, delivery_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${SELECT_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.recipientUserId,
      input.recipientPhone,
      input.templateKey,
      input.messageBody,
      input.status,
      input.provider,
      input.providerReference,
      input.errorMessage,
      input.sentAt,
      input.deliveryId ?? null,
    ],
  );
  return result.rows[0];
}

async function findById(
  recipientUserId: string,
  id: string,
): Promise<WhatsAppDeliveryRecord | null> {
  const result = await getPool().query<WhatsAppDeliveryRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_whatsapp_deliveries
      WHERE id = $1 AND recipient_user_id = $2`,
    [id, recipientUserId],
  );
  return result.rows[0] ?? null;
}

async function listByRecipient(
  recipientUserId: string,
): Promise<WhatsAppDeliveryRecord[]> {
  const result = await getPool().query<WhatsAppDeliveryRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_whatsapp_deliveries
      WHERE recipient_user_id = $1
      ORDER BY created_at DESC, id DESC`,
    [recipientUserId],
  );
  return result.rows;
}

export const whatsappDeliveryRepository = {
  create,
  findById,
  listByRecipient,
};
