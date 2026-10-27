import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError, canAccessClient } from '../context-access';
import { financialPermission } from '../handyman-customer-transactions/handyman-financial-integration-access';
import type {
  CaptureHandymanTaxIdentityInput, HandymanTaxIdentityOwner, HandymanTaxIdentitySnapshot,
  HandymanTaxIdentityView, IndividualResidency, PkpStatus, TaxIdentifierKind, TaxpayerKind,
} from './handyman-tax-identity.types';

type IdentityCode = 'HANDYMAN_TAX_IDENTITY_INVALID' | 'HANDYMAN_TAX_IDENTITY_NOT_FOUND' |
  'HANDYMAN_TAX_IDENTITY_UNVERIFIED' | 'HANDYMAN_TAX_IDENTITY_CONFLICT' |
  'HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE' | 'HANDYMAN_TAX_IDENTITY_UNKNOWN' |
  'HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED';
function error(code: IdentityCode, message: string, statusCode: number): AppError {
  return new AppError({ code: ERROR_CODES[code], message, statusCode });
}
const invalid = (field: string) => error('HANDYMAN_TAX_IDENTITY_INVALID', `Invalid ${field}.`, 400);
const notFound = () => error('HANDYMAN_TAX_IDENTITY_NOT_FOUND', 'Tax identity or its exact owner was not found in this Client.', 404);
const unverified = () => error('HANDYMAN_TAX_IDENTITY_UNVERIFIED', 'The exact BM legal beneficiary must be verified before the identity starts.', 409);
const conflict = () => error('HANDYMAN_TAX_IDENTITY_CONFLICT', 'Tax identity history, scope, version or effective window conflicts.', 409);
const notEffective = () => error('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE', 'No exact tax identity is effective at this instant.', 409);

function dbError(err: unknown): never {
  if (err instanceof AppError) throw err;
  if (['23503', '23505', '23514', '23P01', '40001', '40P01'].includes((err as { code?: string })?.code ?? ''))
    throw conflict();
  throw err;
}
function exactKeys(value: unknown, allowed: readonly string[], field: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) throw invalid(field);
}
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
  // Millisecond precision and an explicit timezone; do not normalize invalid
  // calendar days or interpret an unzoned value in the server's timezone.
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
  const result = new Date(value as string);
  if (!Number.isFinite(result.getTime())) throw invalid(field);
  return result;
}
function owner(value: HandymanTaxIdentityOwner): HandymanTaxIdentityOwner {
  exactKeys(value, ['kind', 'clientId', 'counterpartyId'], 'owner');
  const clientId = uuid(value.clientId, 'owner.clientId');
  if (value.kind === 'HANDYMAN_ISSUER') {
    if ('counterpartyId' in value) throw invalid('owner.counterpartyId');
    return { kind: value.kind, clientId };
  }
  if (value.kind === 'BM_BENEFICIARY')
    return { kind: value.kind, clientId, counterpartyId: uuid(value.counterpartyId, 'owner.counterpartyId') };
  throw invalid('owner.kind');
}
const ownerId = (value: HandymanTaxIdentityOwner) =>
  value.kind === 'HANDYMAN_ISSUER' ? value.clientId : value.counterpartyId;

function identifier(value: CaptureHandymanTaxIdentityInput['identifier'], kind: TaxpayerKind,
  residency: IndividualResidency | null): { kind: TaxIdentifierKind | null; value: string | null } {
  if (value === null) return { kind: null, value: null };
  exactKeys(value, ['kind', 'value'], 'identifier');
  const type = value.kind;
  let digits = typeof value.value === 'string' ? value.value.trim() : '';
  if (type === 'NPWP_15') {
    if (/^\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}$/.test(digits)) digits = digits.replace(/[.-]/g, '');
    if (!/^\d{15}$/.test(digits)) throw invalid('identifier');
  } else if (type === 'NPWP_16') {
    if (!(kind === 'LEGAL_ENTITY' || (kind === 'INDIVIDUAL' && residency === 'NON_RESIDENT')) ||
        !/^\d{16}$/.test(digits)) throw invalid('identifier');
  } else if (type === 'NIK_NPWP_16') {
    if (kind !== 'INDIVIDUAL' || residency !== 'RESIDENT' || !/^\d{16}$/.test(digits)) throw invalid('identifier');
  } else throw invalid('identifier.kind');
  if (/^0+$/.test(digits)) throw invalid('identifier');
  return { kind: type, value: digits };
}

