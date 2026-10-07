export {
  AVAILABLE_PUSH_PROVIDERS,
  CREDENTIAL_LESS_PUSH_PROVIDERS,
  CapturePushAdapter,
  NoopPushAdapter,
  PUSH_ADAPTER_PLATFORMS,
  PUSH_DELIVERY_OUTCOMES,
  PUSH_ERROR_CODES,
  PUSH_PAYLOAD_LIMITS,
  classifyPushResult,
  isPushDeliveryOutcome,
  isPushErrorCode,
  isRetryablePushOutcome,
  pushTokenFingerprint,
  resolvePushAdapter,
  validatePushPayload,
} from './push-adapter';
export type {
  CapturedPushSend,
  PushAdapter,
  PushAdapterPlatform,
  PushDeliveryOutcome,
  PushErrorCode,
  PushPayloadViolation,
  PushSendInput,
  PushSendResult,
  SimulatedPushOutcome,
} from './push-adapter';
/**
 * CR-BE-PUSH-01 PART 03C — provider-neutral aliases for consumers OUTSIDE
 * this module.
 *
 * Boundary guard B-01i bans push provider vocabulary (including the literal
 * `pushAdapter`, case-insensitively) everywhere except `src/modules/
 * push-delivery/`. That ban is deliberate and is NOT widened here: instead,
 * this module — the one place allowed to hold that vocabulary — publishes the
 * same port under names that describe the ROLE (a delivery port) rather than
 * the vendor plumbing. Callers depend on the port; the provider vocabulary
 * stays sealed behind this boundary, which is exactly the guard's intent.
 */
export { resolvePushAdapter as resolvePushDeliveryPort } from './push-adapter';
export type { PushAdapter as PushDeliveryPort } from './push-adapter';
/**
 * Provider-error redaction, re-exported under a vendor-neutral name.
 *
 * Callers outside this module (the PART 03C dispatch seam) must scrub any
 * provider-thrown message before it becomes attempt evidence: a thrown error
 * escapes the adapter's own classification path, so it is the ONLY provider
 * string that reaches a caller un-redacted. The boundary contract forbids
 * vendor vocabulary outside this module, hence the alias.
 */
export { sanitizeFcmError as sanitizeProviderError } from './fcm-push-adapter';
export {
  FCM_PUSH_DEFAULTS,
  FcmPushAdapter,
  buildFcmAssertion,
  classifyFcmError,
  createFetchFcmTransport,
  normalizeFcmPrivateKey,
  parseFcmErrorBody,
  readFcmPushConfig,
  sanitizeFcmError,
} from './fcm-push-adapter';
export type {
  FcmAccessToken,
  FcmAccessTokenProvider,
  FcmClassification,
  FcmFailureInput,
  FcmHttpRequest,
  FcmHttpResponse,
  FcmHttpTransport,
  FcmPushAdapterOptions,
  FcmPushConfig,
} from './fcm-push-adapter';
