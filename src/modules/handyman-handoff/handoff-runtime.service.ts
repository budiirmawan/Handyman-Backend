import { logger } from '../../shared/logger';
import {
  parseHandoffCareActorClaim,
  resolveCareActorClaim,
} from '../handyman-care-actors/handyman-care-actor.resolver';
import { resolveHandoffContext } from './handoff-context.service';
import {
  handoffAssertionInvalidError,
  handoffAssertionReplayedError,
  handoffExchangeInvalidError,
} from './handoff-runtime.errors';
import {
  generateHandoffExchangeToken,
  hashHandoffAssertion,
  hashHandoffExchangeToken,
  verifyHandoffAssertionSignature,
} from './handoff-runtime.crypto';
import {
  readHandoffIntegrationSecret,
  readHandoffRuntimeConfig,
  type HandoffRuntimeConfig,
} from './handoff-runtime.config';
import { handoffRuntimeRepository } from './handoff-runtime.repository';
import type {
  AcceptedHandoff,
  ConsumedHandoffExchange,
  HandoffAssertion,
  HandoffExchangeContextSnapshot,
  HandoffExchangeRecord,
} from './handoff-runtime.types';

/**
 * CR-HM-01 PART 03 — secure handoff runtime (frozen D1/D2).
 *
 * Flow: signed BM assertion → authenticate trusted BM integration
 * (per-integration scoped secret from environment config, timing-safe
 * comparison) → reject invalid/expired/replayed assertions → PART 02
 * canonical context resolver → short-lived single-use exchange state.
 *
 * Guarantees: no plaintext secret storage/logging; assertion replay is
 * append-only-recorded; exchange token persisted hash-only and returned
 * once; the exchange is NOT a standard user session (none is created);
 * tenant-pics.userId is never fabricated; no channel attribution and no
 * service request is created here.
 *
 * PART 09 (AMENDMENT 01) adds ONE optional member to the signed assertion —
 * the Customer Care `actor` block. Its presence is decided by key presence:
 * absent ⇒ byte-identical legacy behavior (canonical payload, resolver and
 * exchange snapshot unchanged); present ⇒ the block is covered by the same
 * integration signature, MUST resolve through the PART 08 attested resolver,
 * and its server-derived provenance is carried into the exchange snapshot.
 * An actor-bearing assertion is never downgraded to legacy semantics.
 */

const ASSERTION_ID_MAX_LENGTH = 128;
const REFERENCE_MAX_LENGTH = 128;

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' && !Number.isNaN(Date.parse(value))
  );
}

function isOptionalReference(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value, REFERENCE_MAX_LENGTH);
}

/**
 * Structural validation of an assertion payload (untrusted input).
 *
 * PART 09: `actor` is optional. The check is on KEY PRESENCE — an absent
 * `actor` key is the legacy shape, while a present `actor` (including
 * `null`/`undefined` and any unknown member) must be a valid closed actor
 * block or the whole assertion is rejected. This is what makes "never
 * silently downgrade an actor-bearing assertion" true at the first gate.
 */
export function isHandoffAssertion(value: unknown): value is HandoffAssertion {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  const hasActor = Object.prototype.hasOwnProperty.call(a, 'actor');
  return (
    isNonEmptyString(a.integrationCode, 64) &&
    isNonEmptyString(a.assertionId, ASSERTION_ID_MAX_LENGTH) &&
    isIsoDate(a.issuedAt) &&
    isIsoDate(a.expiresAt) &&
    isNonEmptyString(a.tenantCompanyId, REFERENCE_MAX_LENGTH) &&
    isNonEmptyString(a.buildingId, REFERENCE_MAX_LENGTH) &&
    isOptionalReference(a.tenantPicId) &&
    isOptionalReference(a.spaceId) &&
    (!hasActor || parseHandoffCareActorClaim(a.actor) !== null)
  );
}

function toExchangeContextSnapshot(
  record: HandoffExchangeRecord,
): HandoffExchangeContextSnapshot {
  return {
    clientId: record.clientId,
    tenantCompanyId: record.tenantCompanyId,
    tenantPicId: record.tenantPicId,
    buildingId: record.buildingId,
    spaceId: record.spaceId,
    tenantBuildingContextId: record.tenantBuildingContextId,
    tenantSpaceRelationshipId: record.tenantSpaceRelationshipId,
    resolvedUserId: record.resolvedUserId,
    actorType: record.actorType,
    careActorId: record.careActorId,
    actorReference: record.actorReference,
  };
}

function assertAssertionFreshness(
  assertion: HandoffAssertion,
  config: HandoffRuntimeConfig,
): void {
  const issuedAtMs = Date.parse(assertion.issuedAt);
  const expiresAtMs = Date.parse(assertion.expiresAt);
  const now = Date.now();
  if (
    expiresAtMs <= now ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > config.assertionMaxAgeSeconds * 1000 ||
    issuedAtMs - now > config.clockSkewSeconds * 1000
  ) {
    throw handoffAssertionInvalidError();
  }
}

function isReplayUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate?.constraint === 'handyman_handoff_assertions_unique_per_integration'
  );
}

/**
 * Accept a signed BM handoff assertion. Returns the raw single-use exchange
 * token exactly once alongside the canonical resolved context.
 */
