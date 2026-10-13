import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Pool } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { resolveHandoffContext } from '../handyman-handoff/handoff-context.service';
import { recordOperationalEvent } from '../operational-events';
import { requestScope } from './handyman-visit-api.service';
import {
  isTenantSlotAssertionFresh,
  parseTenantSlotChoiceAssertion,
  readTenantSlotSecret,
  sameInstant,
  verifyTenantSlotChoiceSignature,
  type TenantSlotChoiceAssertion,
} from './handyman-tenant-slot-assertion';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2 — verified tenant slot choice ingest.
 *
 * Server-to-server only (no Bearer session, no Care/tenant session). A verified
 * BM assertion moves exactly one PROPOSED visit to TENANT_SELECTED by writing
 * append-only consent provenance and the state transition in ONE transaction.
 * It NEVER moves the visit to CONFIRMED, reserves capacity or creates a
 * session. Confirmation is a separate Operations transaction with its own
 * eligibility and capacity checks.
 *
 * Ordering: structure → integration scope + secret → HMAC → freshness →
 * tenant context (PART 02 resolver) → row-locked appointment match → one-time
 * consent insert (JTI, BM evidence id and one-per-appointment uniqueness) →
 * visit TENANT_SELECTED → audit. Any failure rolls the whole unit back, so a
 * rejected assertion consumes nothing.
 */

export const HANDYMAN_VISIT_TENANT_SLOT_SELECTED = 'HANDYMAN_VISIT_TENANT_SLOT_SELECTED';

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

/** Consent/choice conflicts (scope, slot, one-per-visit, guard). Stale state uses STATE_CONFLICT. */
const choiceConflict = (message: string) => new AppError({
  code: ERROR_CODES.HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT, message, statusCode: 409,
});
const stateConflict = (message: string) => new AppError({
  code: ERROR_CODES.HANDYMAN_VISIT_STATE_CONFLICT, message, statusCode: 409,
});

/** Non-enumerating trust failure: every authentication/structure failure collapses here. */
export function tenantSlotAssertionInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_INVALID,
    message: 'Invalid or expired tenant slot assertion.',
    statusCode: 401,
  });
}

type IntegrationRow = { id: string; integrationCode: string; status: string; scoped: boolean };
type AppointmentRow = {
  id: string; clientId: string; handymanRequestId: string; tenantCompanyId: string;
  buildingId: string; kind: 'INSPECTION' | 'EXECUTION'; state: string; version: number;
  startAt: Date; endAt: Date;
};

const replayed = () => new AppError({
  code: ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_REPLAYED,
  message: 'Tenant slot assertion has already been used.', statusCode: 409,
});

/** Map one-time-use violations by constraint name; everything else is rethrown. */
function mapConsentInsertError(error: unknown): never {
  const candidate = error as { code?: string; constraint?: string };
  if (candidate.code === '23505') {
    if (candidate.constraint === 'handyman_visit_consents_jti_unique' ||
        candidate.constraint === 'handyman_visit_consents_evidence_unique') throw replayed();
    if (candidate.constraint === 'handyman_visit_consents_one_per_appointment') {
      throw choiceConflict('This visit already has a verified tenant slot choice.');
    }
  }
  if (candidate.code === '23514') {
    throw choiceConflict('Tenant slot choice no longer matches the PROPOSED visit.');
  }
  throw error;
}

export function assertionFingerprint(assertion: TenantSlotChoiceAssertion): string {
  return createHash('sha256').update(stableJson(assertion), 'utf8').digest('hex');
}

export type AcceptedTenantSlotChoice = {
  consentId: string;
  appointmentId: string;
  handymanRequestId: string;
  state: 'TENANT_SELECTED';
  version: number;
  confirmedBooking: false;
};

/**
 * Verify and record a BM-attested tenant slot choice. Returns no token and
 * creates no session. The visit is TENANT_SELECTED only, never CONFIRMED.
 */
