/**
 * CR-BE-PUSH-01 PART 03C — per-device push attempt evidence.
 *
 * Storage only. This module records what happened to each device; it never
 * sends, never schedules, and never mutates a device registration.
 */
export { pushDeliveryRecordRepository } from './push-delivery-record.repository';
export {
  PUSH_DELIVERY_RECORD_STATUSES,
  type NewPushDelivery,
  type PushDeliveryRecord,
  type PushDeliveryRecordStatus,
} from './push-delivery-record.types';
