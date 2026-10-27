import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError, canAccessClient } from '../context-access';
import { financialPermission } from '../handyman-customer-transactions/handyman-financial-integration-access';
import { permissionRepository } from '../permissions';
import type {
  CreateHandymanTaxRule, HandymanTaxRuleScope, HandymanTaxRuleSnapshot, HandymanTaxRuleView,
  TaxRuleApprovalEvent, TaxRuleDecisionCommand, TaxRuleResolution, TaxRuleResolveInput, TaxRuleReviewCommand,
} from './handyman-tax-rules.types';

type TaxRuleErrorCode = 'HANDYMAN_TAX_RULE_INVALID' | 'HANDYMAN_TAX_RULE_NOT_FOUND' |
  'HANDYMAN_TAX_RULE_CONFLICT' | 'HANDYMAN_TAX_RULE_APPROVAL_FORBIDDEN' | 'HANDYMAN_TAX_RULE_INTEGRITY_ERROR';
function error(code: TaxRuleErrorCode, message: string, statusCode: number): AppError {
  return new AppError({ code: ERROR_CODES[code], message, statusCode });
}
const invalid = (field: string) => error('HANDYMAN_TAX_RULE_INVALID', `Invalid ${field}.`, 400);
const notFound = () => error('HANDYMAN_TAX_RULE_NOT_FOUND', 'The exact tax rule was not found in this Client.', 404);
const conflict = () => error('HANDYMAN_TAX_RULE_CONFLICT', 'The tax rule version, scope or effective period conflicts.', 409);
const integrity = () => error('HANDYMAN_TAX_RULE_INTEGRITY_ERROR', 'The tax rule does not match its immutable digest.', 409);
const selfDecision = () => error('HANDYMAN_TAX_RULE_APPROVAL_FORBIDDEN', 'A tax rule maker or author cannot decide their own rule.', 403);
function dbError(err: unknown): never {
  if (err instanceof AppError) throw err;
  if (['23503','23505','23514','23P01','40001','40P01'].includes((err as { code?: string })?.code ?? '')) throw conflict();
  throw err;
}
function exactKeys(input: unknown, allowed: readonly string[], field = 'input'): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw invalid(field);
}
function uuid(input: unknown, field: string): string {
  if (typeof input !== 'string' || !isValidUuid(input)) throw invalid(field);
  return input.toLowerCase();
}
function text(input: unknown, field: string, max: number): string {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(field);
  return value;
}
function code(input: unknown, field: string): string {
  if (typeof input !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(input) ||
      ['UNKNOWN','ANY','ALL','DEFAULT','NONE','PKP','NON_PKP'].includes(input)) throw invalid(field);
  return input;
}
function calendarDate(input: unknown, field: string): string {
  const m = typeof input === 'string' && /^(\d{4})-(\d\d)-(\d\d)$/.exec(input);
  if (!m) throw invalid(field);
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw invalid(field);
  return input as string;
}
function knownInstant(input: unknown): Date {
  const m = typeof input === 'string' && /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-](\d\d):(\d\d))$/.exec(input);
  if (!m) throw invalid('knownAt');
  calendarDate(m[1], 'knownAt');
  if (+m[2] > 23 || +m[3] > 59 || +m[4] > 59 || (m[6] && (+m[6] > 23 || +m[7] > 59))) throw invalid('knownAt');
  const d = new Date(input as string);
  if (!Number.isFinite(d.getTime())) throw invalid('knownAt');
  return d;
}
function scope(input: HandymanTaxRuleScope): HandymanTaxRuleScope {
  const clientId = uuid(input.clientId, 'clientId');
  if (!['CUSTOMER_SERVICE_BILLING','BM_COMMISSION'].includes(input.transactionContext)) throw invalid('transactionContext');
  if (!['PPN','PPH_WITHHOLDING'].includes(input.taxCode)) throw invalid('taxCode');
  return { clientId, transactionContext: input.transactionContext, taxCode: input.taxCode,
    taxpayerClassification: code(input.taxpayerClassification, 'taxpayerClassification') };
}
const scopeFields = ['clientId','transactionContext','taxCode','taxpayerClassification'] as const;
function normalizeCreate(input: CreateHandymanTaxRule) {
  exactKeys(input, [...scopeFields,'classificationDescription','effectiveFrom','effectiveTo','basisMethodCode','basisDescription',
    'ratePercent','roundingMode','roundingScale','legalReference','legalSource','evidenceSource','evidenceReference','expectedVersion']);
  const s = scope(input), from = calendarDate(input.effectiveFrom, 'effectiveFrom');
  const to = input.effectiveTo === null ? null : calendarDate(input.effectiveTo, 'effectiveTo');
  if (to !== null && to <= from) throw invalid('effectiveTo');
  if (typeof input.ratePercent !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(input.ratePercent) ||
      Number(input.ratePercent) > 100) throw invalid('ratePercent');
  if (!['HALF_UP','HALF_EVEN','DOWN','UP','NO_ROUNDING'].includes(input.roundingMode) ||
      (input.roundingMode === 'NO_ROUNDING' ? input.roundingScale !== null :
        !Number.isInteger(input.roundingScale) || input.roundingScale! < 0 || input.roundingScale! > 6)) throw invalid('rounding policy');
  if (input.expectedVersion !== null && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || input.expectedVersion > 2_147_483_646))
    throw invalid('expectedVersion');
  return { ...s, from, to, classificationDescription: text(input.classificationDescription, 'classificationDescription', 500),
    basisMethodCode: code(input.basisMethodCode, 'basisMethodCode'), basisDescription: text(input.basisDescription, 'basisDescription', 500),
    ratePercent: input.ratePercent, roundingMode: input.roundingMode, roundingScale: input.roundingScale,
    legalReference: text(input.legalReference, 'legalReference', 500), legalSource: text(input.legalSource, 'legalSource', 500),
    evidenceSource: text(input.evidenceSource, 'evidenceSource', 200), evidenceReference: text(input.evidenceReference, 'evidenceReference', 500),
    expectedVersion: input.expectedVersion };
}

