import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import type { HandymanCareActorType } from '../handyman-care-actors/handyman-care-actor.types';
import {
  createChannelAttribution,
  type PublicHandymanChannelAttribution,
} from '../handyman-channel-attributions';
import { isCurrentCareRepresentation } from './care-representation.service';
import { hashHandoffExchangeToken } from './handoff-runtime.crypto';
import { handoffExchangeInvalidError } from './handoff-runtime.errors';
import { handoffRuntimeRepository } from './handoff-runtime.repository';
import type { HandoffExchangeContextSnapshot } from './handoff-runtime.types';

/**
 * CR-HM-01 PART 04 — trusted exchange → channel attribution binding seam.
 *
 * A valid single-use handoff exchange is consumed atomically and its
 * snapshotted canonical context (PART 02) becomes the ONLY source of truth
 * for the immutable channel attribution (PART 01). Callers cannot supply
 * tenant/building/space/channel identifiers here: the function takes the
 * raw exchange token and nothing else.
 *
 * Guarantees:
 * - origin channel is always BM_SUPER_APP;
 * - originating BM integration + assertion reference provenance is preserved
 *   in the durable originReference (server-derived, never caller-supplied);
 * - exchange single-use semantics stay authoritative: consume happen first,
 *   inside the transaction, via the same race-safe conditional UPDATE;
 * - atomicity (existing withTransaction convention): if attribution creation
 *   fails, the WHOLE transaction rolls back — the exchange is never left
 *   consumed without its attribution;
 * - duplicate/retry: a rebound exchange fails closed at consume; the PART 01
 *   origin-reference conflict rules still apply for any direct re-creation;
 * - the existing standalone binding creates no standard user session or
 *   service request; PART 04 may compose this binding in its own atomic
 *   request-create transaction. Attribution grants no financial or SaaS
 *   entitlement by itself.
 *
 * PART 10 (AMENDMENT 01) — actor provenance:
 * - an attested Customer Care handoff records the actor columns
 *   (actor_type / care_actor_id / actor_reference) taken ONLY from the
 *   consumed snapshot, and records createdByUserId as null: the represented
 *   customer's linked user is never borrowed as the acting user;
 * - a legacy handoff (no actor) behaves exactly as before — actor columns
 *   null and createdByUserId still the resolved customer user;
 * - represented tenant/customer/building/space attribution is unchanged in
 *   both flows.
 */

/** Server-derived provenance: trusted chain integration + assertion key. */
function handoffOriginReference(
  integrationCode: string,
  assertionId: string,
): string {
  // integrationCode is DB-bounded (<= 64) and assertionId is bounded
  // (<= 128), so the derived reference always fits the 255-char limit.
  return `bm-handoff:${integrationCode}:${assertionId}`;
}

