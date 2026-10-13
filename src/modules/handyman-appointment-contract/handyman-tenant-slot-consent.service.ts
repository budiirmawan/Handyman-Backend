import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { resolveHandoffContext } from '../handyman-handoff/handoff-context.service';
import { recordOperationalEvent } from '../operational-events';
import {
  isTenantSlotAssertionFresh,
  parseTenantSlotChoiceAssertion,
  readTenantSlotSecret,
  sameInstant,
  verifyTenantSlotChoiceSignature,
  type TenantSlotChoiceAssertion,
} from './handyman-tenant-slot-assertion';
import {
  bindTenantSlotChoice,
  choiceConflict,
  findPendingTenantSlotChoice,
  mapTenantSlotWriteError,
  stateConflict,
} from './handyman-tenant-slot-binding.repository';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2A — verified tenant slot choice ingest.
 *
 * Server-to-server only. A verified BM assertion records REQUEST-level consent
 * for the tenant's own slot. It never confirms a booking and never creates a
 * session or capacity reservation.
 *
 * Ordering: structure → integration scope + secret → HMAC → freshness → tenant
 * context resolution → one transaction: lock request → bind identity to the
 * REQUEST (stored tenant company, building and PIC; the payload PIC is only a
 * claim checked against it) → replay check → live visits for kind → consent
 * insert → bind to a PROPOSED visit only when it matches the slot exactly, else
 * keep the choice pending for Operations to match. Any failure rolls back.
 */

export const HANDYMAN_VISIT_TENANT_SLOT_SELECTED = 'HANDYMAN_VISIT_TENANT_SLOT_SELECTED';
export const HANDYMAN_VISIT_TENANT_SLOT_RECORDED = 'HANDYMAN_VISIT_TENANT_SLOT_RECORDED';

export type TenantContextResolver = typeof resolveHandoffContext;
/** Injectable seams. Defaults resolve the live pool lazily at call time. */
export type TenantSlotConsentDeps = {
  resolveTenantContext: TenantContextResolver;
  db: Pick<Pool, 'query'>;
  transact: <T>(work: (tx: PoolClient) => Promise<T>) => Promise<T>;
};
export function defaultTenantSlotConsentDeps(): TenantSlotConsentDeps {
  return { resolveTenantContext: resolveHandoffContext, db: getPool(), transact: withTransaction };
}

/** Non-enumerating trust failure: every authentication/structure/binding failure collapses here. */
export function tenantSlotAssertionInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_INVALID,
    message: 'Invalid or expired tenant slot assertion.',
    statusCode: 401,
  });
}

const replayed = () => new AppError({
  code: ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_REPLAYED,
  message: 'Tenant slot assertion has already been used.', statusCode: 409,
});

type IntegrationRow = { id: string; integrationCode: string; status: string; scoped: boolean };
type RequestRow = {
  id: string; clientId: string; tenantCompanyId: string; buildingId: string; tenantPicId: string | null;
};
type LiveVisitRow = {
  id: string; state: string; version: number; startAt: Date; endAt: Date;
};

export function assertionFingerprint(assertion: TenantSlotChoiceAssertion): string {
  return createHash('sha256').update(stableJson(assertion), 'utf8').digest('hex');
}

export type AcceptedTenantSlotChoice = {
  consentId: string;
  handymanRequestId: string;
  kind: 'INSPECTION' | 'EXECUTION';
  selectedStartAt: string;
  selectedEndAt: string;
  /** true when the choice was bound to the PROPOSED visit that already had that exact slot. */
  bound: boolean;
  appointment: {id: string; state: 'TENANT_SELECTED'; version: number} | null;
  confirmedBooking: false;
};

