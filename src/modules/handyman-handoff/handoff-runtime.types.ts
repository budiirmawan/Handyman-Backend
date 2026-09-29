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
}>;

export type HandoffExchangeRecord = {
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
