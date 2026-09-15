export { normalizeDeliveryEvent } from './notification-delivery-event';
export type { NormalizedDeliveryEvent } from './notification-delivery-event';
export {
  deliverInAppNotifications,
  notificationDeliveryService,
} from './notification-delivery.service';
export {
  OUTBOUND_DEFAULT_MAX_ATTEMPTS,
  OUTBOUND_DELIVERY_EVENT_TYPES,
  OUTBOUND_DELIVERY_QUEUED_EVENT_TYPE,
  OUTBOUND_DUE_RETRIEVAL_LIMIT,
  OUTBOUND_RETRY_BASE_MS,
  OUTBOUND_RETRY_CAP_MS,
  OUTBOUND_RETRY_JITTER_RATIO,
  computeOutboundRetryDelayMs,
  processDueOutboundDeliveries,
  processOutboundDelivery,
} from './outbound-delivery-execution.service';
export type {
  OutboundDeliveryAdapterOverrides,
  OutboundDeliveryDispatchResult,
  OutboundDeliveryExecutionOutcome,
  OutboundRetryDelayOptions,
} from './outbound-delivery-execution.service';
export { deliverOutboundNotifications } from './outbound-delivery-intent.service';
// CR-BE-PUSH-01 PART 03B — active-device fan-out resolution and the §9
// pointer-only payload builder. Resolution and payload construction only:
// no provider invocation, no token mutation, no route.
export {
  PUSH_FANOUT_EMPTY_REASONS,
  parsePushRecipientAddress,
  resolvePushFanoutPlan,
} from './outbound-push-fanout.service';
export type {
  PushFanoutEmptyReason,
  PushFanoutPlan,
  PushFanoutTarget,
} from './outbound-push-fanout.service';
export {
  PUSH_PAYLOAD_DATA_KEYS,
  buildPushPointerPayload,
} from './outbound-push-payload';
export type {
  BuildPushPointerPayloadOptions,
  PushPayloadDataKey,
  PushPointerPayload,
} from './outbound-push-payload';
// CR-BE-PUSH-01 PART 03C — provider invocation and per-device attempt
// evidence. This is the ONLY seam that talks to the PART 02 provider port;
// it records evidence for every device attempt, including invalid tokens,
// but performs no token-state mutation (that is a later PART).
export { executePushFanout } from './outbound-push-dispatch.service';
export type {
  ExecutePushFanoutOptions,
  PushFanoutAttempt,
  PushFanoutExecution,
} from './outbound-push-dispatch.service';
export type {
  InAppDeliveryEvent,
  InAppDeliveryResult,
  NotificationDeliveryEvent,
  OutboundDeliveryIntentResult,
} from './notification-delivery.types';
