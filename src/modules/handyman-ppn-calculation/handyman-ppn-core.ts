import { createHash } from 'node:crypto';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import type { ApprovedHandymanTaxIdentity, HandymanTaxIdentityOwner } from '../handyman-tax-identity';
import type { TaxRuleResolution } from '../handyman-tax-rules';
import type { ApprovedPpnBreakdown, CalculateApprovedPpnInput, CalculateCustomerPpnInput, PpnApplicability, PpnIdentityPin, PpnIdentityReference } from './handyman-ppn.types';

type PpnCode = 'HANDYMAN_PPN_INVALID' | 'HANDYMAN_PPN_CUSTOMER_IDENTITY_UNAVAILABLE' | 'HANDYMAN_PPN_MISSING_RULE' | 'HANDYMAN_PPN_AMBIGUOUS_RULE' |
  'HANDYMAN_PPN_NOT_APPROVED' | 'HANDYMAN_PPN_INTEGRITY_ERROR' | 'HANDYMAN_PPN_UNSUPPORTED' | 'HANDYMAN_PPN_IDENTITY_MISMATCH';
export function ppnError(code: PpnCode, message: string, statusCode = 409): AppError {
  return new AppError({ code: ERROR_CODES[code], message, statusCode });
}
const invalid = (field: string) => ppnError('HANDYMAN_PPN_INVALID', `Invalid ${field}.`, 400);
const integrity = () => ppnError('HANDYMAN_PPN_INTEGRITY_ERROR', 'Approved tax facts or pinned provenance do not match.');
const unsupported = (field: string) => ppnError('HANDYMAN_PPN_UNSUPPORTED', `Unsupported or unapproved ${field}.`);
const mismatch = () => ppnError('HANDYMAN_PPN_IDENTITY_MISMATCH', 'Supplier, recipient or taxpayer classification is inconsistent.');
const notApproved = () => ppnError('HANDYMAN_PPN_NOT_APPROVED', 'Finance approval was not effective at the required instant.');
const customerUnavailable = () => ppnError('HANDYMAN_PPN_CUSTOMER_IDENTITY_UNAVAILABLE',
  'An approved customer identity and verified transaction-party relationship are not available.');

