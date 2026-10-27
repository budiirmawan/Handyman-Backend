import { createHash } from 'node:crypto';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { validateApprovedPpnIdentityPin } from '../handyman-ppn-calculation/handyman-ppn-core';
import type { PpnIdentityPin, PpnIdentityReference, PpnRulePin } from '../handyman-ppn-calculation';
import type { ApprovedHandymanTaxIdentity } from '../handyman-tax-identity';
import type { HandymanTaxRuleSnapshot, TaxRuleResolution } from '../handyman-tax-rules';
import type { ApprovedBmWithholdingBreakdown, BmCommissionSource, CalculateApprovedBmWithholdingInput } from './handyman-pph.types';

type PphCode = 'HANDYMAN_PPH_INVALID' | 'HANDYMAN_PPH_SOURCE_NOT_FOUND' | 'HANDYMAN_PPH_SOURCE_STALE' |
  'HANDYMAN_PPH_CORRECTION_UNSUPPORTED' | 'HANDYMAN_PPH_MISSING_RULE' | 'HANDYMAN_PPH_AMBIGUOUS_RULE' |
  'HANDYMAN_PPH_NOT_APPROVED' | 'HANDYMAN_PPH_INTEGRITY_ERROR' | 'HANDYMAN_PPH_UNSUPPORTED' | 'HANDYMAN_PPH_IDENTITY_MISMATCH';
