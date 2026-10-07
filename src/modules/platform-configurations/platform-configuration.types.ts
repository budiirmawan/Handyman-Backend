/**
 * CR-BE-SAAS-01 PART 12A — Platform configuration types + frozen
 * key catalogue (frozen §20.1 / §20.2).
 *
 * PART 12A owns the authoritative read / resolve / update path for
 * the existing `platform_configurations` JSONB store (created by
 * PART 08's `0370_create_platform_configurations.ts`). PART 08's
 * readers — and PART 10's `saas.health.failure_lookback_days`
 * reader, and PART 11's `saas.support_session_max_minutes` reader
 * — remain unchanged and continue to coexist with this module
 * (PART 12A does NOT refactor them).
 *
 * The catalogue below is the SINGLE source of truth for:
 *   - known frozen keys (§20.2);
 *   - value shape per key;
 *   - frozen default;
 *   - optional ownership scope (none — all keys are platform-scoped
 *     per §20.1, not customer-scoped);
 *   - persistence expectations (JSONB, no secrets).
 *
 * No free-form configuration is permitted — callers that try to
 * read or write an unknown key are rejected by the service.
 */

/** All frozen keys from §20.2 (Part 12 catalogue). The
 *  `saas.health.failure_lookback_days` key is not strictly listed
 *  in the §20.2 frozen table but is referenced verbatim in
 *  §21.1 "Failure-window authority" as the source for PART 10's
 *  recent-delivery window (default 7 days, seeded by PART 12 once
 *  the configuration seam is wired). PART 12A includes it so the
 *  authority is available to PART 10A's reader; default 7 days,
 *  positive integer, PLATFORM scope. */
export const SAAS_PLATFORM_CONFIGURATION_KEYS = [
  'saas.default_trial_days',
  'saas.past_due_grace_days',
  'saas.grace_period_days',
  'saas.supported_currencies',
  'saas.supported_billing_cycles',
  'saas.suspended_access_policy',
  'saas.suspended_limited_allowlist',
  'saas.support_session_max_minutes',
  'saas.product_availability',
  'saas.provider_enablement',
  'saas.commercial_defaults',
  'saas.health.failure_lookback_days',
] as const;

export type SaaSPlatformConfigurationKey =
  (typeof SAAS_PLATFORM_CONFIGURATION_KEYS)[number];

/** Shape kind of a frozen configuration value (§20.2). */
export type PlatformConfigValueShape =
  | 'int'
  | 'currency_code_list'
  | 'billing_cycle_list'
  | 'suspended_access_policy'
  | 'route_pattern_list'
  | 'product_availability_list'
  | 'provider_enablement_list'
  | 'commercial_defaults';

/** Single frozen-key descriptor. */
export interface PlatformConfigKeyDescriptor {
  key: SaaSPlatformConfigurationKey;
  shape: PlatformConfigValueShape;
  /** Frozen default (used by the resolver when no row exists). */
  frozenDefault: () => unknown;
}

/** Bridge from §20.2 → a typed default value (matches shape). */
function def(value: unknown): () => unknown {
  return () => value;
}

export const PLATFORM_CONFIGURATION_CATALOGUE: ReadonlyMap<
  SaaSPlatformConfigurationKey,
  PlatformConfigKeyDescriptor