/** Verify and record a BM-attested tenant slot choice. Never CONFIRMED. */
export async function acceptTenantSlotChoice(
  input: unknown,
  signature: string | undefined,
  deps: TenantSlotConsentDeps = defaultTenantSlotConsentDeps(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcceptedTenantSlotChoice> {
  const assertion = parseTenantSlotChoiceAssertion(input);
  if (!assertion) throw tenantSlotAssertionInvalidError();

  // 1) Trusted integration: ACTIVE, explicitly granted this purpose, secret deployed.
  const integration = (await deps.db.query<IntegrationRow>(
    `SELECT id, integration_code AS "integrationCode", status,
            tenant_slot_choice_scope AS scoped
       FROM handyman_handoff_integrations WHERE integration_code = $1`,
    [assertion.iss],
  )).rows[0];
  const secret = integration && integration.status === 'ACTIVE' && integration.scoped
    ? readTenantSlotSecret(integration.integrationCode, env) : null;
  if (!integration || secret === null) throw tenantSlotAssertionInvalidError();

  // 2) Timing-safe HMAC over the canonical payload, then freshness.
  if (!verifyTenantSlotChoiceSignature(assertion, signature, secret)) {
    throw tenantSlotAssertionInvalidError();
  }
  if (!isTenantSlotAssertionFresh(assertion)) throw tenantSlotAssertionInvalidError();

  // 3) Tenant context from the PART 02 resolver. Its PIC must equal the claim.
  //    The payload's claims are never the final authority; the request is checked below.
  const resolved = await deps.resolveTenantContext({
    tenantCompanyId: assertion.tenantCompanyId,
    buildingId: assertion.buildingId,
    tenantPicId: assertion.tenantPicId,
  });
  if (!resolved.tenantPicId || resolved.tenantPicId !== assertion.tenantPicId ||
      resolved.tenantCompanyId !== assertion.tenantCompanyId || resolved.buildingId !== assertion.buildingId) {
    throw tenantSlotAssertionInvalidError();
  }

  return deps.transact(async (tx: PoolClient) => {
    // 4) Lock the REQUEST first (same order as proposal and confirmation).
    //    Server-side binding: the stored request tenant company, building and PIC are
    //    authoritative. A payload that disagrees with the request is a trust failure.
    const request = (await tx.query<RequestRow>(
      `SELECT id, client_id AS "clientId", tenant_company_id AS "tenantCompanyId",
              building_id AS "buildingId", tenant_pic_id AS "tenantPicId"
         FROM handyman_service_requests WHERE id = $1 FOR UPDATE`,
      [assertion.handymanRequestId],
    )).rows[0];
    if (!request || request.tenantPicId === null || request.tenantPicId !== assertion.tenantPicId ||
        request.tenantCompanyId !== resolved.tenantCompanyId || request.buildingId !== resolved.buildingId ||
        request.clientId !== resolved.clientId) {
      throw tenantSlotAssertionInvalidError();
    }

    // 5) Replay: the same JTI or BM evidence id, under this integration, is refused
    //    before any visit state is read.
    const seen = await tx.query(
      `SELECT 1 FROM handyman_visit_tenant_slot_consents
        WHERE integration_id = $1 AND (assertion_jti = $2 OR bm_consent_evidence_id = $3) LIMIT 1`,
      [integration.id, assertion.jti, assertion.bmConsentEvidenceId],
    );
    if (seen.rowCount) throw replayed();

    // 6) Slot must not have already started.
    const selectedStart = new Date(assertion.selectedStartAt);
    const selectedEnd = new Date(assertion.selectedEndAt);
    if (selectedStart.getTime() <= Date.now()) {
      throw choiceConflict('The selected slot has already started and cannot be chosen.');
    }

    // 7) One pending choice per kind, and no selected/confirmed visit already for this kind.
    if (await findPendingTenantSlotChoice(tx, request.id, assertion.kind)) {
      throw choiceConflict('A tenant slot choice is already pending for this visit kind.');
    }
    const live = (await tx.query<LiveVisitRow>(
      `SELECT id, state, version, start_at AS "startAt", end_at AS "endAt"
         FROM handyman_visit_appointments
        WHERE handyman_request_id = $1 AND kind = $2
          AND state IN ('PROPOSED', 'TENANT_SELECTED', 'CONFIRMED', 'IN_PROGRESS')
        FOR UPDATE`,
      [request.id, assertion.kind],
    )).rows;
    if (live.some(visit => visit.state !== 'PROPOSED')) {
      throw stateConflict('A selected or confirmed visit already exists for this kind. Cancel it before a new slot choice.');
    }
    const proposal = live[0] ?? null;

    // 8) Append-only request-level consent.
    const consentId = randomUUID();
    try {
      await tx.query(
        `INSERT INTO handyman_visit_tenant_slot_consents
           (id, integration_id, assertion_jti, bm_consent_evidence_id, tenant_user_reference,
            assertion_hash, handyman_request_id, client_id, kind, tenant_company_id, building_id,
            tenant_pic_id, tenant_building_context_id, selected_start_at, selected_end_at, method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [consentId, integration.id, assertion.jti, assertion.bmConsentEvidenceId,
          assertion.tenantUserReference, assertionFingerprint(assertion), request.id, request.clientId,
          assertion.kind, request.tenantCompanyId, request.buildingId, assertion.tenantPicId,
          resolved.tenantBuildingContextId, assertion.selectedStartAt, assertion.selectedEndAt,
          assertion.method],
      );
    } catch (error) {
      mapTenantSlotWriteError(error, replayed);
    }

    // 9) Bind only to the PROPOSED visit that already has this exact slot.
    const matches = proposal !== null &&
      sameInstant(assertion.selectedStartAt, proposal.startAt) &&
      sameInstant(assertion.selectedEndAt, proposal.endAt);
    let appointment: AcceptedTenantSlotChoice['appointment'] = null;
    if (proposal && matches) {
      try {
        const bound = await bindTenantSlotChoice(tx, {
          consentId, appointmentId: proposal.id, clientId: request.clientId, requestId: request.id,
          kind: assertion.kind, appointmentVersion: proposal.version,
        });
        appointment = {id: bound.id, state: 'TENANT_SELECTED', version: bound.version};
      } catch (error) {
        mapTenantSlotWriteError(error, replayed);
      }
    }

    // 10) Audit in the same transaction. The BM integration is the source; no local actor.
    await recordOperationalEvent({
      clientId: request.clientId, buildingId: request.buildingId,
      eventType: appointment ? HANDYMAN_VISIT_TENANT_SLOT_SELECTED : HANDYMAN_VISIT_TENANT_SLOT_RECORDED,
      entityType: 'HANDYMAN_VISIT_TENANT_SLOT_CONSENT', entityId: consentId, actorUserId: null,
      summary: appointment
        ? 'Tenant slot choice verified from BM-attested assertion and bound to the PROPOSED visit (TENANT_SELECTED; not confirmed).'
        : 'Tenant slot choice verified from BM-attested assertion and recorded for Operations to match (not bound; not confirmed).',
      metadata: {
        consentId, integrationCode: integration.integrationCode, handymanRequestId: request.id,
        kind: assertion.kind, selectedStartAt: assertion.selectedStartAt, selectedEndAt: assertion.selectedEndAt,
        bmConsentEvidenceId: assertion.bmConsentEvidenceId, tenantPicId: assertion.tenantPicId,
        appointmentId: appointment?.id ?? null, bound: appointment !== null,
      },
    }, tx);

    return {
      consentId, handymanRequestId: request.id, kind: assertion.kind,
      selectedStartAt: assertion.selectedStartAt, selectedEndAt: assertion.selectedEndAt,
      bound: appointment !== null, appointment, confirmedBooking: false as const,
    };
  });
}
