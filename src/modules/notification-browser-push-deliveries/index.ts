/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — per-subscription browser push
 * attempt evidence (S-6).
 *
 * The browser counterpart of `notification-push-deliveries` (the native
 * per-device evidence). Both live under the durable outbound delivery
 * family: the ledger row is the single unit of idempotency, retry and
 * history, and the attempt rows are the immutable evidence underneath it.
 */
export { browserPushDeliveryRecordRepository } from './browser-push-delivery-record.repository';
export {
  BROWSER_PUSH_DELIVERY_RECORD_STATUSES,
} from './browser-push-delivery-record.types';
export type {
  BrowserPushDeliveryRecord,
  BrowserPushDeliveryRecordStatus,
  NewBrowserPushDelivery,
} from './browser-push-delivery-record.types';
