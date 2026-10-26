import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';

type Executor = Pick<PoolClient, 'query'>;
type BindingCode = 'HANDYMAN_BM_BINDING_INVALID' | 'HANDYMAN_BM_BINDING_NOT_FOUND' |
  'HANDYMAN_BM_BINDING_UNVERIFIED' | 'HANDYMAN_BM_BINDING_CONFLICT' |
  'HANDYMAN_BM_BINDING_NOT_EFFECTIVE';

function error(code: BindingCode, message: string, statusCode: number): AppError {
  return new AppError({ code: ERROR_CODES[code], message, statusCode });
}
const invalid = (field: string) => error('HANDYMAN_BM_BINDING_INVALID', `Invalid ${field}.`, 400);
const notFound = () => error('HANDYMAN_BM_BINDING_NOT_FOUND', 'BM identity or coverage not found in this Client.', 404);
const unverified = () => error('HANDYMAN_BM_BINDING_UNVERIFIED', 'A verified legal beneficiary is required before coverage begins.', 409);
const conflict = () => error('HANDYMAN_BM_BINDING_CONFLICT', 'BM identity or Building coverage conflicts with existing authority.', 409);
const notEffective = () => error('HANDYMAN_BM_BINDING_NOT_EFFECTIVE', 'No exact verified BM Building coverage is effective at this instant.', 409);

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) throw invalid(field);
  return value.toLowerCase();
}
function text(value: unknown, field: string, max: number): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw invalid(field);
  return result;
}
function instant(value: unknown, field: string): Date {
  // Never interpret a local date/time in the server timezone or let Date
  // normalize an impossible calendar day into a different coverage boundary.
  const match = typeof value === 'string' &&
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!match) throw invalid(field);
  const [, y, m, d, h, min, sec, , zoneHour, zoneMinute] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      Number(h) > 23 || Number(min) > 59 || Number(sec) > 59 ||
      (zoneHour !== undefined && (Number(zoneHour) > 23 || Number(zoneMinute) > 59))) throw invalid(field);
  const date = new Date(value as string);
  if (!Number.isFinite(date.getTime())) throw invalid(field);
  return date;
}
function dbError(err: unknown): never {
  if (err instanceof AppError) throw err;
  if (['23503', '23505', '23514', '23P01'].includes((err as { code?: string })?.code ?? '')) throw conflict();
  throw err;
}

export type BmBeneficiaryKind = 'CLIENT_ORGANIZATION' | 'BM_LEGAL_COUNTERPARTY';
export type BmLegalCounterparty = {
  id: string; clientId: string; legalName: string; registrationNumber: string;
  representedClientId: string | null; createdByUserId: string; createdAt: Date;
};
export type BmCounterpartyVerification = {
  id: string; counterpartyId: string; evidenceReference: string;
  verifiedByUserId: string; verifiedAt: Date;
};
export type BmBuildingCoverage = {
  id: string; clientId: string; buildingId: string; agreementVersionId: string;
  counterpartyId: string; verificationId: string; beneficiaryKind: BmBeneficiaryKind;
  beneficiaryDefinitionId: string | null; effectiveFrom: Date; effectiveTo: Date | null;
  originalEffectiveTo: Date | null; createdByUserId: string; createdAt: Date;
  closedAt: Date | null; closedByUserId: string | null; closureReason: string | null;
  cancelledAt: Date | null; cancelledByUserId: string | null; cancellationReason: string | null;
};
export type ResolvedBmBuildingCoverage = BmBuildingCoverage & {
  agreementId: string; agreementVersionNumber: number;
  agreementEffectiveFrom: Date; agreementEffectiveTo: Date | null;
  ruleId: string; termId: string; legalName: string; registrationNumber: string;
  representedClientId: string | null; verifiedAt: Date;
};