/** Actor IDs must come from trusted authenticated server callers, never the request body. */
async function access(actor: string, clientId: string, mode: 'maker' | 'checker' | 'read', tx?: PoolClient): Promise<void> {
  const result = await (tx ?? getPool()).query('SELECT status FROM users WHERE id=$1', [actor]);
  if (result.rows[0]?.status !== 'ACTIVE')
    throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'An active authenticated Finance actor is required.' });
  const required = mode === 'maker' ? 'handyman.finance.manage' : 'handyman.finance.read';
  if (tx) {
    const permissions = await permissionRepository.listActivePermissionCodesForUser(actor, tx);
    if (!permissions.includes(required) || (mode === 'checker' && !permissions.includes('handyman.tax_rule.approve')))
      throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'Explicit Finance authority is required.' });
  } else {
    await financialPermission(actor, required);
    if (mode === 'checker') await financialPermission(actor, 'handyman.tax_rule.approve');
  }
  if (!(await canAccessClient(actor, clientId, tx))) throw buildingAccessDeniedError();
}
async function lockClient(tx: PoolClient, clientId: string): Promise<void> {
  if (!(await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [clientId])).rowCount) throw notFound();
}
const VIEW_FIELDS = `r.*, to_char(r.effective_from,'YYYY-MM-DD') AS rule_from,
  CASE WHEN r.declared_effective_to IS NULL THEN NULL ELSE to_char(r.declared_effective_to,'YYYY-MM-DD') END AS declared_to,
  to_char(w.effective_from,'YYYY-MM-DD') AS window_from,
  CASE WHEN w.effective_to IS NULL THEN NULL ELSE to_char(w.effective_to,'YYYY-MM-DD') END AS window_to,
  w.client_id AS window_client, w.transaction_context AS window_context, w.tax_code AS window_code,
  w.taxpayer_classification AS window_classification, c.id AS closure_id,
  CASE WHEN c.effective_to IS NULL THEN NULL ELSE to_char(c.effective_to,'YYYY-MM-DD') END AS closure_to`;
const VIEW_FROM = `FROM handyman_tax_rules r JOIN handyman_tax_rule_windows w ON w.rule_id=r.id
  LEFT JOIN handyman_tax_rule_closures c ON c.rule_id=r.id`;
function view(row: Record<string, any>): HandymanTaxRuleView {
  const snapshot: HandymanTaxRuleSnapshot = Object.freeze({ schema: 'HANDYMAN_TAX_RULE_V1', id: row.id, clientId: row.client_id,
    transactionContext: row.transaction_context, taxCode: row.tax_code, taxpayerClassification: row.taxpayer_classification,
    classificationDescription: row.classification_description, version: row.version, effectiveFrom: row.rule_from,
    declaredEffectiveTo: row.declared_to, basisMethodCode: row.basis_method_code, basisDescription: row.basis_description,
    ratePercent: row.rate_percent, roundingMode: row.rounding_mode, roundingScale: row.rounding_scale,
    legalReference: row.legal_reference, legalSource: row.legal_source, evidenceSource: row.evidence_source,
    evidenceReference: row.evidence_reference, createdByUserId: row.created_by_user_id, createdAt: row.created_at.toISOString() });
  return Object.freeze({ snapshot, digestAlgorithm: 'SHA-256', digest: createHash('sha256').update(stableJson(snapshot)).digest('hex'),
    effectiveWindow: Object.freeze({ from: row.window_from, to: row.window_to, closureId: row.closure_id }) });
}
async function lockedView(tx: PoolClient, clientId: string, ruleId: string): Promise<HandymanTaxRuleView> {
  await lockClient(tx, clientId);
  const result = await tx.query(`SELECT ${VIEW_FIELDS} ${VIEW_FROM} WHERE r.id=$1 AND r.client_id=$2 FOR UPDATE OF w`, [ruleId, clientId]);
  if (!result.rowCount) throw notFound();
  return view(result.rows[0]);
}