type NormalizedCapture = {
  owner: HandymanTaxIdentityOwner; issuerProfileId: string | null; legalName: string;
  taxpayerKind: TaxpayerKind; individualResidency: IndividualResidency | null;
  identifierKind: TaxIdentifierKind | null; identifierValue: string | null;
  pkpStatus: PkpStatus; effectiveFrom: Date; effectiveTo: Date | null;
  evidenceSource: string; evidenceReference: string; expectedVersion: number | null; idempotencyKey: string;
};
function normalizeCapture(input: CaptureHandymanTaxIdentityInput): NormalizedCapture {
  exactKeys(input, ['owner', 'issuerProfileId', 'legalName', 'taxpayerKind', 'individualResidency', 'identifier', 'pkpStatus',
    'effectiveFrom', 'effectiveTo', 'evidenceSource', 'evidenceReference', 'expectedVersion', 'idempotencyKey'], 'input');
  const target = owner(input.owner);
  const issuerProfileId = target.kind === 'HANDYMAN_ISSUER'
    ? uuid(input.issuerProfileId, 'issuerProfileId') : null;
  if (target.kind === 'BM_BENEFICIARY' && input.issuerProfileId != null) throw invalid('issuerProfileId');
  if (!['UNKNOWN', 'LEGAL_ENTITY', 'INDIVIDUAL'].includes(input.taxpayerKind)) throw invalid('taxpayerKind');
  if (input.taxpayerKind === 'INDIVIDUAL') {
    if (!input.individualResidency || !['UNKNOWN', 'RESIDENT', 'NON_RESIDENT'].includes(input.individualResidency))
      throw invalid('individualResidency');
  } else if (input.individualResidency !== null) throw invalid('individualResidency');
  if (!['UNKNOWN', 'PKP', 'NON_PKP'].includes(input.pkpStatus)) throw invalid('pkpStatus');
  const taxId = identifier(input.identifier, input.taxpayerKind, input.individualResidency);
  if ((input.taxpayerKind === 'UNKNOWN' && input.pkpStatus !== 'UNKNOWN') ||
      (input.pkpStatus !== 'UNKNOWN' && taxId.value === null)) throw invalid('classification');
  const from = instant(input.effectiveFrom, 'effectiveFrom');
  const to = input.effectiveTo == null ? null : instant(input.effectiveTo, 'effectiveTo');
  if (to && to.getTime() <= from.getTime()) throw invalid('effectiveTo');
  if (input.expectedVersion !== null && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1))
    throw invalid('expectedVersion');
  return { owner: target, issuerProfileId, legalName: text(input.legalName, 'legalName', 200),
    taxpayerKind: input.taxpayerKind, individualResidency: input.individualResidency,
    identifierKind: taxId.kind, identifierValue: taxId.value,
    pkpStatus: input.pkpStatus, effectiveFrom: from, effectiveTo: to,
    evidenceSource: text(input.evidenceSource, 'evidenceSource', 200),
    evidenceReference: text(input.evidenceReference, 'evidenceReference', 500),
    expectedVersion: input.expectedVersion, idempotencyKey: text(input.idempotencyKey, 'idempotencyKey', 200) };
}

async function access(actor: string, clientId: string, permission: 'handyman.finance.manage' | 'handyman.finance.read'): Promise<void> {
  await financialPermission(actor, permission);
  if (!(await canAccessClient(actor, clientId))) throw buildingAccessDeniedError();
}

/** Lock the pre-existing subject, not a newly invented taxpayer entity. */
async function lockOwner(tx: PoolClient, target: HandymanTaxIdentityOwner): Promise<Record<string, any>> {
  if (target.kind === 'HANDYMAN_ISSUER') {
    const result = await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [target.clientId]);
    if (!result.rowCount) throw notFound();
    return result.rows[0];
  }
  const result = await tx.query(`SELECT p.id, p.legal_name, v.id AS verification_id, v.verified_at
    FROM handyman_bm_legal_counterparties p
    LEFT JOIN handyman_bm_counterparty_verifications v ON v.counterparty_id=p.id
    WHERE p.id=$1 AND p.client_id=$2 FOR UPDATE OF p`, [target.counterpartyId, target.clientId]);
  if (!result.rowCount) throw notFound();
  return result.rows[0];
}

