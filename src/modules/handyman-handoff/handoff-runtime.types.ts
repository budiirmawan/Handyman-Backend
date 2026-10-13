import type {
  HandoffCareActorClaim,
  HandymanCareActorType,
} from '../handyman-care-actors/handyman-care-actor.types';

/**
 * CR-HM-01 PART 03 — Secure handoff runtime types (frozen D1/D2).
 *
 * D1: server-to-server signed assertion; credential scoped per BM
 * integration; short-lived; a valid assertion may create a one-time
 * exchange. D2: the exchange is a distinct short-lived single-use state —
 * NOT a standard user session, and no session is created here.
 */

export type HandoffAssertion = {
  /** Integration whose scoped credential signed this assertion. */
  integrationCode: string;
  /** Unique assertion identifier (replay key). */
  assertionId: string;
  /** ISO-8601 issue/expiry timestamps. */
  issuedAt: string;
  expiresAt: string;
  /** Canonical context claims to resolve server-side. */
  tenantCompanyId: string;
  buildingId: string;
  tenantPicId?: string;
  spaceId?: string;
  /**
   * CR-HM-01 AMENDMENT 01 PART 09 — optional attested Customer Care actor
   * block. When the key is ABSENT the assertion is exactly a legacy
   * tenant-origin handoff (canonical signing payload and behavior unchanged).
   * When present it is part of the signed payload, must resolve through the
   * PART 08 resolver, and is never silently downgraded to legacy semantics.
   */
  actor?: HandoffCareActorClaim;
};

export type HandoffIntegrationRecord = {
  id: string;
  integrationCode: string;
  displayName: string;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: Date;
  updatedAt: Date;
};

export type HandoffAssertionRecord = {
  id: string;
  integrationId: string;
  assertionId: string;
  assertionHash: string;
  expiresAt: Date;
  createdAt: Date;
};

/** Canonical context snapshot persisted with an exchange. */
export type HandoffExchangeContextSnapshot = Readonly<{
  clientId: string;
  tenantCompanyId: string;
  tenantPicId: string | null;
  buildingId: string;
  spaceId: string | null;
  tenantBuildingContextId: string;
  tenantSpaceRelationshipId: string | null;
  resolvedUserId: string | null;
  /**
   * PART 09 — server-derived Customer Care actor provenance (never caller
   * claims, never a user/PIC). All three are null for legacy handoffs.
   */
  actorType: HandymanCareActorType | null;
  careActorId: string | null;
  actorReference: string | null;
}>;

/**
 * PART 09 — the context half of an exchange: everything the PART 02 resolver
 * produces. Actor provenance is attested separately (PART 08) and is
 * deliberately NOT part of `ResolvedHandoffContext`.
 */
export type HandoffExchangeContextInput = Omit<
  HandoffExchangeContextSnapshot,
  'actorType' | 'careActorId' | 'actorReference'
>;

export type HandoffExchangeRecord = {
  purpose: 'HANDOFF' | 'CARE_CREATE';
  workspaceSessionId: string | null;
  carePropertyId: string | null;
  id: string;
  integrationId: string;
  handoffAssertionId: string;
  tokenHash: string;
  clientId: string;
  tenantCompanyId: string;
  tenantPicId: string | null;
  buildingId: string;
  spaceId: string | null;
  tenantBuildingContextId: string;
  tenantSpaceRelationshipId: string | null;
  resolvedUserId: string | null;
  actorType: HandymanCareActorType | null;
  careActorId: string | null;
  actorReference: string | null;
  status: 'ACTIVE' | 'USED';
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Result of accepting a signed assertion: the raw exchange token is returned
 * exactly once and is never persisted or logged in plaintext.
 */
export type AcceptedHandoff = Readonly<{
  exchangeId: string;
  exchangeToken: string;
  expiresAt: Date;
  context: HandoffExchangeContextSnapshot;
}>;

/** Result of consuming a single-use exchange. */
export type ConsumedHandoffExchange = Readonly<{
  exchangeId: string;
  context: HandoffExchangeContextSnapshot;
}>;