export function pphError(code: PphCode, message: string, statusCode = 409): AppError {
  return new AppError({ code: ERROR_CODES[code], message, statusCode });
}
const invalid = (field: string) => pphError('HANDYMAN_PPH_INVALID', `Invalid ${field}.`, 400);
export const pphIntegrity = () => pphError('HANDYMAN_PPH_INTEGRITY_ERROR', 'Commission or approved provenance failed its integrity checks.');
const unsupported = (field: string) => pphError('HANDYMAN_PPH_UNSUPPORTED', `Unsupported or unapproved ${field}.`);
const mismatch = () => pphError('HANDYMAN_PPH_IDENTITY_MISMATCH', 'The approved identity or classification does not match the exact BM beneficiary.');
const notApproved = () => pphError('HANDYMAN_PPH_NOT_APPROVED', 'The pinned approval was not effective at the required instant.');
export const hash = (value: unknown): string => createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
function keys(value: unknown, allowed: readonly string[], field: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw invalid(field);
}
export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) throw invalid(field);
  return value.toLowerCase();
}
function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalid(field);
  return value;
}
function version(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647) throw invalid(field);
  return value as number;
}
function date(value: unknown, field: string): string {
  const m = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)$/.exec(value);
  if (!m) throw invalid(field);
  const y = +m[1], mon = +m[2], d = +m[3], leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  if (y < 1 || mon < 1 || mon > 12 || d < 1 || d > days[mon - 1]) throw invalid(field);
  return value as string;
}
function instant(value: unknown, field: string): string {
  const m = typeof value === 'string' && /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!m) throw invalid(field);
  date(m[1], field);
  if (+m[2] > 23 || +m[3] > 59 || +m[4] > 59 || (m[6] && (+m[6] > 14 || +m[7] > 59 || (+m[6] === 14 && +m[7] !== 0)))) throw invalid(field);
  const parsed = new Date(value as string);
  if (!Number.isFinite(parsed.getTime())) throw invalid(field);
  return parsed.toISOString();
}
export function cents(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,15})\.\d{2}$/.test(value)) throw invalid('money');
  const [whole, fraction] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
}
export function decimal(value: bigint): string {
  if (value < 0n || value > 999999999999999999n) throw pphIntegrity();
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}
function identityPin(value: PpnIdentityPin): PpnIdentityPin {
  keys(value, ['owner','profileId','profileVersion','profileDigest','approvalDecisionId'], 'beneficiary');
  keys(value.owner, ['kind','clientId','counterpartyId'], 'beneficiary.owner');
  if (value.owner.kind !== 'BM_BENEFICIARY') throw mismatch();
  return { owner: { kind: 'BM_BENEFICIARY', clientId: uuid(value.owner.clientId,'beneficiary.owner.clientId'),
    counterpartyId: uuid(value.owner.counterpartyId,'beneficiary.owner.counterpartyId') },
    profileId: uuid(value.profileId,'beneficiary.profileId'), profileVersion: version(value.profileVersion,'beneficiary.profileVersion'),
    profileDigest: digest(value.profileDigest,'beneficiary.profileDigest'), approvalDecisionId: uuid(value.approvalDecisionId,'beneficiary.approvalDecisionId') };
}
function rulePin(value: PpnRulePin): PpnRulePin {
  keys(value,['ruleId','ruleVersion','ruleDigest','approvalDecisionId'],'rule');
  return { ruleId: uuid(value.ruleId,'rule.ruleId'), ruleVersion: version(value.ruleVersion,'rule.ruleVersion'),
    ruleDigest: digest(value.ruleDigest,'rule.ruleDigest'), approvalDecisionId: uuid(value.approvalDecisionId,'rule.approvalDecisionId') };
}
export function normalizePphInput(input: CalculateApprovedBmWithholdingInput): CalculateApprovedBmWithholdingInput {
  keys(input, ['clientId','entitlementId','sourceChecksum','currency','commissionBasis','commissionGross','taxDate','taxPointAt',
    'treatment','taxpayerClassification','beneficiary','rule'], 'input');
  const clientId = uuid(input.clientId,'clientId'), taxDate = date(input.taxDate,'taxDate'), taxPointAt = instant(input.taxPointAt,'taxPointAt');
  if (new Date(Date.parse(taxPointAt) + 7 * 3600000).toISOString().slice(0,10) !== taxDate) throw invalid('taxDate/taxPointAt');
  if (input.currency !== 'IDR' || input.commissionBasis !== 'EARNED_BM_COMMISSION') throw unsupported('currency or commission basis');
  cents(input.commissionGross);
  if (!['WITHHOLD','EXEMPT','NON_WITHHOLD'].includes(input.treatment)) throw invalid('treatment');
  if (typeof input.taxpayerClassification !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(input.taxpayerClassification)) throw invalid('taxpayerClassification');
  const beneficiary = identityPin(input.beneficiary);
  if (beneficiary.owner.clientId !== clientId) throw mismatch();
  return { clientId, entitlementId: uuid(input.entitlementId,'entitlementId'), sourceChecksum: digest(input.sourceChecksum,'sourceChecksum'),
    currency:'IDR', commissionBasis:'EARNED_BM_COMMISSION', commissionGross:input.commissionGross, taxDate, taxPointAt,
    treatment:input.treatment, taxpayerClassification:input.taxpayerClassification, beneficiary, rule:rulePin(input.rule) };
}