const SELECT_VIEW = `SELECT p.*, w.effective_to AS window_to, i.superseded_at AS issuer_to,
  c.id AS closure_id, c.effective_to AS closure_to, c.reason AS closure_reason,
  c.created_by_user_id AS closure_created_by, c.created_at AS closure_created_at
  FROM handyman_tax_identity_profiles p JOIN handyman_tax_identity_windows w ON w.profile_id=p.id
  LEFT JOIN handyman_tax_identity_closures c ON c.profile_id=p.id
  LEFT JOIN handyman_document_issuer_profiles i ON i.id=p.issuer_profile_id`;
const iso = (value: Date | null): string | null => value ? value.toISOString() : null;
function view(row: Record<string, any>): HandymanTaxIdentityView {
  // Only immutable profile fields participate in the digest. In particular,
  // the later closure and its mutable window projection never change it.
  const snapshot: HandymanTaxIdentitySnapshot = Object.freeze({
    schema: 'HANDYMAN_TAX_IDENTITY_V1', id: row.id, clientId: row.client_id,
    ownerKind: row.owner_kind, ownerId: row.owner_id, issuerProfileId: row.issuer_profile_id,
    counterpartyId: row.counterparty_id, verificationId: row.verification_id,
    version: row.version, legalName: row.legal_name, taxpayerKind: row.taxpayer_kind,
    individualResidency: row.individual_residency, identifierKind: row.identifier_kind, identifierValue: row.identifier_value,
    pkpStatus: row.pkp_status, approvalStatus: row.approval_status,
    effectiveFrom: row.effective_from.toISOString(), declaredEffectiveTo: iso(row.declared_effective_to),
    evidenceSource: row.evidence_source, evidenceReference: row.evidence_reference,
    createdByUserId: row.created_by_user_id, createdAt: row.created_at.toISOString(),
  });
  const closure = row.closure_id ? Object.freeze({ id: row.closure_id,
    kind: row.closure_to.getTime() === row.effective_from.getTime() ? 'CANCELLED_BEFORE_START' as const : 'CLOSED' as const,
    effectiveTo: row.closure_to.toISOString(), reason: row.closure_reason,
    createdByUserId: row.closure_created_by, createdAt: row.closure_created_at.toISOString() }) : null;
  const reason = snapshot.taxpayerKind === 'UNKNOWN' ? 'TAXPAYER_KIND_UNKNOWN' :
    snapshot.individualResidency === 'UNKNOWN' ? 'INDIVIDUAL_RESIDENCY_UNKNOWN' :
    snapshot.pkpStatus === 'UNKNOWN' ? 'PKP_STATUS_UNKNOWN' : 'APPROVAL_REQUIRED';
  return Object.freeze({ snapshot, digestAlgorithm: 'SHA-256',
    digest: createHash('sha256').update(stableJson(snapshot), 'utf8').digest('hex'),
    effectiveWindow: Object.freeze({ from: snapshot.effectiveFrom,
      to: iso(row.issuer_to && (!row.window_to || row.issuer_to < row.window_to) ? row.issuer_to : row.window_to),
      identityWindowTo: iso(row.window_to), issuerProfileSupersededAt: iso(row.issuer_to), closure }),
    taxUse: Object.freeze({ allowed: false, reason }) });
}
async function byId(tx: PoolClient, id: string): Promise<HandymanTaxIdentityView> {
  const result = await tx.query(`${SELECT_VIEW} WHERE p.id=$1`, [id]);
  if (!result.rowCount) throw notFound();
  return view(result.rows[0]);
}
function sameCapture(row: Record<string, any>, n: NormalizedCapture, actor: string): boolean {
  return row.client_id === n.owner.clientId && row.owner_kind === n.owner.kind && row.owner_id === ownerId(n.owner) &&
    row.issuer_profile_id === n.issuerProfileId && row.legal_name === n.legalName &&
    row.taxpayer_kind === n.taxpayerKind && row.individual_residency === n.individualResidency &&
    row.identifier_kind === n.identifierKind &&
    row.identifier_value === n.identifierValue && row.pkp_status === n.pkpStatus &&
    row.effective_from.getTime() === n.effectiveFrom.getTime() &&
    (row.declared_effective_to?.getTime() ?? null) === (n.effectiveTo?.getTime() ?? null) &&
    row.evidence_source === n.evidenceSource && row.evidence_reference === n.evidenceReference &&
    row.created_by_user_id === actor && (row.version === 1 ? null : row.version - 1) === n.expectedVersion;
}