function keys(input: unknown, allowed: readonly string[], field: string): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw invalid(field);
}
function uuid(input: unknown, field: string): string {
  if (typeof input !== 'string' || !isValidUuid(input)) throw invalid(field);
  return input.toLowerCase();
}
function digest(input: unknown, field: string): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) throw invalid(field);
  return input;
}
function version(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1 || (input as number) > 2_147_483_647) throw invalid(field);
  return input as number;
}
function date(input: unknown, field: string): string {
  const match = typeof input === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) throw invalid(field);
  const y = +match[1], m = +match[2], d = +match[3];
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m-1]) throw invalid(field);
  return input as string;
}
function instant(input: unknown, field: string): string {
  const match = typeof input === 'string' && /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-](\d\d):(\d\d))$/.exec(input);
  if (!match) throw invalid(field);
  date(match[1],field);
  if (+match[2] > 23 || +match[3] > 59 || +match[4] > 59 ||
      (match[6] && (+match[6] > 14 || +match[7] > 59 || (+match[6] === 14 && +match[7] !== 0)))) throw invalid(field);
  const result = new Date(input as string);
  if (!Number.isFinite(result.getTime())) throw invalid(field);
  return result.toISOString();
}
function owner(input: HandymanTaxIdentityOwner, field: string): HandymanTaxIdentityOwner {
  keys(input,['kind','clientId','counterpartyId'],field);
  const clientId = uuid(input.clientId,`${field}.clientId`);
  if (input.kind === 'HANDYMAN_ISSUER') {
    if ('counterpartyId' in input) throw invalid(field);
    return { kind:'HANDYMAN_ISSUER',clientId };
  }
  if (input.kind === 'BM_BENEFICIARY') return { kind:'BM_BENEFICIARY',clientId,counterpartyId:uuid(input.counterpartyId,`${field}.counterpartyId`) };
  throw invalid(field);
}
function pin(input: PpnIdentityPin, field: string): PpnIdentityPin {
  keys(input,['owner','profileId','profileVersion','profileDigest','approvalDecisionId'],field);
  return { owner:owner(input.owner,`${field}.owner`), profileId:uuid(input.profileId,`${field}.profileId`),
    profileVersion:version(input.profileVersion,`${field}.profileVersion`),
    profileDigest:digest(input.profileDigest,`${field}.profileDigest`), approvalDecisionId:uuid(input.approvalDecisionId,`${field}.approvalDecisionId`) };
}
const MAX_IDR = 9_999_999_999_999_999n; // NUMERIC(18,2), whole-rupiah subset.
function money(input: unknown): bigint {
  if (typeof input !== 'string' || !/^(?:0|[1-9]\d{0,15})\.00$/.test(input)) throw invalid('sourceAmount');
  return BigInt(input.slice(0,-3));
}
function decimal(value: bigint): string {
  if (value < 0n || value > MAX_IDR) throw invalid('amount precision');
  return `${value}.00`;
}
export type NormalizedPpnInput = CalculateApprovedPpnInput & { sourceRupiah: bigint };
export function normalizePpnInput(input: CalculateApprovedPpnInput): NormalizedPpnInput {
  keys(input,['clientId','transactionContext','taxDate','taxPointAt','currency','amountBasis','sourceAmount',
    'applicability','taxpayerClassification','supplier','recipient','rule'],'input');
  const clientId = uuid(input.clientId,'clientId');
  if (input.transactionContext !== 'CUSTOMER_SERVICE_BILLING' && input.transactionContext !== 'BM_COMMISSION') throw invalid('transactionContext');
  // Legacy recipient pins cannot represent a customer; the request-bound path still needs approved buyer tax facts.
  if (input.transactionContext === 'CUSTOMER_SERVICE_BILLING') throw customerUnavailable();
  const taxDate = date(input.taxDate,'taxDate'), taxPointAt = instant(input.taxPointAt,'taxPointAt');
  if (new Date(new Date(taxPointAt).getTime() + 7 * 3_600_000).toISOString().slice(0,10) !== taxDate) throw invalid('taxDate/taxPointAt');
  if (input.currency !== 'IDR') throw invalid('currency');
  if (input.amountBasis !== 'PPN_EXCLUSIVE') throw unsupported('amount basis');
  if (!['TAXABLE','EXEMPT','NON_TAXABLE'].includes(input.applicability)) throw invalid('applicability');
  if (typeof input.taxpayerClassification !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(input.taxpayerClassification)) throw invalid('taxpayerClassification');
  const supplier = pin(input.supplier,'supplier'), recipient = pin(input.recipient,'recipient');
  keys(input.rule,['ruleId','ruleVersion','ruleDigest','approvalDecisionId'],'rule');
  const rule = { ruleId:uuid(input.rule.ruleId,'rule.ruleId'), ruleVersion:version(input.rule.ruleVersion,'rule.ruleVersion'),
    ruleDigest:digest(input.rule.ruleDigest,'rule.ruleDigest'), approvalDecisionId:uuid(input.rule.approvalDecisionId,'rule.approvalDecisionId') };
  if (supplier.owner.clientId !== clientId || recipient.owner.clientId !== clientId) throw mismatch();
  // The BM and issuer are approved identities, not proof of any particular contract or Building beneficiary.
  if (supplier.owner.kind !== 'BM_BENEFICIARY' || recipient.owner.kind !== 'HANDYMAN_ISSUER') throw mismatch();
  if (supplier.profileId === recipient.profileId) throw mismatch();
  return { ...input,clientId,taxDate,taxPointAt,supplier,recipient,rule,sourceRupiah:money(input.sourceAmount) };
}
/** Validate the prospective customer boundary without inventing a customer tax profile. */
export function normalizeCustomerPpnInput(input: CalculateCustomerPpnInput): CalculateCustomerPpnInput {
  keys(input,['clientId','transactionContext','taxDate','taxPointAt','currency','amountBasis','sourceAmount',
    'applicability','taxpayerClassification','supplier','requestId','buyer','rule'],'input');
  const clientId=uuid(input.clientId,'clientId'), requestId=uuid(input.requestId,'requestId');
  if(input.transactionContext!=='CUSTOMER_SERVICE_BILLING')throw invalid('transactionContext');
  const taxDate=date(input.taxDate,'taxDate'),taxPointAt=instant(input.taxPointAt,'taxPointAt');
  if(new Date(new Date(taxPointAt).getTime()+7*3_600_000).toISOString().slice(0,10)!==taxDate)throw invalid('taxDate/taxPointAt');
  if(input.currency!=='IDR')throw invalid('currency');
  if(input.amountBasis!=='PPN_EXCLUSIVE')throw unsupported('amount basis');
  if(!['TAXABLE','EXEMPT','NON_TAXABLE'].includes(input.applicability))throw invalid('applicability');
  if(typeof input.taxpayerClassification!=='string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(input.taxpayerClassification))throw invalid('taxpayerClassification');
  money(input.sourceAmount);
  const supplier=pin(input.supplier,'supplier');
  if(supplier.owner.kind!=='HANDYMAN_ISSUER' || supplier.owner.clientId!==clientId)throw mismatch();
  keys(input.rule,['ruleId','ruleVersion','ruleDigest','approvalDecisionId'],'rule');
  const rule={ruleId:uuid(input.rule.ruleId,'rule.ruleId'),ruleVersion:version(input.rule.ruleVersion,'rule.ruleVersion'),
    ruleDigest:digest(input.rule.ruleDigest,'rule.ruleDigest'),approvalDecisionId:uuid(input.rule.approvalDecisionId,'rule.approvalDecisionId')};
  return {...input,clientId,requestId,taxDate,taxPointAt,supplier,rule};
}
function ms(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) throw integrity();
  const n = Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== value) throw integrity();
  return n;
}
const hash = (snapshot: unknown) => createHash('sha256').update(stableJson(snapshot),'utf8').digest('hex');
function expectedOwnerId(value: HandymanTaxIdentityOwner): string {
  return value.kind === 'HANDYMAN_ISSUER' ? value.clientId : value.counterpartyId;
}
function validateIdentity(pinned: PpnIdentityPin, id: ApprovedHandymanTaxIdentity, at: number, cutoff: number): void {
  if (!id || id.digestAlgorithm !== 'SHA-256' || !id.snapshot || !id.approval || !id.taxUse ||
      id.taxUse.allowed !== true || id.taxUse.reason !== 'FINANCE_APPROVED') throw integrity();
  const p = id.snapshot, s = id.approval.submission, d = id.approval.decision, w = id.effectiveWindow;
  if (!s || !d || !w || p.schema !== 'HANDYMAN_TAX_IDENTITY_V1' || p.id !== pinned.profileId || p.version !== pinned.profileVersion ||
      p.clientId !== pinned.owner.clientId || p.ownerKind !== pinned.owner.kind || p.ownerId !== expectedOwnerId(pinned.owner) ||
      id.digest !== pinned.profileDigest || hash(p) !== id.digest || p.approvalStatus !== 'UNAPPROVED' ||
      d.id !== pinned.approvalDecisionId || d.eventType !== 'APPROVE' || s.eventType !== 'SUBMIT' || s.submissionId !== null ||
      d.submissionId !== s.id || s.profileId !== p.id || d.profileId !== p.id || s.clientId !== p.clientId || d.clientId !== p.clientId ||
      s.ownerKind !== p.ownerKind || d.ownerKind !== p.ownerKind || s.ownerId !== p.ownerId || d.ownerId !== p.ownerId ||
      s.approvedFrom !== null || s.approvedTo !== null ||
      s.profileVersion !== p.version || d.profileVersion !== p.version || s.profileDigest !== id.digest || d.profileDigest !== id.digest ||
      s.actorUserId === d.actorUserId || d.actorUserId === p.createdByUserId || !s.evidenceSource || !s.evidenceReference ||
      !d.evidenceSource || !d.evidenceReference || ms(d.occurredAt) <= ms(s.occurredAt) ||
      s.reviewFrom !== p.effectiveFrom || d.reviewFrom !== s.reviewFrom || d.reviewTo !== s.reviewTo ||
      !d.approvedFrom || d.approvedTo !== s.reviewTo || w.from !== p.effectiveFrom ||
      d.approvedFrom !== new Date(Math.max(ms(s.reviewFrom),ms(d.occurredAt))).toISOString() ||
      (s.reviewTo !== null && (w.identityWindowTo === null || ms(w.identityWindowTo) > ms(s.reviewTo)))) throw integrity();
  const expectedIdentityTo = w.closure ? w.closure.effectiveTo : p.declaredEffectiveTo;
  const expectedTo = w.issuerProfileSupersededAt &&
    (!w.identityWindowTo || ms(w.issuerProfileSupersededAt) < ms(w.identityWindowTo))
    ? w.issuerProfileSupersededAt : w.identityWindowTo;
  if (w.identityWindowTo !== expectedIdentityTo || w.to !== expectedTo ||
      (p.ownerKind === 'BM_BENEFICIARY' && w.issuerProfileSupersededAt !== null)) throw integrity();
  if ((p.ownerKind === 'HANDYMAN_ISSUER' && (p.ownerId !== p.clientId || !p.issuerProfileId || p.counterpartyId !== null || p.verificationId !== null)) ||
      (p.ownerKind === 'BM_BENEFICIARY' && (p.counterpartyId !== p.ownerId || !p.verificationId || p.issuerProfileId !== null)) ||
      p.taxpayerKind === 'UNKNOWN' || p.pkpStatus === 'UNKNOWN' || !p.identifierKind || !p.identifierValue ||
      (p.taxpayerKind === 'LEGAL_ENTITY' && p.individualResidency !== null) ||
      (p.taxpayerKind === 'INDIVIDUAL' && !['RESIDENT','NON_RESIDENT'].includes(p.individualResidency ?? ''))) throw mismatch();
  if (ms(d.occurredAt) > cutoff || ms(d.approvedFrom) > at) throw notApproved();
  if (ms(p.effectiveFrom) > at || (w.to !== null && at >= ms(w.to)) || (d.approvedTo !== null && at >= ms(d.approvedTo))) throw notApproved();
}
export function validateApprovedPpnIdentityPin(pinned: PpnIdentityPin, identity: ApprovedHandymanTaxIdentity,
  taxPointAt: string, readAt: string): void {
  const at=ms(taxPointAt);validateIdentity(pinned,identity,at,Math.min(at,ms(readAt)));
}
function identifierClash(a: ApprovedHandymanTaxIdentity, b: ApprovedHandymanTaxIdentity): boolean {
  const x = a.snapshot.identifierValue!, y = b.snapshot.identifierValue!;
  if (x === y) return true;
  return (a.snapshot.identifierKind === 'NPWP_15' && b.snapshot.identifierKind === 'NPWP_16' && y === `0${x}`) ||
    (b.snapshot.identifierKind === 'NPWP_15' && a.snapshot.identifierKind === 'NPWP_16' && x === `0${y}`);
}
type ClassKind = 'E' | 'IR' | 'IN';
function kind(id: ApprovedHandymanTaxIdentity): ClassKind {
  if (id.snapshot.taxpayerKind === 'LEGAL_ENTITY' && id.snapshot.individualResidency === null) return 'E';
  if (id.snapshot.taxpayerKind === 'INDIVIDUAL' && id.snapshot.individualResidency === 'RESIDENT') return 'IR';
  if (id.snapshot.taxpayerKind === 'INDIVIDUAL' && id.snapshot.individualResidency === 'NON_RESIDENT') return 'IN';
  throw mismatch();
}
function description(code: ClassKind): string {
  return code === 'E' ? 'ENTITY' : code === 'IR' ? 'INDIVIDUAL_RESIDENT' : 'INDIVIDUAL_NON_RESIDENT';
}
function classification(input: NormalizedPpnInput, supplier: ApprovedHandymanTaxIdentity, recipient: ApprovedHandymanTaxIdentity): string {
  const m = /^P02A_(TAX|EXEMPT|NON_TAX)_(E|IR|IN)_(P|N)_(E|IR|IN)_(P|N)_([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)$/.exec(input.taxpayerClassification);
  if (!m || m[6].length < 2 || m[6].length > 32 ||
      m[6].split('_').some(part => ['ANY','ALL','DEFAULT','UNKNOWN','UNSPECIFIED','NONE'].includes(part)))
    throw unsupported('taxpayer classification vocabulary');
  const app: PpnApplicability = m[1] === 'TAX' ? 'TAXABLE' : m[1] === 'EXEMPT' ? 'EXEMPT' : 'NON_TAXABLE';
  const sk = m[2] as ClassKind, rk = m[4] as ClassKind, sp = m[3] === 'P' ? 'PKP' : 'NON_PKP', rp = m[5] === 'P' ? 'PKP' : 'NON_PKP';
  if (input.applicability !== app || kind(supplier) !== sk || kind(recipient) !== rk ||
      supplier.snapshot.pkpStatus !== sp || recipient.snapshot.pkpStatus !== rp ||
      (app === 'TAXABLE' && supplier.snapshot.pkpStatus !== 'PKP')) throw mismatch();
  return `P02A_V1|APPLICABILITY=${app}|SUPPLIER=${description(sk)},${sp}|RECIPIENT=${description(rk)},${rp}|CASE=${m[6]}`;
}
type ApprovedRule = Extract<TaxRuleResolution, { status:'APPROVED' }>;
function validateRule(input: NormalizedPpnInput, resolved: ApprovedRule, cutoff: number, classDescription: string): void {
  if (!resolved || resolved.status !== 'APPROVED' || !resolved.rule || !resolved.approval) throw integrity();
  const rule = resolved.rule, p = rule.snapshot, s = resolved.approval.submission, d = resolved.approval.decision, w = rule.effectiveWindow;
  if (!p || !s || !d || !w || p.schema !== 'HANDYMAN_TAX_RULE_V1' || p.id !== input.rule.ruleId || p.version !== input.rule.ruleVersion ||
      rule.digestAlgorithm !== 'SHA-256' || rule.digest !== input.rule.ruleDigest || hash(p) !== rule.digest ||
      p.clientId !== input.clientId || p.transactionContext !== input.transactionContext || p.taxCode !== 'PPN' ||
      p.taxpayerClassification !== input.taxpayerClassification || p.classificationDescription !== classDescription ||
      d.id !== input.rule.approvalDecisionId || s.eventType !== 'SUBMIT' || s.submissionId !== null || s.sourceValidation !== null ||
      d.eventType !== 'APPROVE' || d.sourceValidation !== 'FINANCE_VALIDATED' || d.submissionId !== s.id ||
      s.ruleId !== p.id || d.ruleId !== p.id || s.clientId !== p.clientId || d.clientId !== p.clientId ||
      s.ruleVersion !== p.version || d.ruleVersion !== p.version || s.ruleDigest !== rule.digest || d.ruleDigest !== rule.digest ||
      s.actorUserId === d.actorUserId || d.actorUserId === p.createdByUserId || ms(d.occurredAt) <= ms(s.occurredAt) ||
      !p.legalReference || !p.legalSource || !p.evidenceSource || !p.evidenceReference ||
      !s.evidenceSource || !s.evidenceReference || !d.evidenceSource || !d.evidenceReference ||
      s.reviewFrom !== p.effectiveFrom || d.reviewFrom !== s.reviewFrom || d.reviewTo !== s.reviewTo || w.from !== p.effectiveFrom ||
      (w.closureId === null && w.to !== p.declaredEffectiveTo) || (w.closureId !== null && w.to === null) ||
      (p.declaredEffectiveTo !== null && (w.to === null || w.to > p.declaredEffectiveTo)) ||
      (s.reviewTo !== null && (w.to === null || w.to > s.reviewTo))) throw integrity();
  if (ms(d.occurredAt) > cutoff) throw notApproved();
  if (input.taxDate < p.effectiveFrom || (w.to !== null && input.taxDate >= w.to)) throw notApproved();
}
function rate(input: string): { numerator: bigint; denominator: bigint } {
  if (typeof input !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(input)) throw integrity();
  const [whole,fraction = ''] = input.split('.'), scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * scale + BigInt(fraction || '0');
  if (numerator > 100n * scale) throw integrity();
  return { numerator,denominator:100n * scale };
}
function round(n: bigint, d: bigint, mode: string): bigint {
  const q = n / d, r = n % d;
  if (!r) return q;
  if (mode === 'NO_ROUNDING') throw unsupported('inexact NO_ROUNDING result');
  if (mode === 'DOWN') return q;
  if (mode === 'UP') return q + 1n;
  if (mode === 'HALF_UP') return q + (r * 2n >= d ? 1n : 0n);
  if (mode === 'HALF_EVEN') return q + (r * 2n > d || (r * 2n === d && q % 2n === 1n) ? 1n : 0n);
  throw unsupported('rounding mode');
}
function identityReference(id: ApprovedHandymanTaxIdentity): PpnIdentityReference {
  const p = id.snapshot;
  return Object.freeze({ ownerKind:p.ownerKind,ownerId:p.ownerId,clientId:p.clientId,profileId:p.id,profileVersion:p.version,
    profileDigest:id.digest,issuerProfileId:p.issuerProfileId,counterpartyId:p.counterpartyId,verificationId:p.verificationId,
    evidenceSource:p.evidenceSource,evidenceReference:p.evidenceReference,createdByUserId:p.createdByUserId,
    taxpayerKind:p.taxpayerKind as 'LEGAL_ENTITY'|'INDIVIDUAL',
    individualResidency:p.individualResidency as 'RESIDENT'|'NON_RESIDENT'|null,pkpStatus:p.pkpStatus as 'PKP'|'NON_PKP',
    approval:Object.freeze({ submission:Object.freeze({ ...id.approval.submission }),decision:Object.freeze({ ...id.approval.decision }) }) });
}

/** Pure core for already resolved trusted snapshots; it does not establish database authenticity. */
export function calculatePpnFromResolved(input: NormalizedPpnInput, supplier: ApprovedHandymanTaxIdentity,
  recipient: ApprovedHandymanTaxIdentity, resolved: ApprovedRule, authorityAsOf: string): ApprovedPpnBreakdown {
  if (input.transactionContext === 'CUSTOMER_SERVICE_BILLING') throw customerUnavailable();
  const at = ms(input.taxPointAt), cutoff = Math.min(at,ms(authorityAsOf));
  validateIdentity(input.supplier,supplier,at,cutoff); validateIdentity(input.recipient,recipient,at,cutoff);
  if (identifierClash(supplier,recipient)) throw mismatch();
  const classDescription = classification(input,supplier,recipient);
  validateRule(input,resolved,cutoff,classDescription);
  const p = resolved.rule.snapshot, r = rate(p.ratePercent);
  if (!['HALF_UP','HALF_EVEN','DOWN','UP','NO_ROUNDING'].includes(p.roundingMode)) throw unsupported('rounding mode');
  if ((p.roundingMode === 'NO_ROUNDING' && p.roundingScale !== null) ||
      (p.roundingMode !== 'NO_ROUNDING' && p.roundingScale !== 0)) throw unsupported('IDR rounding scale');
  const full = 'P02A_V1|SOURCE=EXCLUSIVE|DPP=SOURCE|PPN=ROUND(DPP*RATE/100)|TOTAL=SOURCE+PPN';
  const exempt = 'P02A_V1|APPLICABILITY=EXEMPT|SOURCE=EXCLUSIVE|DPP=SOURCE|PPN=0|TOTAL=SOURCE';
  const nonTaxable = 'P02A_V1|APPLICABILITY=NON_TAXABLE|SOURCE=EXCLUSIVE|DPP=0|PPN=0|TOTAL=SOURCE';
  let dpp: bigint, ppn: bigint;
  if (p.basisMethodCode === 'PPN02A_EXCLUSIVE_FULL_V1') {
    if (input.applicability !== 'TAXABLE' || p.basisDescription !== full) throw unsupported('DPP method/description');
    dpp = input.sourceRupiah; ppn = round(dpp*r.numerator,r.denominator,p.roundingMode);
  } else {
    const ratio = /^PPN02A_EXCLUSIVE_RATIO_([1-9]\d{0,6})_([1-9]\d{0,6})_V1$/.exec(p.basisMethodCode);
    if (ratio) {
      const n = BigInt(ratio[1]), d = BigInt(ratio[2]);
      const desc = `P02A_V1|SOURCE=EXCLUSIVE|DPP=ROUND(SOURCE*${n}/${d})|PPN=ROUND(DPP*RATE/100)|TOTAL=SOURCE+PPN`;
      if (n > 1_000_000n || d > 1_000_000n || input.applicability !== 'TAXABLE' || p.basisDescription !== desc)
        throw unsupported('DPP method/description');
      dpp = round(input.sourceRupiah*n,d,p.roundingMode); ppn = round(dpp*r.numerator,r.denominator,p.roundingMode);
    } else if (p.basisMethodCode === 'PPN02A_EXEMPT_FULL_V1') {
      if (input.applicability !== 'EXEMPT' || r.numerator !== 0n || p.basisDescription !== exempt) throw unsupported('exemption');
      dpp = input.sourceRupiah; ppn = 0n;
    } else if (p.basisMethodCode === 'PPN02A_NON_TAXABLE_V1') {
      if (input.applicability !== 'NON_TAXABLE' || r.numerator !== 0n || p.basisDescription !== nonTaxable) throw unsupported('non-taxable treatment');
      dpp = 0n; ppn = 0n;
    } else throw unsupported('DPP method');
  }
  const body = Object.freeze({ schema:'HANDYMAN_PPN_CALCULATION_V1' as const,clientId:input.clientId,
    transactionContext:input.transactionContext,taxDate:input.taxDate,taxPointAt:input.taxPointAt,currency:'IDR' as const,
    amountBasis:'PPN_EXCLUSIVE' as const,applicability:input.applicability,taxpayerClassification:input.taxpayerClassification,
    sourceAmount:decimal(input.sourceRupiah),dppAmount:decimal(dpp),ppnRatePercent:p.ratePercent,ppnAmount:decimal(ppn),
    totalIncludingPpn:decimal(input.sourceRupiah+ppn),rounding:Object.freeze({ mode:p.roundingMode,
      scale:p.roundingScale as 0|null,stages:'DPP_THEN_PPN' as const }),basisMethodCode:p.basisMethodCode,
    rule:Object.freeze({ id:p.id,version:p.version,digest:resolved.rule.digest,legalReference:p.legalReference,legalSource:p.legalSource,
      classificationDescription:p.classificationDescription,basisDescription:p.basisDescription,evidenceSource:p.evidenceSource,
      evidenceReference:p.evidenceReference,createdByUserId:p.createdByUserId,
      approval:Object.freeze({ submission:Object.freeze({ ...resolved.approval.submission }),decision:Object.freeze({ ...resolved.approval.decision }) }) }),
    supplier:identityReference(supplier),recipient:identityReference(recipient),transactionPartyBinding:'CALLER_SUPPLIED_NOT_VERIFIED' as const });
  return Object.freeze({ ...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body) });
}