/** Capture an immutable rule; it is not eligible until a separate checker approves it. */
export async function createHandymanTaxRule(actorInput: string, input: CreateHandymanTaxRule): Promise<HandymanTaxRuleView> {
  const actor = uuid(actorInput, 'actorUserId'), n = normalizeCreate(input);
  await access(actor, n.clientId, 'maker');
  try {
    return await withTransaction(async tx => {
      await lockClient(tx, n.clientId);
      const previous = await tx.query(`SELECT version FROM handyman_tax_rules WHERE client_id=$1 AND transaction_context=$2
        AND tax_code=$3 AND taxpayer_classification=$4 ORDER BY version DESC LIMIT 1`,
      [n.clientId, n.transactionContext, n.taxCode, n.taxpayerClassification]);
      const last = previous.rows[0]?.version ?? null;
      if (last !== n.expectedVersion) throw conflict();
      const id = randomUUID();
      await tx.query(`INSERT INTO handyman_tax_rules
        (id,client_id,transaction_context,tax_code,taxpayer_classification,classification_description,version,effective_from,
         declared_effective_to,basis_method_code,basis_description,rate_percent,rounding_mode,rounding_scale,legal_reference,
         legal_source,evidence_source,evidence_reference,created_by_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id,n.clientId,n.transactionContext,n.taxCode,n.taxpayerClassification,n.classificationDescription,(last ?? 0)+1,n.from,n.to,
        n.basisMethodCode,n.basisDescription,n.ratePercent,n.roundingMode,n.roundingScale,n.legalReference,n.legalSource,
        n.evidenceSource,n.evidenceReference,actor]);
      return await lockedView(tx, n.clientId, id);
    });
  } catch (err) { return dbError(err); }
}

/** Only future shortening or cancellation; no prior approved rule is rewritten. */
export async function closeHandymanTaxRule(actorInput: string, input: {
  clientId: string; ruleId: string; effectiveTo: string; reason: string;
}): Promise<HandymanTaxRuleView> {
  exactKeys(input, ['clientId','ruleId','effectiveTo','reason']);
  const actor = uuid(actorInput,'actorUserId'), clientId = uuid(input.clientId,'clientId'), ruleId = uuid(input.ruleId,'ruleId');
  const to = calendarDate(input.effectiveTo,'effectiveTo'), reason = text(input.reason,'reason',500);
  await access(actor,clientId,'maker');
  try {
    return await withTransaction(async tx => {
      await lockedView(tx,clientId,ruleId);
      await tx.query(`INSERT INTO handyman_tax_rule_closures(id,rule_id,effective_to,reason,created_by_user_id)
        VALUES($1,$2,$3,$4,$5)`, [randomUUID(),ruleId,to,reason,actor]);
      return await lockedView(tx,clientId,ruleId);
    });
  } catch (err) { return dbError(err); }
}

type Review = { clientId: string; ruleId: string; ruleVersion: number; ruleDigest: string; evidenceSource: string; evidenceReference: string };
function review(input: TaxRuleReviewCommand, deciding = false): Review {
  exactKeys(input, ['clientId','ruleId','ruleVersion','ruleDigest','evidenceSource','evidenceReference',
    ...(deciding ? ['submissionId','decision','sourceValidation'] : [])]);
  if (!Number.isSafeInteger(input.ruleVersion) || input.ruleVersion < 1 || input.ruleVersion > 2_147_483_647) throw invalid('ruleVersion');
  if (typeof input.ruleDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.ruleDigest)) throw invalid('ruleDigest');
  return { clientId: uuid(input.clientId,'clientId'), ruleId: uuid(input.ruleId,'ruleId'), ruleVersion: input.ruleVersion,
    ruleDigest: input.ruleDigest, evidenceSource: text(input.evidenceSource,'evidenceSource',200),
    evidenceReference: text(input.evidenceReference,'evidenceReference',500) };
}
const EVENT_RETURN = `*, to_char(review_from,'YYYY-MM-DD') AS review_from_day,
  CASE WHEN review_to IS NULL THEN NULL ELSE to_char(review_to,'YYYY-MM-DD') END AS review_to_day`;
function event(row: Record<string, any>): TaxRuleApprovalEvent {
  const occurredAt = row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(row.occurred_at).toISOString();
  return Object.freeze({ id: row.id, ruleId: row.rule_id, clientId: row.client_id, ruleVersion: row.rule_version,
    ruleDigest: row.rule_digest, eventType: row.event_type, submissionId: row.submission_id,
    sourceValidation: row.source_validation, actorUserId: row.actor_user_id,
    evidenceSource: row.evidence_source, evidenceReference: row.evidence_reference, occurredAt,
    reviewFrom: row.review_from_day ?? row.review_from, reviewTo: row.review_to_day ?? row.review_to });
}
function assertPin(rule: HandymanTaxRuleView, n: Review): void {
  if (rule.snapshot.version !== n.ruleVersion) throw conflict();
  if (rule.digest !== n.ruleDigest) throw integrity();
}
export async function submitHandymanTaxRule(actorInput: string, input: TaxRuleReviewCommand): Promise<TaxRuleApprovalEvent> {
  const actor = uuid(actorInput,'actorUserId'), n = review(input);
  await access(actor,n.clientId,'maker');
  try {
    return await withTransaction(async tx => {
      const r = await lockedView(tx,n.clientId,n.ruleId); assertPin(r,n);
      const inserted = await tx.query(`INSERT INTO handyman_tax_rule_approval_events
        (id,rule_id,client_id,rule_version,rule_digest,event_type,actor_user_id,evidence_source,evidence_reference)
        VALUES($1,$2,$3,$4,$5,'SUBMIT',$6,$7,$8) RETURNING ${EVENT_RETURN}`,
      [randomUUID(),n.ruleId,n.clientId,n.ruleVersion,n.ruleDigest,actor,n.evidenceSource,n.evidenceReference]);
      return event(inserted.rows[0]);
    });
  } catch (err) { return dbError(err); }
}
export async function decideHandymanTaxRule(actorInput: string, input: TaxRuleDecisionCommand): Promise<TaxRuleApprovalEvent> {
  const actor = uuid(actorInput,'actorUserId'), n = review(input,true), submissionId = uuid(input.submissionId,'submissionId');
  if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') throw invalid('decision');
  if (input.decision === 'APPROVE' ? input.sourceValidation !== 'FINANCE_VALIDATED' : input.sourceValidation !== null)
    throw invalid('sourceValidation');
  await access(actor,n.clientId,'checker');
  try {
    return await withTransaction(async tx => {
      const r = await lockedView(tx,n.clientId,n.ruleId); assertPin(r,n);
      const submitted = await tx.query(`SELECT * FROM handyman_tax_rule_approval_events WHERE id=$1 AND rule_id=$2 AND event_type='SUBMIT'`,
        [submissionId,n.ruleId]);
      if (!submitted.rowCount) throw notFound();
      const s = submitted.rows[0];
      if (s.client_id !== n.clientId || s.rule_version !== n.ruleVersion || s.rule_digest !== n.ruleDigest) throw integrity();
      if (actor === s.actor_user_id || actor === r.snapshot.createdByUserId) throw selfDecision();
      const inserted = await tx.query(`INSERT INTO handyman_tax_rule_approval_events
        (id,rule_id,client_id,rule_version,rule_digest,event_type,submission_id,source_validation,actor_user_id,evidence_source,evidence_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${EVENT_RETURN}`,
      [randomUUID(),n.ruleId,n.clientId,n.ruleVersion,n.ruleDigest,input.decision,submissionId,input.sourceValidation,actor,n.evidenceSource,n.evidenceReference]);
      return event(inserted.rows[0]);
    });
  } catch (err) { return dbError(err); }
}
export async function listHandymanTaxRuleApprovalHistory(actorInput: string, clientInput: string, ruleInput: string): Promise<readonly TaxRuleApprovalEvent[]> {
  const actor = uuid(actorInput,'actorUserId'), clientId = uuid(clientInput,'clientId'), ruleId = uuid(ruleInput,'ruleId');
  await access(actor,clientId,'read');
  const result = await getPool().query(`SELECT ${EVENT_RETURN} FROM handyman_tax_rule_approval_events
    WHERE client_id=$1 AND rule_id=$2 ORDER BY occurred_at,id`, [clientId,ruleId]);
  return Object.freeze(result.rows.map(event));
}

/** Explicit case and tax family are mandatory; no identity, PKP or zero-rate fallback is consulted. */
export async function resolveHandymanTaxRule(actorInput: string, input: TaxRuleResolveInput): Promise<TaxRuleResolution> {
  return resolveRule(actorInput, input);
}

/** Trusted internal callers can share a single repeatable-read snapshot across approvals. */
export async function resolveHandymanTaxRuleInSnapshot(tx: PoolClient, actorInput: string,
  input: TaxRuleResolveInput): Promise<TaxRuleResolution> {
  return resolveRule(actorInput, input, tx);
}

async function resolveRule(actorInput: string, input: TaxRuleResolveInput, tx?: PoolClient): Promise<TaxRuleResolution> {
  exactKeys(input, [...scopeFields,'taxDate','knownAt']);
  const actor = uuid(actorInput,'actorUserId'), s = scope(input), taxDate = calendarDate(input.taxDate,'taxDate');
  const asOf = input.knownAt === undefined ? null : knownInstant(input.knownAt);
  await access(actor,s.clientId,'read',tx);
  const result = await (tx ?? getPool()).query(`SELECT ${VIEW_FIELDS}, row_to_json(a) AS approval_fact,
    row_to_json(sub) AS submission_fact, clock_timestamp() AS read_at ${VIEW_FROM}
    LEFT JOIN handyman_tax_rule_approval_events a ON a.rule_id=r.id AND a.event_type='APPROVE'
    LEFT JOIN handyman_tax_rule_approval_events sub ON sub.id=a.submission_id
    WHERE r.client_id=$1 AND r.transaction_context=$2 AND r.tax_code=$3 AND r.taxpayer_classification=$4
      AND w.effective_from <= $5::date AND (w.effective_to IS NULL OR $5::date < w.effective_to)`,
  [s.clientId,s.transactionContext,s.taxCode,s.taxpayerClassification,taxDate]);
  if (!result.rowCount) return Object.freeze({ status: 'MISSING' });
  if (result.rowCount !== 1) return Object.freeze({ status: 'AMBIGUOUS' });
  const row = result.rows[0], r = view(row), p = r.snapshot;
  const expectedTo = row.closure_id ? row.closure_to : p.declaredEffectiveTo;
  if (row.window_client !== p.clientId || row.window_context !== p.transactionContext || row.window_code !== p.taxCode ||
      row.window_classification !== p.taxpayerClassification || r.effectiveWindow.from !== p.effectiveFrom || r.effectiveWindow.to !== expectedTo)
    return Object.freeze({ status: 'INTEGRITY_ERROR' });
  if (!row.approval_fact) return Object.freeze({ status: 'NOT_APPROVED' });
  if (!row.submission_fact) return Object.freeze({ status: 'INTEGRITY_ERROR' });
  let submission: TaxRuleApprovalEvent, decision: TaxRuleApprovalEvent;
  try { submission = event(row.submission_fact); decision = event(row.approval_fact); }
  catch { return Object.freeze({ status: 'INTEGRITY_ERROR' }); }
  if (submission.eventType !== 'SUBMIT' || submission.submissionId !== null || submission.sourceValidation !== null ||
      decision.eventType !== 'APPROVE' || decision.sourceValidation !== 'FINANCE_VALIDATED' ||
      decision.submissionId !== submission.id || submission.ruleId !== p.id || decision.ruleId !== p.id ||
      submission.clientId !== p.clientId || decision.clientId !== p.clientId || submission.ruleVersion !== p.version || decision.ruleVersion !== p.version ||
      submission.ruleDigest !== r.digest || decision.ruleDigest !== r.digest || submission.actorUserId === decision.actorUserId ||
      p.createdByUserId === decision.actorUserId || decision.occurredAt <= submission.occurredAt ||
      submission.reviewFrom !== p.effectiveFrom || decision.reviewFrom !== submission.reviewFrom || decision.reviewTo !== submission.reviewTo ||
      !submission.evidenceSource || !submission.evidenceReference || !decision.evidenceSource || !decision.evidenceReference ||
      (submission.reviewTo !== null && (r.effectiveWindow.to === null || r.effectiveWindow.to > submission.reviewTo)))
    return Object.freeze({ status: 'INTEGRITY_ERROR' });
  const cutoff = Math.min(row.read_at.getTime(), asOf?.getTime() ?? Infinity);
  if (new Date(decision.occurredAt).getTime() > cutoff) return Object.freeze({ status: 'NOT_APPROVED' });
  return Object.freeze({ status: 'APPROVED', rule: r, approval: Object.freeze({ submission, decision }) });
}
