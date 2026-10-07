import { withTransaction } from '../../database';
import type { HandymanCareActorType } from '../handyman-care-actors/handyman-care-actor.types';
import {
  createChannelAttribution,
  type PublicHandymanChannelAttribution,
} from '../handyman-channel-attributions';
import { hashHandoffExchangeToken } from './handoff-runtime.crypto';
import { handoffExchangeInvalidError } from './handoff-runtime.errors';
import { handoffRuntimeRepository } from './handoff-runtime.repository';

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
 * - no standard user session is created, and no service request is created;
 *   attribution grants no financial or SaaS entitlement by itself.
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

export async function bindHandoffExchangeToChannelAttribution(
  exchangeToken: string,
): Promise<PublicHandymanChannelAttribution> {
  if (typeof exchangeToken !== 'string' || exchangeToken.length === 0) {
    throw handoffExchangeInvalidError();
  }
  const tokenHash = hashHandoffExchangeToken(exchangeToken);

  return withTransaction(async (client) => {
    // 1) Locate and validate the single-use exchange (expiry fail-closed).
    const exchange = await handoffRuntimeRepository.findExchangeByTokenHash(
      tokenHash,
      client,
    );
    if (
      !exchange ||
      exchange.status !== 'ACTIVE' ||
      exchange.expiresAt.getTime() <= Date.now()
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
    return createChannelAttribution({
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
  });
}

export const handoffBindingService = {
  bindHandoffExchangeToChannelAttribution,
};