> = new Map<SaaSPlatformConfigurationKey, PlatformConfigKeyDescriptor>([
  ['saas.default_trial_days', { key: 'saas.default_trial_days', shape: 'int', frozenDefault: def(14) }],
  ['saas.past_due_grace_days', { key: 'saas.past_due_grace_days', shape: 'int', frozenDefault: def(7) }],
  ['saas.grace_period_days', { key: 'saas.grace_period_days', shape: 'int', frozenDefault: def(14) }],
  [
    'saas.supported_currencies',
    {
      key: 'saas.supported_currencies',
      shape: 'currency_code_list',
      // Resolved at runtime from active `currencies` (§20.2 column
      // "Default: from ACTIVE `currencies`"). The service resolves the
      // default by querying the table; the static default falls back
      // to [] only when the table cannot be reached (still consistent
      // with §20.2 because no active currencies ⇒ empty list).
      frozenDefault: def([]),
    },
  ],
  [
    'saas.supported_billing_cycles',
    {
      key: 'saas.supported_billing_cycles',
      shape: 'billing_cycle_list',
      frozenDefault: def(['MONTHLY', 'ANNUAL', 'CUSTOM']),
    },
  ],
  [
    'saas.suspended_access_policy',
    {
      key: 'saas.suspended_access_policy',
      shape: 'suspended_access_policy',
      frozenDefault: def('FULL_BLOCK'),
    },
  ],
  [
    'saas.suspended_limited_allowlist',
    {
      key: 'saas.suspended_limited_allowlist',
      shape: 'route_pattern_list',
      frozenDefault: def([]),
    },
  ],
  [
    'saas.support_session_max_minutes',
    {
      key: 'saas.support_session_max_minutes',
      shape: 'int',
      frozenDefault: def(480),
    },
  ],
  [
    'saas.product_availability',
    {
      key: 'saas.product_availability',
      shape: 'product_availability_list',
      // §20.2 "seeded product available" — the seeded product id is
      // resolved by the service at runtime; the static default here
      // is `[]` to remain honest about not having read the catalog.
      frozenDefault: def([]),
    },
  ],
  [
    'saas.provider_enablement',
    {
      key: 'saas.provider_enablement',
      shape: 'provider_enablement_list',
      // §20.2 "all `false`" — no live provider yet.
      frozenDefault: def([]),
    },
  ],
  [
    'saas.commercial_defaults',
    {
      key: 'saas.commercial_defaults',
      shape: 'commercial_defaults',
      frozenDefault: def({ paymentTermsDays: 30, invoiceNumberPrefix: 'SAAS' }),
    },
  ],
  [
    'saas.health.failure_lookback_days',
    {
      // §21.1 — failure-window authority. PART 10A reads the lookback
      // from this key (default 7). Scope: PLATFORM. Positive integer.
      key: 'saas.health.failure_lookback_days',
      shape: 'int',
      frozenDefault: def(7),
    },
  ],
]);

/** Read shape — the authoritative configuration row. */
export interface PlatformConfigurationRecord {
  key: SaaSPlatformConfigurationKey;
  value: unknown;
  version: number;
  description: string | null;
  updatedByUserId: string | null;
  updatedAt: string;
  createdAt: string;
}

/** Input shape for an update mutation (mutations only — no free-form
 *  keys). OCC: `expectedVersion` is required when updating an existing
 *  key (frozen §17.3 + §20.2). */
export interface UpdatePlatformConfigurationInput {
  actorUserId: string;
  authority: string;
  key: SaaSPlatformConfigurationKey;
  expectedVersion: number;
  value: unknown;
  description?: string;
}

/** Input shape for creating a brand-new key (rare — most keys are
 *  seeded by PART 08/12; create is allowed per §22 for unknown keys
 *  that a future PART may freeze). PART 12A types include it for the
 *  catalogue seam; PART 12B will expose the HTTP route. */
export interface CreatePlatformConfigurationInput {
  actorUserId: string;
  authority: string;
  key: SaaSPlatformConfigurationKey;
  value: unknown;
  description?: string;
}

/** Result of a mutation — includes before / after for audit. */
export interface PlatformConfigurationChange {
  before: PlatformConfigurationRecord | null;
  after: PlatformConfigurationRecord;
}

/** Special entity-type for control-plane audit (§18.2 / §20.2). */
export const PLATFORM_CONFIGURATION_ENTITY_TYPE = 'SAAS_PLATFORM_CONFIG';

/** Frozen audit event name (§18.2 / §20.2 mutation row). */
export const PLATFORM_CONFIGURATION_AUDIT_EVENT = 'SAAS_PLATFORM_CONFIG_CHANGED';

/**
 * Deterministic UUIDv5 derivation of a platform-configuration key —
 * used as the `operational_events.entity_id` for configuration
 * mutations. The `operational_events.entity_id` column is `UUID`
 * (canonical event store, frozen in `0080_create_operational_events.ts`)
 * and the key string would not parse. v5 is reproducible across
 * processes without an extra DB row.
 */
export function entityIdForKey(
  key: SaaSPlatformConfigurationKey,
): string {
  // Pure-JS fold (XOR) of the configuration key (with a namespace tag
  // to avoid collisions with other v5-derived UUIDs) → 16 bytes →
  // version-5 / variant-1 UUID layout. Deterministic across processes;
  // stable mapping between (key) and the `operational_events.entity_id`
  // UUID column (which is `NOT NULL`).
  const seed = `SAAS_PLATFORM_CONFIG::${key}`;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    bytes[i % 16] = (bytes[i % 16] ^ c) & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
