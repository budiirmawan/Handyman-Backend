import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isIntegrationOutboxBlockedEventType } from '../integration-outbox';
import {
  INTEGRATION_WEBHOOK_TIMEOUT_MAX_MS,
  INTEGRATION_WEBHOOK_TIMEOUT_MIN_MS,
  isIntegrationWebhookEndpointStatus,
  type CreateIntegrationWebhookEndpointInput,
  type IntegrationWebhookEndpointFilters,
  type UpdateIntegrationWebhookEndpointInput,
} from './integration-webhook-endpoint.types';

/**
 * CR-BE-INTEG-01 PART 02 — endpoint configuration validation.
 *
 * Pure request-shape validation, including the write-time SSRF guard
 * (governance §3.1 / §13 R6): HTTPS only, no URL credentials, and rejection
 * of localhost / loopback / private / link-local / CGNAT / metadata-range IP
 * literals. DNS-rebinding at resolve time remains a recorded residual risk.
 *
 * Event-type subscriptions reuse the shared event-type code pattern and are
 * validated against the PART 01 recursion blocklist (defense in depth — the
 * enqueue seam blocks those families regardless).
 */

const EVENT_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const NAME_MAX_LENGTH = 200;
const URL_MAX_LENGTH = 2000;
const MAX_EVENT_TYPES = 100;

type Detail = { field: string; message: string };

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

/** Blocked IPv4 literals: loopback, private, link-local, CGNAT, reserved. */
function isBlockedIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) {
    return false;
  }
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    a >= 224 // multicast / reserved / broadcast
  );
}

/** Blocked IPv6 literals: loopback, unspecified, ULA, link-local, v4-mapped. */
function isBlockedIpv6(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!bare.includes(':')) {
    return false;
  }
  if (bare === '::' || bare === '::1') {
    return true;
  }
  if (bare.startsWith('fc') || bare.startsWith('fd') || bare.startsWith('fe8') ||
      bare.startsWith('fe9') || bare.startsWith('fea') || bare.startsWith('feb')) {
    return true;
  }
  // IPv4-mapped/compatible forms delegate to the IPv4 rules.
  const v4tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
  return v4tail !== null && isBlockedIpv4(v4tail[1]);
}

/** Validates one receiver URL; returns field errors (empty = acceptable). */
export function validateIntegrationWebhookUrl(value: string): Detail[] {
  if (value.length > URL_MAX_LENGTH) {
    return [{ field: 'url', message: `url must be at most ${URL_MAX_LENGTH} characters.` }];
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return [{ field: 'url', message: 'url must be a valid absolute URL.' }];
  }

  const details: Detail[] = [];
  if (parsed.protocol !== 'https:') {
    details.push({ field: 'url', message: 'url must use https.' });
  }
  if (parsed.username || parsed.password) {
    details.push({ field: 'url', message: 'url must not embed credentials.' });
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === '' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    isBlockedIpv4(hostname) ||
    isBlockedIpv6(hostname)
  ) {
    details.push({
      field: 'url',
      message: 'url must not target localhost, loopback, private, link-local, or metadata addresses.',
    });
  }

  return details;
}

/** Normalizes and validates the subscribed event-type list. */
function parseEventTypes(value: unknown, details: Detail[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    details.push({ field: 'eventTypes', message: 'eventTypes must be a non-empty array.' });
    return [];
  }
  if (value.length > MAX_EVENT_TYPES) {
    details.push({
      field: 'eventTypes',
      message: `eventTypes must contain at most ${MAX_EVENT_TYPES} entries.`,
    });
    return [];
  }

  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !EVENT_TYPE_PATTERN.test(entry.trim())) {
      details.push({
        field: 'eventTypes',
        message: 'Every event type must be a code (letters, digits, underscore).',
      });
      return [];
    }
    const code = entry.trim().toUpperCase();
    if (isIntegrationOutboxBlockedEventType(code)) {
      details.push({
        field: 'eventTypes',
        message: `${code} is an integration/delivery audit event and cannot be subscribed (recursion guard).`,
      });
      return [];
    }
    if (!normalized.includes(code)) {
      normalized.push(code);
    }
  }
  return normalized;
}

function parseName(value: unknown, details: Detail[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    details.push({ field: 'name', message: 'name must be a non-empty string.' });
    return '';
  }
  const name = value.trim();
  if (name.length > NAME_MAX_LENGTH) {
    details.push({
      field: 'name',
      message: `name must be at most ${NAME_MAX_LENGTH} characters.`,
    });
    return '';
  }
  return name;
}

function parseUrlField(value: unknown, details: Detail[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    details.push({ field: 'url', message: 'url must be a non-empty string.' });
    return '';
  }
  const url = value.trim();
  details.push(...validateIntegrationWebhookUrl(url));
  return url;
}

function parseTimeoutMs(value: unknown, details: Detail[]): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    details.push({ field: 'timeoutMs', message: 'timeoutMs must be an integer.' });
    return 0;
  }
  if (
    value < INTEGRATION_WEBHOOK_TIMEOUT_MIN_MS ||
    value > INTEGRATION_WEBHOOK_TIMEOUT_MAX_MS
  ) {
    details.push({
      field: 'timeoutMs',
      message: `timeoutMs must be between ${INTEGRATION_WEBHOOK_TIMEOUT_MIN_MS} and ${INTEGRATION_WEBHOOK_TIMEOUT_MAX_MS}.`,
    });
    return 0;
  }
  return value;
}