async function bindWithinTransaction(
  exchangeToken: string,
  client: PoolClient,
  careOnly: boolean,
): Promise<{
  attribution: PublicHandymanChannelAttribution;
  exchange: HandoffExchangeContextSnapshot;
}> {
  if (typeof exchangeToken !== 'string' || exchangeToken.length === 0) {
    throw handoffExchangeInvalidError();
  }
  const tokenHash = hashHandoffExchangeToken(exchangeToken);

  // 1) Locate and validate the single-use exchange (expiry fail-closed).
  const exchange = await handoffRuntimeRepository.findExchangeByTokenHash(
    tokenHash,
    client,
  );
  if (
    !exchange ||
    exchange.status !== 'ACTIVE' ||
    exchange.expiresAt.getTime() <= Date.now() ||
    (careOnly && (exchange.actorType !== 'CUSTOMER_CARE' ||
      !exchange.careActorId || !exchange.actorReference))
  ) {
    throw handoffExchangeInvalidError();
  }

  // 2) Atomic consume first: race-safe ACTIVE → USED under this tx; a
  //    concurrent consumer gets no row and fails closed.
  const consumed = await handoffRuntimeRepository.consumeExchange(
    exchange.id,
    client,
  );
  if (!consumed) throw handoffExchangeInvalidError();

  // PART 03: attested care authority is checked again at binding (grant
  // might have been revoked since acceptance). The existing exchange
  // snapshots the effective tenant-building and tenant-space relationship
  // IDs: reject turnover/replacement, rather than silently binding a new
  // occupant under an old assertion. A failure rolls back consumption.
  // No new check is imposed on the no-actor legacy path.
  if (consumed.actorType !== null &&
      !(await isCurrentCareRepresentation(consumed, client))) {
    throw handoffExchangeInvalidError();
  }

  // 3) Provenance from the trusted chain the exchange originated from.
  //    Both rows are required by FK integrity; absence is a server defect,
  //    which must roll back rather than produce an untraceable attribution.
  const integration = await handoffRuntimeRepository.findIntegrationById(
    consumed.integrationId,
    client,
  );
  const assertion = await handoffRuntimeRepository.findAssertionById(
    consumed.handoffAssertionId,
    client,
  );
  if (!integration || !assertion) {
    throw new Error('Handoff exchange provenance record is missing.');
  }

  // 4) PART 10 — attested Customer Care actor provenance, taken verbatim
  //    from the consumed snapshot (server-derived in PART 08/09). The
  //    storage coherence constraint guarantees all-or-nothing, but a
  //    half-populated snapshot is a server defect, so it must roll back
  //    rather than produce an untraceable attribution.
  let actorInput: {
    actorType: HandymanCareActorType;
    careActorId: string;
    actorReference: string;
  } | null = null;
  if (consumed.actorType !== null) {
    if (consumed.careActorId === null || consumed.actorReference === null) {
      throw new Error('Handoff exchange actor provenance is incomplete.');
    }
    actorInput = {
      actorType: consumed.actorType,
      careActorId: consumed.careActorId,
      actorReference: consumed.actorReference,
    };
  }

  // 5) Create the immutable attribution from the consumed snapshot only.
  //    PART 01 re-validates all references and derives tenant isolation
  //    itself; its conflict rules are preserved unchanged. Any failure here
  //    rolls back the exchange consumption with the transaction.
  //
  //    Represented context (tenant company/PIC, building, space) is always
  //    attributed unchanged. The acting identity differs by flow:
  //    - legacy handoff: the resolved customer user, exactly as before;
  //    - attested Customer Care handoff: the care actor only — the
  //      represented customer's linked user is deliberately NOT passed as
  //      `createdByUserId`, so it can never be recorded as the acting user.
  const attribution = await createChannelAttribution({
    tenantCompanyId: consumed.tenantCompanyId,
    buildingId: consumed.buildingId,
    ...(consumed.tenantPicId !== null
      ? { tenantPicId: consumed.tenantPicId }
      : {}),
    ...(consumed.spaceId !== null ? { spaceId: consumed.spaceId } : {}),
    originChannel: 'BM_SUPER_APP',
    originReference: handoffOriginReference(
      integration.integrationCode,
      assertion.assertionId,
    ),
    ...(actorInput !== null
      ? {
          actorType: actorInput.actorType,
          careActorId: actorInput.careActorId,
          actorReference: actorInput.actorReference,
        }
      : {}),
    ...(actorInput === null && consumed.resolvedUserId !== null
      ? { createdByUserId: consumed.resolvedUserId }
      : {}),
  }, client);
  return { attribution, exchange: consumed };
}

/** Existing one-time exchange → attribution path remains compatible. */
export async function bindHandoffExchangeToChannelAttribution(
  exchangeToken: string,
): Promise<PublicHandymanChannelAttribution> {
  return withTransaction(async (client) =>
    (await bindWithinTransaction(exchangeToken, client, false)).attribution);
}

/**
 * PART 04: care request intake consumes the SAME single-use exchange and
 * creates its attribution inside the request transaction. A bare attribution
 * UUID is never accepted as proof of an acting Customer Care identity.
 */
export function bindCareHandoffExchangeInTransaction(
  exchangeToken: string,
  client: PoolClient,
): Promise<{
  attribution: PublicHandymanChannelAttribution;
  exchange: HandoffExchangeContextSnapshot;
}> {
  return bindWithinTransaction(exchangeToken, client, true);
}

export const handoffBindingService = {
  bindHandoffExchangeToChannelAttribution,
};