export async function acceptTenantSlotChoice(
  input: unknown,
  signature: string | undefined,
  deps: TenantSlotConsentDeps = defaultTenantSlotConsentDeps(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcceptedTenantSlotChoice> {
  const assertion = parseTenantSlotChoiceAssertion(input);
  if (!assertion) throw tenantSlotAssertionInvalidError();

  // 1) Trusted integration: ACTIVE, explicitly granted this purpose, secret deployed.
  const db = deps.db;
  const integration = (await db.query<IntegrationRow>(
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

  // 3) Tenant identity boundary: PART 02 resolver proves tenant company, active
  //    building relationship and ACTIVE tenant PIC. The resolved client is derived,
  //    never trusted from the payload. Resolution is read-only and precedes commit.
  const resolved = await deps.resolveTenantContext({
    tenantCompanyId: assertion.tenantCompanyId,
    buildingId: assertion.buildingId,
    tenantPicId: assertion.tenantPicId,
  });
  if (!resolved.tenantPicId || resolved.tenantPicId !== assertion.tenantPicId) {
    throw tenantSlotAssertionInvalidError();
  }

  return deps.transact(async (tx: PoolClient) => {
    // 4) Lock the request and the appointment before any state read.
    const request = await requestScope(tx, assertion.handymanRequestId, true);
    const appointment = (await tx.query<AppointmentRow>(
      `SELECT id, client_id AS "clientId", handyman_request_id AS "handymanRequestId",
              tenant_company_id AS "tenantCompanyId", building_id AS "buildingId", kind,
              state, version, start_at AS "startAt", end_at AS "endAt"
         FROM handyman_visit_appointments WHERE id = $1 FOR UPDATE`,
      [assertion.appointmentId],
    )).rows[0];
    if (!appointment || appointment.handymanRequestId !== request.id) {
      throw choiceConflict('Tenant slot choice does not match the requested visit.');
    }

    // 5) Exact client / tenant company / building / kind / version / slot binding.
    const scopeMatches = appointment.clientId === resolved.clientId &&
      appointment.tenantCompanyId === resolved.tenantCompanyId &&
      appointment.buildingId === resolved.buildingId &&
      appointment.kind === assertion.kind;
    if (!scopeMatches) throw choiceConflict('Tenant slot choice is outside the visit scope.');
    if (appointment.state !== 'PROPOSED' || appointment.version !== assertion.appointmentVersion) {
      throw stateConflict('Tenant slot choice refers to a stale or non-proposed visit version.');
    }
    if (!sameInstant(assertion.selectedStartAt, appointment.startAt) ||
        !sameInstant(assertion.selectedEndAt, appointment.endAt)) {
      throw choiceConflict('Tenant selected slot does not match the proposed slot.');
    }
    if (appointment.startAt.getTime() <= Date.now()) {
      throw choiceConflict('The proposed slot has already started and cannot be selected.');
    }

    // 6) Append-only consent provenance; one-time use enforced by unique constraints
    //    and the DB guard that the consent matches its PROPOSED appointment exactly.
    const consentId = randomUUID();
    try {
      await tx.query(
        `INSERT INTO handyman_visit_tenant_slot_consents
           (id, integration_id, assertion_jti, bm_consent_evidence_id, bm_user_reference,
            assertion_hash, client_id, handyman_request_id, appointment_id, appointment_version,
            kind, tenant_company_id, building_id, tenant_pic_id, tenant_building_context_id,
            selected_start_at, selected_end_at, method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [consentId, integration.id, assertion.jti, assertion.bmConsentEvidenceId,
          assertion.tenantUserReference, assertionFingerprint(assertion), appointment.clientId,
          appointment.handymanRequestId, appointment.id, appointment.version, appointment.kind,
          appointment.tenantCompanyId, appointment.buildingId, resolved.tenantPicId,
          resolved.tenantBuildingContextId, assertion.selectedStartAt, assertion.selectedEndAt,
          'BM_AUTHENTICATED_TENANT_SELECTION'],
      );
    } catch (error) {
      mapConsentInsertError(error);
    }

    // 7) Visit moves to TENANT_SELECTED only (never CONFIRMED) and references the consent.
    const moved = await tx.query(
      `UPDATE handyman_visit_appointments
          SET state = 'TENANT_SELECTED', tenant_choice_evidence_ref = $2,
              version = version + 1, updated_at = NOW()
        WHERE id = $1 AND version = $3 AND state = 'PROPOSED'`,
      [appointment.id, consentId, appointment.version],
    );
    if (moved.rowCount !== 1) throw stateConflict('Visit changed while recording the tenant slot choice.');

    // 8) Audit in the same transaction. No local actor: the BM integration is the source.
    await recordOperationalEvent({
      clientId: appointment.clientId, buildingId: appointment.buildingId,
      eventType: HANDYMAN_VISIT_TENANT_SLOT_SELECTED, entityType: 'HANDYMAN_VISIT_APPOINTMENT',
      entityId: appointment.id, actorUserId: null,
      summary: 'Tenant slot choice verified from BM-attested assertion; visit TENANT_SELECTED (not confirmed).',
      metadata: {
        consentId, integrationCode: integration.integrationCode, handymanRequestId: appointment.handymanRequestId,
        kind: appointment.kind, appointmentVersion: appointment.version, newVersion: appointment.version + 1,
        selectedStartAt: assertion.selectedStartAt, selectedEndAt: assertion.selectedEndAt,
        bmConsentEvidenceId: assertion.bmConsentEvidenceId, tenantPicId: resolved.tenantPicId,
      },
    }, tx);

    return {
      consentId, appointmentId: appointment.id, handymanRequestId: appointment.handymanRequestId,
      state: 'TENANT_SELECTED' as const, version: appointment.version + 1, confirmedBooking: false as const,
    };
  });
}