/** Capture an explicitly UNAPPROVED assertion. No commercial permission is tax approval. */
export async function captureHandymanTaxIdentity(actorInput: string, input: CaptureHandymanTaxIdentityInput):
Promise<{ identity: HandymanTaxIdentityView; replayed: boolean }> {
  const actor = uuid(actorInput, 'actorUserId');
  const n = normalizeCapture(input);
  await access(actor, n.owner.clientId, 'handyman.finance.manage');
  try {
    return await withTransaction(async tx => {
      // Globally serialize a reused key, including when callers name different owners.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('hm-tax-identity-key'), hashtext($1))", [n.idempotencyKey]);
      const parent = await lockOwner(tx, n.owner);
      const prior = await tx.query('SELECT * FROM handyman_tax_identity_profiles WHERE idempotency_key=$1', [n.idempotencyKey]);
      if (prior.rowCount) {
        if (!sameCapture(prior.rows[0], n, actor)) throw conflict();
        return { identity: await byId(tx, prior.rows[0].id), replayed: true };
      }
      let verificationId: string | null = null;
      if (n.owner.kind === 'HANDYMAN_ISSUER') {
        const anchor = await tx.query(`SELECT legal_name, effective_from, superseded_at, status
          FROM handyman_document_issuer_profiles WHERE id=$1 AND client_id=$2 FOR SHARE`,
        [n.issuerProfileId, n.owner.clientId]);
        if (!anchor.rowCount) throw notFound();
        const row = anchor.rows[0];
        if (row.legal_name !== n.legalName || n.effectiveFrom < row.effective_from ||
            (row.status === 'SUPERSEDED' && !row.superseded_at) ||
            (row.superseded_at && (n.effectiveFrom >= row.superseded_at || !n.effectiveTo || n.effectiveTo > row.superseded_at)))
          throw conflict();
      } else {
        if (!parent.verification_id || !parent.verified_at || n.effectiveFrom < parent.verified_at) throw unverified();
        if (parent.legal_name !== n.legalName) throw conflict();
        verificationId = parent.verification_id;
      }
      const count = await tx.query(`SELECT COALESCE(MAX(version), 0)::int AS version FROM handyman_tax_identity_profiles
        WHERE owner_kind=$1 AND owner_id=$2`, [n.owner.kind, ownerId(n.owner)]);
      const current = count.rows[0].version as number;
      if ((current || null) !== n.expectedVersion) throw conflict();
      const newId = randomUUID();
      await tx.query(`INSERT INTO handyman_tax_identity_profiles
        (id,client_id,owner_kind,owner_id,issuer_profile_id,counterparty_id,verification_id,version,legal_name,
         taxpayer_kind,individual_residency,identifier_kind,identifier_value,pkp_status,effective_from,declared_effective_to,
         evidence_source,evidence_reference,idempotency_key,created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [newId, n.owner.clientId, n.owner.kind, ownerId(n.owner), n.issuerProfileId,
        n.owner.kind === 'BM_BENEFICIARY' ? n.owner.counterpartyId : null, verificationId, current + 1,
        n.legalName, n.taxpayerKind, n.individualResidency, n.identifierKind, n.identifierValue, n.pkpStatus,
        n.effectiveFrom, n.effectiveTo, n.evidenceSource, n.evidenceReference, n.idempotencyKey, actor]);
      return { identity: await byId(tx, newId), replayed: false };
    });
  } catch (err) { return dbError(err); }
}

/** Append a prospective closure, or use effectiveTo=effectiveFrom to cancel before start. */
export async function closeHandymanTaxIdentity(actorInput: string, input: {
  owner: HandymanTaxIdentityOwner; profileId: string; effectiveTo: string; reason: string;
}): Promise<{ identity: HandymanTaxIdentityView; replayed: boolean }> {
  exactKeys(input, ['owner', 'profileId', 'effectiveTo', 'reason'], 'input');
  const actor = uuid(actorInput, 'actorUserId'), target = owner(input.owner);
  const profileId = uuid(input.profileId, 'profileId'), to = instant(input.effectiveTo, 'effectiveTo');
  const reason = text(input.reason, 'reason', 500);
  await access(actor, target.clientId, 'handyman.finance.manage');
  try {
    return await withTransaction(async tx => {
      await lockOwner(tx, target);
      const current = await tx.query(`${SELECT_VIEW}
        WHERE p.id=$1 AND p.client_id=$2 AND p.owner_kind=$3 AND p.owner_id=$4 FOR UPDATE OF w`,
      [profileId, target.clientId, target.kind, ownerId(target)]);
      if (!current.rowCount) throw notFound();
      const row = current.rows[0];
      if (row.closure_id) {
        if (row.closure_to.getTime() !== to.getTime() || row.closure_reason !== reason || row.closure_created_by !== actor)
          throw conflict();
        return { identity: view(row), replayed: true };
      }
      await tx.query(`INSERT INTO handyman_tax_identity_closures
        (id,profile_id,effective_to,reason,created_by_user_id) VALUES($1,$2,$3,$4,$5)`,
      [randomUUID(), profileId, to, reason, actor]);
      return { identity: await byId(tx, profileId), replayed: false };
    });
  } catch (err) { return dbError(err); }
}

/** Read bounded immutable versions, including closed or cancelled assertions. */
export async function listHandymanTaxIdentityHistory(actorInput: string, targetInput: HandymanTaxIdentityOwner,
  options: { beforeVersion?: number | null; limit?: number } = {}): Promise<Readonly<{
    identities: readonly HandymanTaxIdentityView[]; nextBeforeVersion: number | null;
  }>> {
  exactKeys(options, ['beforeVersion', 'limit'], 'options');
  const actor = uuid(actorInput, 'actorUserId'), target = owner(targetInput);
  const before = options.beforeVersion ?? null, limit = options.limit ?? 20;
  if ((before !== null && (!Number.isSafeInteger(before) || before < 1 || before > 2_147_483_647)) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('history pagination');
  await access(actor, target.clientId, 'handyman.finance.read');
  const result = await getPool().query(`${SELECT_VIEW}
    WHERE p.client_id=$1 AND p.owner_kind=$2 AND p.owner_id=$3
      AND ($4::int IS NULL OR p.version < $4)
    ORDER BY p.version DESC LIMIT $5`, [target.clientId, target.kind, ownerId(target), before, limit + 1]);
  const records = result.rows.slice(0, limit).map(view);
  return Object.freeze({ identities: Object.freeze(records),
    nextBeforeVersion: result.rows.length > limit ? records[records.length - 1].snapshot.version : null });
}

/** Read one exact, half-open historical identity; there is no owner or legacy fallback. */
export async function resolveHandymanTaxIdentityAt(actorInput: string, targetInput: HandymanTaxIdentityOwner,
  atInput: string): Promise<HandymanTaxIdentityView> {
  const actor = uuid(actorInput, 'actorUserId'), target = owner(targetInput), at = instant(atInput, 'at');
  await access(actor, target.clientId, 'handyman.finance.read');
  const result = await getPool().query(`${SELECT_VIEW}
    WHERE p.client_id=$1 AND p.owner_kind=$2 AND p.owner_id=$3
      AND w.effective_from <= $4 AND (w.effective_to IS NULL OR $4 < w.effective_to)
      AND (p.owner_kind <> 'HANDYMAN_ISSUER' OR
        (i.client_id=p.client_id AND i.effective_from <= $4 AND
          ((i.status = 'ACTIVE' AND i.superseded_at IS NULL) OR
           (i.status = 'SUPERSEDED' AND i.superseded_at IS NOT NULL AND $4 < i.superseded_at))))`,
  [target.clientId, target.kind, ownerId(target), at]);
  if (!result.rowCount) throw notEffective();
  // The GiST exclusion is the authority; never choose arbitrarily if damaged.
  if (result.rowCount !== 1) throw conflict();
  return view(result.rows[0]);
}

/** The future tax-calculation seam explicitly fails until Finance approval exists. */
export async function requireApprovedHandymanTaxIdentityAt(actor: string, target: HandymanTaxIdentityOwner,
  at: string): Promise<never> {
  const result = await resolveHandymanTaxIdentityAt(actor, target, at);
  if (result.taxUse.reason !== 'APPROVAL_REQUIRED')
    throw error('HANDYMAN_TAX_IDENTITY_UNKNOWN', 'Unknown taxpayer, residency or PKP classification cannot be used for tax.', 409);
  throw error('HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED',
    'A dedicated Finance tax-identity approval contract is required before tax use.', 409);
}