function epoch(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) throw pphIntegrity();
  const n = Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== value) throw pphIntegrity();
  return n;
}
type ApprovedRule = Extract<TaxRuleResolution, { status: 'APPROVED' }>;
function expectedClassification(input: CalculateApprovedBmWithholdingInput, identity: ApprovedHandymanTaxIdentity): string {
  const m = /^P02B_(TAX|EXEMPT|NON_WITHHOLD)_(E|IR|IN)_([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)$/.exec(input.taxpayerClassification);
  if (!m || m[3].length < 2 || m[3].length > 32 || m[3].split('_').some(x => ['ANY','ALL','DEFAULT','UNKNOWN','UNSPECIFIED','NONE'].includes(x)))
    throw unsupported('taxpayer classification vocabulary');
  const treatment = m[1] === 'TAX' ? 'WITHHOLD' : m[1];
  const p = identity.snapshot;
  const kind = p.taxpayerKind === 'LEGAL_ENTITY' && p.individualResidency === null ? 'E' :
    p.taxpayerKind === 'INDIVIDUAL' && p.individualResidency === 'RESIDENT' ? 'IR' :
    p.taxpayerKind === 'INDIVIDUAL' && p.individualResidency === 'NON_RESIDENT' ? 'IN' : null;
  if (input.treatment !== treatment || kind !== m[2]) throw mismatch();
  const description = kind === 'E' ? 'ENTITY' : kind === 'IR' ? 'INDIVIDUAL_RESIDENT' : 'INDIVIDUAL_NON_RESIDENT';
  return `P02B_V1|TREATMENT=${treatment}|BENEFICIARY=${description}|CASE=${m[3]}`;
}
function validateRule(input: CalculateApprovedBmWithholdingInput, resolved: ApprovedRule, cutoff: number, description: string): void {
  if (!resolved || resolved.status !== 'APPROVED' || !resolved.rule || !resolved.approval) throw pphIntegrity();
  const { rule, approval } = resolved, p = rule.snapshot, s = approval.submission, d = approval.decision, w = rule.effectiveWindow;
  if (!p || !s || !d || !w || p.schema !== 'HANDYMAN_TAX_RULE_V1' || p.id !== input.rule.ruleId || p.version !== input.rule.ruleVersion ||
      rule.digestAlgorithm !== 'SHA-256' || rule.digest !== input.rule.ruleDigest || hash(p) !== rule.digest ||
      p.clientId !== input.clientId || p.transactionContext !== 'BM_COMMISSION' || p.taxCode !== 'PPH_WITHHOLDING' ||
      p.taxpayerClassification !== input.taxpayerClassification || p.classificationDescription !== description ||
      d.id !== input.rule.approvalDecisionId || s.eventType !== 'SUBMIT' || s.submissionId !== null || s.sourceValidation !== null ||
      d.eventType !== 'APPROVE' || d.sourceValidation !== 'FINANCE_VALIDATED' || d.submissionId !== s.id ||
      s.ruleId !== p.id || d.ruleId !== p.id || s.clientId !== p.clientId || d.clientId !== p.clientId ||
      s.ruleVersion !== p.version || d.ruleVersion !== p.version || s.ruleDigest !== rule.digest || d.ruleDigest !== rule.digest ||
      s.actorUserId === d.actorUserId || d.actorUserId === p.createdByUserId || epoch(d.occurredAt) <= epoch(s.occurredAt) ||
      !p.legalReference || !p.legalSource || !p.evidenceSource || !p.evidenceReference ||
      !s.evidenceSource || !s.evidenceReference || !d.evidenceSource || !d.evidenceReference ||
      s.reviewFrom !== p.effectiveFrom || d.reviewFrom !== s.reviewFrom || d.reviewTo !== s.reviewTo || w.from !== p.effectiveFrom ||
      (w.closureId === null && w.to !== p.declaredEffectiveTo) || (w.closureId !== null && w.to === null) ||
      (p.declaredEffectiveTo !== null && (w.to === null || w.to > p.declaredEffectiveTo)) ||
      (s.reviewTo !== null && (w.to === null || w.to > s.reviewTo))) throw pphIntegrity();
  if (epoch(d.occurredAt) > cutoff || input.taxDate < p.effectiveFrom || (w.to !== null && input.taxDate >= w.to)) throw notApproved();
}
function rate(value: string): { numerator: bigint; denominator: bigint } {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(value)) throw pphIntegrity();
  const [whole, fraction = ''] = value.split('.'), scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * scale + BigInt(fraction || '0');
  if (numerator > 100n * scale) throw pphIntegrity();
  return { numerator, denominator: 100n * scale };
}
/** Numerator is in cents; scale selects the quantum before exact rational rounding. */
function round(n: bigint, d: bigint, mode: string, scale: 0 | 2 | null): bigint {
  const quantum = scale === 0 ? 100n : 1n, divisor = d * quantum, q = n / divisor, r = n % divisor;
  if (!r) return q * quantum;
  if (mode === 'NO_ROUNDING') throw unsupported('inexact NO_ROUNDING result');
  if (mode === 'DOWN') return q * quantum;
  if (mode === 'UP') return (q + 1n) * quantum;
  if (mode === 'HALF_UP') return (q + (r * 2n >= divisor ? 1n : 0n)) * quantum;
  if (mode === 'HALF_EVEN') return (q + (r * 2n > divisor || (r * 2n === divisor && q % 2n === 1n) ? 1n : 0n)) * quantum;
  throw unsupported('rounding mode');
}
function amounts(input: CalculateApprovedBmWithholdingInput, p: HandymanTaxRuleSnapshot) {
  const gross = cents(input.commissionGross), r = rate(p.ratePercent);
  if (!['HALF_UP','HALF_EVEN','DOWN','UP','NO_ROUNDING'].includes(p.roundingMode) ||
      (p.roundingMode === 'NO_ROUNDING' ? p.roundingScale !== null : p.roundingScale !== 0 && p.roundingScale !== 2))
    throw unsupported('IDR rounding policy');
  const scale = p.roundingScale as 0 | 2 | null;
  const grossDesc = 'P02B_V1|BASIS=GROSS|PPH=ROUND(BASIS*RATE/100)|NET=GROSS-PPH';
  let basis: bigint, withholding: bigint;
  if (p.basisMethodCode === 'PPH02B_GROSS_V1') {
    if (input.treatment !== 'WITHHOLD' || r.numerator === 0n || p.basisDescription !== grossDesc) throw unsupported('gross withholding method');
    basis = gross; withholding = round(basis * r.numerator,r.denominator,p.roundingMode,scale);
  } else {
    const ratio = /^PPH02B_RATIO_([1-9]\d{0,6})_([1-9]\d{0,6})_V1$/.exec(p.basisMethodCode);
    if (ratio) {
      const n = BigInt(ratio[1]), d = BigInt(ratio[2]);
      const desc = `P02B_V1|BASIS=ROUND(GROSS*${n}/${d})|PPH=ROUND(BASIS*RATE/100)|NET=GROSS-PPH`;
      if (input.treatment !== 'WITHHOLD' || r.numerator === 0n || n > 1000000n || d > 1000000n || p.basisDescription !== desc)
        throw unsupported('ratio withholding method');
      basis = round(gross*n,d,p.roundingMode,scale);
      withholding = round(basis*r.numerator,r.denominator,p.roundingMode,scale);
    } else if (p.basisMethodCode === 'PPH02B_EXEMPT_V1' || p.basisMethodCode === 'PPH02B_NON_WITHHOLD_V1') {
      const treatment = p.basisMethodCode === 'PPH02B_EXEMPT_V1' ? 'EXEMPT' : 'NON_WITHHOLD';
      const desc = `P02B_V1|TREATMENT=${treatment}|BASIS=0|PPH=0|NET=GROSS`;
      if (input.treatment !== treatment || r.numerator !== 0n || p.basisDescription !== desc) throw unsupported('zero-withholding treatment');
      basis = 0n; withholding = 0n;
    } else throw unsupported('withholding method');
  }
  if (withholding > gross) throw pphIntegrity();
  return { basis, withholding, net: gross-withholding };
}
function reference(id: ApprovedHandymanTaxIdentity): PpnIdentityReference {
  const p = id.snapshot;
  return Object.freeze({ ownerKind:p.ownerKind,ownerId:p.ownerId,clientId:p.clientId,profileId:p.id,profileVersion:p.version,
    profileDigest:id.digest,issuerProfileId:p.issuerProfileId,counterpartyId:p.counterpartyId,verificationId:p.verificationId,
    evidenceSource:p.evidenceSource,evidenceReference:p.evidenceReference,createdByUserId:p.createdByUserId,
    taxpayerKind:p.taxpayerKind as 'LEGAL_ENTITY'|'INDIVIDUAL',
    individualResidency:p.individualResidency as 'RESIDENT'|'NON_RESIDENT'|null,pkpStatus:p.pkpStatus as 'PKP'|'NON_PKP',
    approval:Object.freeze({ submission:Object.freeze({ ...id.approval.submission }), decision:Object.freeze({ ...id.approval.decision }) }) });
}