/** Rejects any attempt to write secret material through config bodies. */
function rejectSecretFields(body: Record<string, unknown>, details: Detail[]): void {
  for (const field of ['signingSecret', 'signing_secret', 'secret']) {
    if (field in body) {
      details.push({
        field,
        message: 'Signing secrets are server-generated; use the rotate-secret endpoint.',
      });
    }
  }
}

export function parseCreateIntegrationWebhookEndpointBody(
  body: unknown,
): CreateIntegrationWebhookEndpointInput {
  const raw = (body ?? {}) as Record<string, unknown>;
  const details: Detail[] = [];

  rejectSecretFields(raw, details);

  if (typeof raw.clientId !== 'string' || !isValidUuid(raw.clientId)) {
    details.push({ field: 'clientId', message: 'clientId must be a valid UUID.' });
  }
  let buildingId: string | null = null;
  if (raw.buildingId !== undefined && raw.buildingId !== null) {
    if (typeof raw.buildingId !== 'string' || !isValidUuid(raw.buildingId)) {
      details.push({ field: 'buildingId', message: 'buildingId must be a valid UUID.' });
    } else {
      buildingId = raw.buildingId.trim().toLowerCase();
    }
  }

  const name = parseName(raw.name, details);
  const url = parseUrlField(raw.url, details);
  const eventTypes = parseEventTypes(raw.eventTypes, details);

  let status: CreateIntegrationWebhookEndpointInput['status'];
  if (raw.status !== undefined) {
    if (!isIntegrationWebhookEndpointStatus(raw.status)) {
      details.push({ field: 'status', message: 'status must be ACTIVE or INACTIVE.' });
    } else {
      status = raw.status;
    }
  }

  let timeoutMs: number | undefined;
  if (raw.timeoutMs !== undefined) {
    timeoutMs = parseTimeoutMs(raw.timeoutMs, details);
  }

  if (details.length > 0) {
    fail(details);
  }

  return {
    clientId: (raw.clientId as string).trim().toLowerCase(),
    buildingId,
    name,
    url,
    eventTypes,
    status,
    timeoutMs,
  };
}

export function parseUpdateIntegrationWebhookEndpointBody(
  body: unknown,
): UpdateIntegrationWebhookEndpointInput {
  const raw = (body ?? {}) as Record<string, unknown>;
  const details: Detail[] = [];
  const input: UpdateIntegrationWebhookEndpointInput = {};

  rejectSecretFields(raw, details);
  for (const field of ['clientId', 'buildingId']) {
    if (field in raw) {
      details.push({ field, message: `${field} cannot be changed after creation.` });
    }
  }

  if (raw.name !== undefined) {
    input.name = parseName(raw.name, details);
  }
  if (raw.url !== undefined) {
    input.url = parseUrlField(raw.url, details);
  }
  if (raw.eventTypes !== undefined) {
    input.eventTypes = parseEventTypes(raw.eventTypes, details);
  }
  if (raw.status !== undefined) {
    if (!isIntegrationWebhookEndpointStatus(raw.status)) {
      details.push({ field: 'status', message: 'status must be ACTIVE or INACTIVE.' });
    } else {
      input.status = raw.status;
    }
  }
  if (raw.timeoutMs !== undefined) {
    input.timeoutMs = parseTimeoutMs(raw.timeoutMs, details);
  }

  if (details.length > 0) {
    fail(details);
  }
  if (Object.keys(input).length === 0) {
    fail([{ field: 'body', message: 'At least one updatable field is required.' }]);
  }
  return input;
}

export function parseIntegrationWebhookEndpointIdParam(value: string): string {
  if (!isValidUuid(value)) {
    fail([{ field: 'id', message: 'id must be a valid UUID.' }]);
  }
  return value.trim().toLowerCase();
}

export function parseIntegrationWebhookEndpointFilters(query: {
  clientId?: unknown;
  status?: unknown;
  eventType?: unknown;
}): IntegrationWebhookEndpointFilters {
  const details: Detail[] = [];
  const filters: IntegrationWebhookEndpointFilters = {};

  const one = (value: unknown) => (Array.isArray(value) ? value[0] : value);

  const clientId = one(query.clientId);
  if (clientId !== undefined) {
    if (typeof clientId !== 'string' || !isValidUuid(clientId)) {
      details.push({ field: 'clientId', message: 'clientId must be a valid UUID.' });
    } else {
      filters.clientId = clientId.trim().toLowerCase();
    }
  }
  const status = one(query.status);
  if (status !== undefined) {
    if (!isIntegrationWebhookEndpointStatus(status)) {
      details.push({ field: 'status', message: 'status must be ACTIVE or INACTIVE.' });
    } else {
      filters.status = status;
    }
  }
  const eventType = one(query.eventType);
  if (eventType !== undefined) {
    if (typeof eventType !== 'string' || !EVENT_TYPE_PATTERN.test(eventType.trim())) {
      details.push({
        field: 'eventType',
        message: 'eventType must be a code (letters, digits, underscore).',
      });
    } else {
      filters.eventType = eventType.trim().toUpperCase();
    }
  }

  if (details.length > 0) {
    fail(details);
  }
  return filters;
}