type Row = Record<string, any>;
function party(row: Row): BmLegalCounterparty {
  return { id: row.id, clientId: row.client_id, legalName: row.legal_name,
    registrationNumber: row.registration_number, representedClientId: row.represented_client_id,
    createdByUserId: row.created_by_user_id, createdAt: row.created_at };
}
function verification(row: Row): BmCounterpartyVerification {
  return { id: row.id, counterpartyId: row.counterparty_id, evidenceReference: row.evidence_reference,
    verifiedByUserId: row.verified_by_user_id, verifiedAt: row.verified_at };
}
function coverage(row: Row): BmBuildingCoverage {
  return { id: row.id, clientId: row.client_id, buildingId: row.building_id,
    agreementVersionId: row.agreement_version_id, counterpartyId: row.counterparty_id,
    verificationId: row.verification_id, beneficiaryKind: row.beneficiary_kind,
    beneficiaryDefinitionId: row.beneficiary_definition_id, effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to, originalEffectiveTo: row.original_effective_to,
    createdByUserId: row.created_by_user_id, createdAt: row.created_at,
    closedAt: row.closed_at, closedByUserId: row.closed_by_user_id, closureReason: row.closure_reason,
    cancelledAt: row.cancelled_at, cancelledByUserId: row.cancelled_by_user_id,
    cancellationReason: row.cancellation_reason };
}
const sameDate = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** Register a legal identity; registration alone never verifies it. */
export async function registerHandymanBmLegalCounterparty(actorUserId: string, input: {
  clientId: string; legalName: string; registrationNumber: string;
  representsClientOrganization: boolean; idempotencyKey: string;
}): Promise<{ counterparty: BmLegalCounterparty; replayed: boolean }> {
  const actor = uuid(actorUserId, 'actorUserId');
  const clientId = uuid(input.clientId, 'clientId');
  const legalName = text(input.legalName, 'legalName', 200);
  const registrationNumber = text(input.registrationNumber, 'registrationNumber', 120).toUpperCase();
  if (typeof input.representsClientOrganization !== 'boolean') throw invalid('representsClientOrganization');
  const represented = input.representsClientOrganization ? clientId : null;
  const key = text(input.idempotencyKey, 'idempotencyKey', 200);
  try {
    return await withTransaction(async tx => {
      const client = await tx.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [clientId]);
      if (!client.rowCount) throw notFound();
      const prior = await tx.query('SELECT * FROM handyman_bm_legal_counterparties WHERE idempotency_key = $1', [key]);
      if (prior.rowCount) {
        const r = prior.rows[0];
        if (r.client_id !== clientId || r.legal_name !== legalName || r.registration_number !== registrationNumber ||
            r.represented_client_id !== represented || r.created_by_user_id !== actor) throw conflict();
        return { counterparty: party(r), replayed: true };
      }
      const result = await tx.query(`INSERT INTO handyman_bm_legal_counterparties
        (id, client_id, legal_name, registration_number, represented_client_id, idempotency_key, created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), clientId, legalName, registrationNumber, represented, key, actor]);
      return { counterparty: party(result.rows[0]), replayed: false };
    });
  } catch (err) { return dbError(err); }
}

/** Explicit verification is an immutable decision, not a caller-supplied status. */
export async function verifyHandymanBmLegalCounterparty(actorUserId: string, input: {
  clientId: string; counterpartyId: string; evidenceReference: string;
}): Promise<{ verification: BmCounterpartyVerification; replayed: boolean }> {
  const actor = uuid(actorUserId, 'actorUserId');
  const clientId = uuid(input.clientId, 'clientId');
  const counterpartyId = uuid(input.counterpartyId, 'counterpartyId');
  const evidence = text(input.evidenceReference, 'evidenceReference', 500);
  try {
    return await withTransaction(async tx => {
      const parent = await tx.query(`SELECT id FROM handyman_bm_legal_counterparties
        WHERE id = $1 AND client_id = $2 FOR UPDATE`, [counterpartyId, clientId]);
      if (!parent.rowCount) throw notFound();
      const prior = await tx.query('SELECT * FROM handyman_bm_counterparty_verifications WHERE counterparty_id = $1', [counterpartyId]);
      if (prior.rowCount) {
        const r = prior.rows[0];
        if (r.evidence_reference !== evidence || r.verified_by_user_id !== actor) throw conflict();
        return { verification: verification(r), replayed: true };
      }
      const result = await tx.query(`INSERT INTO handyman_bm_counterparty_verifications
        (id, counterparty_id, evidence_reference, verified_by_user_id)
        VALUES ($1,$2,$3,$4) RETURNING *`, [randomUUID(), counterpartyId, evidence, actor]);
      return { verification: verification(result.rows[0]), replayed: false };
    });
  } catch (err) { return dbError(err); }
}

/** Coverage is explicit per Building and exact agreement version; no Client-wide fallback. */
export async function bindHandymanBmBuildingCoverage(actorUserId: string, input: {
  clientId: string; buildingId: string; agreementVersionId: string; counterpartyId: string;
  beneficiaryKind: BmBeneficiaryKind; beneficiaryDefinitionId?: string | null;
  effectiveFrom: string; effectiveTo?: string | null; idempotencyKey: string;
}): Promise<{ coverage: BmBuildingCoverage; replayed: boolean }> {
  const actor = uuid(actorUserId, 'actorUserId');
  const clientId = uuid(input.clientId, 'clientId');
  const buildingId = uuid(input.buildingId, 'buildingId');
  const versionId = uuid(input.agreementVersionId, 'agreementVersionId');
  const counterpartyId = uuid(input.counterpartyId, 'counterpartyId');
  const kind = input.beneficiaryKind;
  if (kind !== 'CLIENT_ORGANIZATION' && kind !== 'BM_LEGAL_COUNTERPARTY') throw invalid('beneficiaryKind');
  const beneficiaryId = input.beneficiaryDefinitionId == null ? null : uuid(input.beneficiaryDefinitionId, 'beneficiaryDefinitionId');
  if ((kind === 'CLIENT_ORGANIZATION') !== (beneficiaryId !== null)) throw invalid('beneficiaryDefinitionId');
  const from = instant(input.effectiveFrom, 'effectiveFrom');
  const to = input.effectiveTo == null ? null : instant(input.effectiveTo, 'effectiveTo');
  if (to && to <= from) throw invalid('effectiveTo');
  const key = text(input.idempotencyKey, 'idempotencyKey', 200);
  try {
    return await withTransaction(async tx => {
      // Serialize a retry on the same key even when both requests start before
      // either row exists; the exclusion constraint still handles other keys.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        ['handyman-bm-coverage', key]);
      const proof = await tx.query(`SELECT c.id, x.id AS verification_id, x.verified_at
        FROM handyman_bm_legal_counterparties c
        LEFT JOIN handyman_bm_counterparty_verifications x ON x.counterparty_id = c.id
        WHERE c.id = $1 AND c.client_id = $2`, [counterpartyId, clientId]);
      if (!proof.rowCount || !proof.rows[0].verification_id || proof.rows[0].verified_at > from) throw unverified();
      const prior = await tx.query('SELECT * FROM handyman_bm_building_coverages WHERE idempotency_key = $1', [key]);
      if (prior.rowCount) {
        const r = prior.rows[0];
        if (r.client_id !== clientId || r.building_id !== buildingId || r.agreement_version_id !== versionId ||
            r.counterparty_id !== counterpartyId || r.verification_id !== proof.rows[0].verification_id ||
            r.beneficiary_kind !== kind || r.beneficiary_definition_id !== beneficiaryId ||
            !sameDate(r.effective_from, from) || !sameDate(r.original_effective_to, to) ||
            r.created_by_user_id !== actor) throw conflict();
        return { coverage: coverage(r), replayed: true };
      }
      const result = await tx.query(`INSERT INTO handyman_bm_building_coverages
        (id, client_id, building_id, agreement_version_id, counterparty_id, verification_id,
         beneficiary_kind, beneficiary_definition_id, effective_from, original_effective_to,
         effective_to, idempotency_key, created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12) RETURNING *`,
      [randomUUID(), clientId, buildingId, versionId, counterpartyId, proof.rows[0].verification_id,
        kind, beneficiaryId, from, to, key, actor]);
      return { coverage: coverage(result.rows[0]), replayed: false };
    });
  } catch (err) { return dbError(err); }
}

/** Close only into the future; a future binding may instead be cancelled. */
export async function closeHandymanBmBuildingCoverage(actorUserId: string, input: {
  clientId: string; coverageId: string; effectiveTo: string; reason: string;
}): Promise<{ coverage: BmBuildingCoverage; replayed: boolean }> {
  const actor = uuid(actorUserId, 'actorUserId');
  const clientId = uuid(input.clientId, 'clientId');
  const coverageId = uuid(input.coverageId, 'coverageId');
  const to = instant(input.effectiveTo, 'effectiveTo');
  const reason = text(input.reason, 'reason', 500);
  try {
    return await withTransaction(async tx => {
      const existing = await tx.query(`SELECT * FROM handyman_bm_building_coverages
        WHERE id=$1 AND client_id=$2 FOR UPDATE`, [coverageId, clientId]);
      if (!existing.rowCount) throw notFound();
      const r = existing.rows[0];
      if (r.closed_at) {
        if (!sameDate(r.effective_to, to) || r.closed_by_user_id !== actor || r.closure_reason !== reason) throw conflict();
        return { coverage: coverage(r), replayed: true };
      }
      const result = await tx.query(`UPDATE handyman_bm_building_coverages
        SET effective_to=$3, closed_by_user_id=$4, closed_at=NOW(), closure_reason=$5
        WHERE id=$1 AND client_id=$2 RETURNING *`, [coverageId, clientId, to, actor, reason]);
      return { coverage: coverage(result.rows[0]), replayed: false };
    });
  } catch (err) { return dbError(err); }
}

export async function cancelHandymanBmBuildingCoverage(actorUserId: string, input: {
  clientId: string; coverageId: string; reason: string;
}): Promise<{ coverage: BmBuildingCoverage; replayed: boolean }> {
  const actor = uuid(actorUserId, 'actorUserId');
  const clientId = uuid(input.clientId, 'clientId');
  const coverageId = uuid(input.coverageId, 'coverageId');
  const reason = text(input.reason, 'reason', 500);
  try {
    return await withTransaction(async tx => {
      const existing = await tx.query(`SELECT * FROM handyman_bm_building_coverages
        WHERE id=$1 AND client_id=$2 FOR UPDATE`, [coverageId, clientId]);
      if (!existing.rowCount) throw notFound();
      const r = existing.rows[0];
      if (r.cancelled_at) {
        if (r.cancelled_by_user_id !== actor || r.cancellation_reason !== reason) throw conflict();
        return { coverage: coverage(r), replayed: true };
      }
      const result = await tx.query(`UPDATE handyman_bm_building_coverages
        SET cancelled_by_user_id=$3, cancelled_at=NOW(), cancellation_reason=$4
        WHERE id=$1 AND client_id=$2 RETURNING *`, [coverageId, clientId, actor, reason]);
      return { coverage: coverage(result.rows[0]), replayed: false };
    });
  } catch (err) { return dbError(err); }
}

/**
 * Read one verified, explicit coverage at a given instant. The exact existing
 * agreement version, DEFAULT BM rule and term are returned as anchors; no fee
 * is calculated and a different legal party is never presented as the Client.
 * Passing a transaction keeps the coverage/version rows locked until commit.
 */
export async function resolveHandymanBmBuildingCoverageAt(
  clientIdInput: string, buildingIdInput: string, asOf: string, executor: Executor = getPool(),
): Promise<ResolvedBmBuildingCoverage> {
  const clientId = uuid(clientIdInput, 'clientId');
  const buildingId = uuid(buildingIdInput, 'buildingId');
  const at = instant(asOf, 'asOf');
  const result = await executor.query(`SELECT c.*, v.agreement_id, v.version_number,
      v.effective_from AS agreement_effective_from, v.effective_to AS agreement_effective_to,
      r.id AS rule_id, t.id AS term_id, party.legal_name, party.registration_number,
      party.represented_client_id, x.verified_at
    FROM handyman_bm_building_coverages c
    JOIN buildings b ON b.id = c.building_id
    JOIN properties p ON p.id = b.property_id AND p.client_id = c.client_id
    JOIN handyman_bm_legal_counterparties party ON party.id = c.counterparty_id AND party.client_id = c.client_id
    JOIN handyman_bm_counterparty_verifications x ON x.id = c.verification_id AND x.counterparty_id = party.id
    JOIN handyman_commercial_agreement_versions v ON v.id = c.agreement_version_id
    JOIN handyman_commercial_agreements a ON a.id = v.agreement_id AND a.client_id = c.client_id
    JOIN handyman_bm_fee_rule_definitions r ON r.agreement_version_id = v.id AND r.mode='DEFAULT' AND r.basis='LABOR_ONLY'
    JOIN handyman_bm_fee_term_definitions t ON t.agreement_version_id = v.id AND t.term_kind='PERCENTAGE_OF_BASIS'
    WHERE c.client_id=$1 AND c.building_id=$2 AND c.cancelled_at IS NULL
      AND c.effective_from <= $3 AND (c.effective_to IS NULL OR $3 < c.effective_to)
      AND x.verified_at <= $3 AND v.status IN ('ACTIVE','SUPERSEDED')
      AND v.effective_from <= $3 AND (v.effective_to IS NULL OR $3 < v.effective_to)
    FOR SHARE OF c, v, b, p`, [clientId, buildingId, at]);
  if (result.rows.length !== 1) throw notEffective();
  const r = result.rows[0];
  return { ...coverage(r), agreementId: r.agreement_id, agreementVersionNumber: r.version_number,
    agreementEffectiveFrom: r.agreement_effective_from, agreementEffectiveTo: r.agreement_effective_to,
    ruleId: r.rule_id, termId: r.term_id, legalName: r.legal_name,
    registrationNumber: r.registration_number, representedClientId: r.represented_client_id,
    verifiedAt: r.verified_at };
}