export async function acceptHandoffAssertion(
  assertionInput: unknown,
  signature: string | undefined,
  config: HandoffRuntimeConfig = readHandoffRuntimeConfig(),
): Promise<AcceptedHandoff> {
  if (!isHandoffAssertion(assertionInput)) {
    throw handoffAssertionInvalidError();
  }
  const assertion = assertionInput;

  // 1) Trusted BM integration + scoped credential (metadata only in DB;
  //    secret only in environment config — never stored/logged).
  const integration = await handoffRuntimeRepository
    .findIntegrationByCode(assertion.integrationCode);
  const secret = integration?.status === 'ACTIVE'
    ? readHandoffIntegrationSecret(assertion.integrationCode)
    : null;
  if (!integration || integration.status !== 'ACTIVE' || secret === null) {
    if (integration && secret === null) {
      logger.warn('Handoff integration has no configured credential scope', {
        operation: 'handoff.integration.unconfigured',
        resourceType: 'HANDOFF_INTEGRATION',
        resourceId: integration.integrationCode,
      });
    }
    throw handoffAssertionInvalidError();
  }

  // 2) Timing-safe signature + freshness window. The actor block, when
  //    present, is a member of the canonical payload and is therefore covered
  //    by this very signature — there is no separate, weaker actor channel.
  if (!verifyHandoffAssertionSignature(assertion, signature, secret)) {
    throw handoffAssertionInvalidError();
  }
  assertAssertionFreshness(assertion, config);

  // 2.5) PART 09 actor attestation. Key presence decides the mode; an
  //      actor-bearing assertion MUST resolve through the PART 08 resolver
  //      (integration ACTIVE + CUSTOMER_CARE capability + ACTIVE registry row
  //      of the same integration). Resolution failures propagate as the same
  //      non-enumerating 401 — there is deliberately NO fallback that would
  //      downgrade an actor-bearing assertion to legacy tenant-origin
  //      semantics, and no replay/append-only record is burned for it.
  const hasActorClaim = Object.prototype.hasOwnProperty.call(assertion, 'actor');
  const actorProvenance = hasActorClaim
    ? await resolveCareActorClaim({
        integrationCode: integration.integrationCode,
        actorClaim: assertion.actor,
      })
    : null;

  // 3) Replay protection: append-only acceptance record; one assertion id
  //    per integration, ever.
  let assertionRecord;
  try {
    assertionRecord = await handoffRuntimeRepository.insertAssertion({
      integrationId: integration.id,
      assertionId: assertion.assertionId,
      assertionHash: hashHandoffAssertion(assertion),
      expiresAt: new Date(Date.parse(assertion.expiresAt)),
    });
  } catch (error) {
    if (isReplayUniqueViolation(error)) throw handoffAssertionReplayedError();
    throw error;
  }

  // 4) Canonical server-side context resolution (PART 02) — resolver errors
  //    propagate unchanged (non-enumerating context semantics).
  const resolved = await resolveHandoffContext({
    tenantCompanyId: assertion.tenantCompanyId,
    buildingId: assertion.buildingId,
    ...(assertion.tenantPicId !== undefined
      ? { tenantPicId: assertion.tenantPicId }
      : {}),
    ...(assertion.spaceId !== undefined ? { spaceId: assertion.spaceId } : {}),
  });

  // 5) Short-lived one-time exchange (D2) — token hash-only at rest; TTL,
  //    opacity, single-use and replay semantics are unchanged by PART 09. The
  //    server-derived actor provenance travels in the exchange snapshot only
  //    (null for legacy handoffs); it is never returned as caller input and
  //    never minted into a token/session.
  const exchangeToken = generateHandoffExchangeToken();
  const expiresAt = new Date(Date.now() + config.exchangeTtlSeconds * 1000);
  const exchange = await handoffRuntimeRepository.createExchange({
    integrationId: integration.id,
    handoffAssertionId: assertionRecord.id,
    tokenHash: hashHandoffExchangeToken(exchangeToken),
    context: resolved,
    actor: actorProvenance,
    expiresAt,
  });

  return {
    exchangeId: exchange.id,
    exchangeToken,
    expiresAt: exchange.expiresAt,
    context: toExchangeContextSnapshot(exchange),
  };
}

/**
 * Consume a single-use exchange. Second use, expiry, or an unknown token
 * all fail closed; no standard user session is created or implied.
 */
export async function consumeHandoffExchange(
  exchangeToken: string,
): Promise<ConsumedHandoffExchange> {
  if (typeof exchangeToken !== 'string' || exchangeToken.length === 0) {
    throw handoffExchangeInvalidError();
  }
  const record = await handoffRuntimeRepository.findExchangeByTokenHash(
    hashHandoffExchangeToken(exchangeToken),
  );
  if (
    !record ||
    record.status !== 'ACTIVE' ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw handoffExchangeInvalidError();
  }
  const consumed = await handoffRuntimeRepository.consumeExchange(record.id);
  if (!consumed) throw handoffExchangeInvalidError();
  return {
    exchangeId: consumed.id,
    context: toExchangeContextSnapshot(consumed),
  };
}

export const handoffRuntimeService = {
  acceptHandoffAssertion,
  consumeHandoffExchange,
};
