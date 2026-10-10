import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { HandymanRequestContactInput } from './handyman-service-request.types';

/**
 * W02 PART 03 — append-only reporter/contact snapshot persistence.
 * Written inside the same transaction as the request and its attribution, so
 * a rollback removes all three. Never read by C6 Customer Care projections.
 */

export type NewHandymanServiceRequestContact = {
  handymanRequestId: string;
  channelAttributionId: string;
  capturedByCareActorId: string;
  reporter: HandymanRequestContactInput;
  contactPerson: HandymanRequestContactInput | null;
};

export type HandymanServiceRequestContactRecord = {
  handymanRequestId: string;
  reporterName: string;
  reporterPhone: string | null;
  reporterEmail: string | null;
  contactPersonName: string | null;
  contactPersonPhone: string | null;
  contactPersonEmail: string | null;
  capturedAt: Date;
};

async function insert(
  executor: Pick<PoolClient, 'query'>,
  contact: NewHandymanServiceRequestContact,
): Promise<void> {
  await executor.query(
    `INSERT INTO handyman_service_request_contacts
       (id, handyman_request_id, channel_attribution_id, reporter_name,
        reporter_phone, reporter_email, contact_person_name,
        contact_person_phone, contact_person_email, captured_by_care_actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      contact.handymanRequestId,
      contact.channelAttributionId,
      contact.reporter.name,
      contact.reporter.phone ?? null,
      contact.reporter.email ?? null,
      contact.contactPerson?.name ?? null,
      contact.contactPerson?.phone ?? null,
      contact.contactPerson?.email ?? null,
      contact.capturedByCareActorId,
    ],
  );
}

export const handymanServiceRequestContactRepository = { insert };
