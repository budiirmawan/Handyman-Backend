/**
 * CR-BE-INTEG-01 PART 02 — webhook endpoint registry types.
 *
 * A webhook endpoint is Client-scoped configuration (optional Building
 * narrowing) describing WHERE matching operational events will be delivered
 * once PART 03+ lands. The `signing_secret` is part of the persisted record
 * but NEVER part of `PublicIntegrationWebhookEndpoint` — the secret leaves
 * the module exactly once, on create/rotate responses.
 */

export const INTEGRATION_WEBHOOK_ENDPOINT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type IntegrationWebhookEndpointStatus =
  (typeof INTEGRATION_WEBHOOK_ENDPOINT_STATUSES)[number];

export function isIntegrationWebhookEndpointStatus(
  value: unknown,
): value is IntegrationWebhookEndpointStatus {
  return (
    typeof value === 'string' &&
    (INTEGRATION_WEBHOOK_ENDPOINT_STATUSES as readonly string[]).includes(value)
  );
}

/** Per-endpoint receiver timeout bounds (governance §3.1 / §6.3). */
export const INTEGRATION_WEBHOOK_TIMEOUT_MIN_MS = 1_000;
export const INTEGRATION_WEBHOOK_TIMEOUT_MAX_MS = 30_000;
export const INTEGRATION_WEBHOOK_TIMEOUT_DEFAULT_MS = 10_000;

/**
 * The SECRET-FREE persisted shape — the only shape normal read seams ever
 * produce (the repository projection excludes `signing_secret` entirely).
 */
export type IntegrationWebhookEndpointRecord = {
  id: string;
  clientId: string;
  buildingId: string | null;
  name: string;
  url: string;
  eventTypes: string[];
  status: IntegrationWebhookEndpointStatus;
  secretRotatedAt: Date | null;
  timeoutMs: number;
  createdAt: Date;
  updatedAt: Date;
};

/** API projection of an endpoint (never carries the secret). */
export type PublicIntegrationWebhookEndpoint = {
  id: string;
  clientId: string;
  buildingId: string | null;
  name: string;
  url: string;
  eventTypes: string[];
  status: IntegrationWebhookEndpointStatus;
  secretRotatedAt: string | null;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
};

/** Create response: the public shape plus the ONE-TIME secret disclosure. */
export type CreatedIntegrationWebhookEndpoint = PublicIntegrationWebhookEndpoint & {
  /** Returned exactly once — it can never be read back later. */
  signingSecret: string;
};

/** Validated creation input (service caller). */
export type CreateIntegrationWebhookEndpointInput = {
  clientId: string;
  buildingId?: string | null;
  name: string;
  url: string;
  eventTypes: string[];
  status?: IntegrationWebhookEndpointStatus;
  timeoutMs?: number;
};

/** Validated update input — the secret is deliberately unrepresentable. */
export type UpdateIntegrationWebhookEndpointInput = {
  name?: string;
  url?: string;
  eventTypes?: string[];
  status?: IntegrationWebhookEndpointStatus;
  timeoutMs?: number;
};

/** List filters (always intersected with the caller's Client scope). */
export type IntegrationWebhookEndpointFilters = {
  clientId?: string;
  status?: IntegrationWebhookEndpointStatus;
  eventType?: string;
};
