import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { NotificationDeliveryEvent } from './notification-delivery.types';

/**
 * CR-BE-NOTIFY-PROV-01 PART 03 — shared delivery-event normalization.
 *
 * Extracted unchanged from the BE-26E in-app delivery service so the IN_APP
 * chain and the outbound intent chain validate and normalize an occurred
 * domain event identically: event-type code pattern, UUID checks, uppercase
 * event type, lowercase UUIDs, trimmed entity type.
 */

const EVENT_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

export type NormalizedDeliveryEvent = {
  eventType: string;
  clientId: string;
  entityType: string;
  entityId: string;
  buildingId: string | null;
  variables: Record<string, string | number>;
};

export function normalizeDeliveryEvent(
  event: NotificationDeliveryEvent,
): NormalizedDeliveryEvent {
  const details: { field: string; message: string }[] = [];

  if (typeof event.eventType !== 'string' || !EVENT_TYPE_PATTERN.test(event.eventType.trim())) {
    details.push({
      field: 'eventType',
      message: 'eventType must be a non-empty code (letters, digits, underscore).',
    });
  }
  if (typeof event.entityType !== 'string' || event.entityType.trim().length === 0) {
    details.push({
      field: 'entityType',
      message: 'entityType must be a non-empty string.',
    });
  }
  for (const field of ['clientId', 'entityId'] as const) {
    if (typeof event[field] !== 'string' || !isValidUuid(event[field])) {
      details.push({ field, message: `${field} must be a valid UUID.` });
    }
  }
  if (
    event.buildingId !== undefined &&
    event.buildingId !== null &&
    (typeof event.buildingId !== 'string' || !isValidUuid(event.buildingId))
  ) {
    details.push({ field: 'buildingId', message: 'buildingId must be a valid UUID.' });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    eventType: event.eventType.trim().toUpperCase(),
    clientId: event.clientId.trim().toLowerCase(),
    entityType: event.entityType.trim(),
    entityId: event.entityId.trim().toLowerCase(),
    buildingId:
      event.buildingId === undefined || event.buildingId === null
        ? null
        : (event.buildingId as string).trim().toLowerCase(),
    variables: event.variables ?? {},
  };
}
