/**
 * CR-HM-01 PART 01 — Handyman Channel Attribution types.
 *
 * Backend-owned, append-only record of trusted channel attribution resolved
 * server-side for a Handyman customer/building/(unit) context and originating
 * channel. Immutable after creation; there is deliberately no update input
 * type. Channel Attribution != BM financial entitlement != SaaS entitlement,
 * and persisting attribution never grants building/unit authorization by
 * itself.
 */

export const HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_CHANNELS = [
  'BM_SUPER_APP',
] as const;
export type HandymanChannelAttributionOriginChannel =
  (typeof HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_CHANNELS)[number];

export function isHandymanChannelAttributionOriginChannel(
  value: unknown,
): value is HandymanChannelAttributionOriginChannel {
  return (
    typeof value === 'string' &&
    (HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_CHANNELS as readonly string[]).includes(value)
  );
}

export const HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_REFERENCE_MAX_LENGTH = 255;

export type HandymanChannelAttributionRecord = {
  id: string;
  /** Tenant-isolation root, derived server-side from the tenant company. */
  clientId: string;
  /** Handyman tenant/customer organization context. */
  tenantCompanyId: string;
  /** Customer person (Tenant PIC), when resolved; may be null. */
  tenantPicId: string | null;
  /** Building context. */
  buildingId: string;
  /** Unit/space context, when applicable. */
  spaceId: string | null;
  /** Originating channel (frozen-map NEW channel semantics, not IntakeChannel). */
  originChannel: HandymanChannelAttributionOriginChannel;
  /** Durable external origin reference, when present. */
  originReference: string | null;
  /** Optional human/server actor attribution (audit-compatible creation). */
  createdByUserId: string | null;
  createdAt: Date;
};

export type PublicHandymanChannelAttribution = Omit<
  HandymanChannelAttributionRecord,
  'createdAt'
> & {
  createdAt: string;
};

/**
 * Server-side creation input. Callers (later handoff/binding PARTs) must have
 * resolved every reference through backend authorities first; the service
 * re-validates and derives tenant isolation itself.
 */
export type CreateHandymanChannelAttributionInput = {
  tenantCompanyId: string;
  buildingId: string;
  originChannel: HandymanChannelAttributionOriginChannel;
  tenantPicId?: string;
  spaceId?: string;
  originReference?: string;
  createdByUserId?: string;
};

/** Fully-resolved data ready for persistence. */
export type NewHandymanChannelAttribution = {
  clientId: string;
  tenantCompanyId: string;
  tenantPicId: string | null;
  buildingId: string;
  spaceId: string | null;
  originChannel: HandymanChannelAttributionOriginChannel;
  originReference: string | null;
  createdByUserId: string | null;
};