/** Pure math/checks for already resolved trusted snapshots: this function cannot prove database authenticity. */
export function calculateBmWithholdingFromResolved(input: CalculateApprovedBmWithholdingInput, source: BmCommissionSource,
  identity: ApprovedHandymanTaxIdentity, resolved: ApprovedRule, authorityAsOf: string): ApprovedBmWithholdingBreakdown {
  const n = normalizePphInput(input), { checksumAlgorithm, checksum, ...body } = source;
  if (checksumAlgorithm !== 'SHA-256' || hash(body) !== checksum || checksum !== n.sourceChecksum ||
      source.schema !== 'HANDYMAN_BM_COMMISSION_SOURCE_V1' || source.entitlementId !== n.entitlementId ||
      source.clientId !== n.clientId || source.currency !== n.currency || source.commissionBasis !== n.commissionBasis ||
      source.commissionGross !== n.commissionGross || epoch(source.ledgerPostedAt) > epoch(n.taxPointAt)) throw pphIntegrity();
  if (n.beneficiary.owner.kind !== 'BM_BENEFICIARY' || n.beneficiary.owner.counterpartyId !== source.beneficiary.counterpartyId ||
      identity.snapshot.verificationId !== source.beneficiary.verificationId) throw mismatch();
  try { validateApprovedPpnIdentityPin(n.beneficiary,identity,n.taxPointAt,authorityAsOf); }
  catch (err) {
    if (err instanceof AppError && err.code === ERROR_CODES.HANDYMAN_PPN_NOT_APPROVED) throw notApproved();
    if (err instanceof AppError && err.code === ERROR_CODES.HANDYMAN_PPN_IDENTITY_MISMATCH) throw mismatch();
    throw pphIntegrity();
  }
  const desc = expectedClassification(n,identity);
  validateRule(n,resolved,Math.min(epoch(n.taxPointAt),epoch(authorityAsOf)),desc);
  const p = resolved.rule.snapshot, { basis, withholding, net } = amounts(n,p);
  const result = Object.freeze({ schema:'HANDYMAN_BM_PPH_WITHHOLDING_V1' as const, clientId:n.clientId,
    taxDate:n.taxDate,taxPointAt:n.taxPointAt,currency:'IDR' as const,commissionBasis:n.commissionBasis,commissionGross:n.commissionGross,
    treatment:n.treatment,taxpayerClassification:n.taxpayerClassification,taxableWithholdingBasis:decimal(basis),
    ratePercent:p.ratePercent,pphWithheld:decimal(withholding),projectedNetCommission:decimal(net),
    rounding:Object.freeze({ mode:p.roundingMode,scale:p.roundingScale as 0|2|null,stages:'BASIS_THEN_WITHHOLDING' as const }),
    basisMethodCode:p.basisMethodCode,source,beneficiaryTaxIdentity:reference(identity),
    rule:Object.freeze({ id:p.id,version:p.version,digest:resolved.rule.digest,legalReference:p.legalReference,legalSource:p.legalSource,
      classificationDescription:p.classificationDescription,basisDescription:p.basisDescription,evidenceSource:p.evidenceSource,
      evidenceReference:p.evidenceReference,createdByUserId:p.createdByUserId,
      approval:Object.freeze({ submission:Object.freeze({ ...resolved.approval.submission }),decision:Object.freeze({ ...resolved.approval.decision }) }) }),
    caseApplicability:'CALLER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED' as const,authority:'READ_ONLY_PROJECTION' as const });
  return Object.freeze({ ...result,checksumAlgorithm:'SHA-256' as const,checksum:hash(result) });
}
