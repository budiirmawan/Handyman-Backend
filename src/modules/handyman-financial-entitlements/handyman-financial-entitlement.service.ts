import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  readHandymanLedgerTransactionAt,
  HANDYMAN_LEDGER_READ_CONTRACT_VERSION,
  type HandymanLedgerTransactionRead,
} from '../handyman-customer-ledger-read';
import { readHandymanBmFeeConfigurationAt }
  from '../handyman-pricing-contract';
import {
  getHandymanExecutionScopeAssignment,
  resolveHandymanAssignmentLead,
} from '../handyman-scope-assignments';
import {
  findByKey, findFact, insertFact, lockEntitlementTransaction,
  readAttribution, listCorrections, findCorrectionKey, insertCorrection,
  type FactInput, type FactRow, type CorrectionRow,
} from './handyman-financial-entitlement.repository';

/** CR-HM-14 PART 02. Internal command, no HTTP or caller financial fields.
 * Amounts are derived from correction-netted published reads, never from
 * the customer ledger's SQL tables or a caller's money/identity payload.
 */
function failure(code: keyof Pick<typeof ERROR_CODES,
  'HANDYMAN_ENTITLEMENT_INVALID' | 'HANDYMAN_ENTITLEMENT_LEDGER_NOT_AUTHORITATIVE' |
  'HANDYMAN_ENTITLEMENT_ATTRIBUTION_UNRESOLVED' |
  'HANDYMAN_ENTITLEMENT_BM_NOT_AUTHORITATIVE' | 'HANDYMAN_ENTITLEMENT_CONFLICT'>,
message: string, statusCode = 409): AppError {
  return new AppError({ code: ERROR_CODES[code], message, statusCode });
}
const invalid = () => failure('HANDYMAN_ENTITLEMENT_INVALID',
  'Invalid entitlement command.', 400);
const conflict = () => failure('HANDYMAN_ENTITLEMENT_CONFLICT',
  'Entitlement already exists for another key or a changed input set.');
const attribution = () => failure('HANDYMAN_ENTITLEMENT_ATTRIBUTION_UNRESOLVED',
  'MULTI_PROVIDER_ATTRIBUTION_UNRESOLVED or no active provider assignment.');
const bmBlocked = () => failure('HANDYMAN_ENTITLEMENT_BM_NOT_AUTHORITATIVE',
  'Exact-version DEFAULT BM fee term and beneficiary are required.');

function cents(text: string): bigint {
  if (!/^(0|[1-9]\d{0,15})\.\d{2}$/.test(text)) throw invalid();
  const [whole, fraction] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
}
function decimal(n: bigint): string {
  if (n < 0n || n > 999999999999999999n) throw conflict();
  return `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
}
function feeCents(labor: bigint, rate: string): bigint {
  // Four decimal places of PERCENT, preserving fractional basis points.
  // e.g. 2.5001% = 25001 hundredths of a bp; one half-up rounding at
  // the fact boundary, no floating-point multiplication or proration.
  if (!/^(?:0?\d{1,2}|100)\.\d{4}$/.test(rate)) throw bmBlocked();
  const [whole, fractional] = rate.split('.');
  const scaled = BigInt(whole) * 10000n + BigInt(fractional);
  if (scaled <= 0n || scaled > 1000000n) throw bmBlocked();
  return (labor * scaled + 500000n) / 1000000n;
}
function assertLedger(read: HandymanLedgerTransactionRead, scopeId: string): void {
  if (read.contractVersion !== HANDYMAN_LEDGER_READ_CONTRACT_VERSION ||
      read.transaction.executionScopeId !== scopeId ||
      read.authority.authoritativeForEntitlement !== true ||
      read.authority.deniedBy.length !== 0) {
    throw failure('HANDYMAN_ENTITLEMENT_LEDGER_NOT_AUTHORITATIVE',
      'Ledger is not authoritative for entitlement.');
  }
}
function same(row: FactRow, x: FactInput): boolean {
  const eqDate = (d: Date | null, iso?: string | null) =>
    (d?.toISOString() ?? null) === (iso ?? null);
  return row.idempotency_key === x.idempotencyKey &&
    row.entitlement_kind === x.kind && row.transaction_id === x.transactionId &&
    row.execution_scope_id === x.executionScopeId && row.client_id === x.clientId &&
    row.currency === x.currency && row.derived_by_user_id === x.actorUserId &&
    row.ledger_contract_version === HANDYMAN_LEDGER_READ_CONTRACT_VERSION &&
    eqDate(row.ledger_posted_at, x.ledgerPostedAt) &&
    row.charged_net === x.chargedNet && row.labor_net === x.laborNet &&
    row.material_net === x.materialNet &&
    row.adjusted_transaction_scope === x.adjustedTransactionScope &&
    row.amount === x.amount &&
    row.assignment_id === (x.assignmentId ?? null) &&
    row.provider_context_id === (x.providerContextId ?? null) &&
    row.crew_id === (x.crewId ?? null) &&
    row.lead_worker_id === (x.leadWorkerId ?? null) &&
    row.lead_user_id === (x.leadUserId ?? null) &&
    row.agreement_id === (x.agreementId ?? null) &&
    row.agreement_version_id === (x.agreementVersionId ?? null) &&
    row.agreement_version_number === (x.versionNumber ?? null) &&
    eqDate(row.agreement_effective_from, x.effectiveFrom) &&
    eqDate(row.agreement_effective_to, x.effectiveTo) &&
    row.bm_rule_id === (x.ruleId ?? null) &&
    row.bm_term_id === (x.termId ?? null) &&
    row.bm_term_rate_percent === (x.ratePercent ?? null) &&
    row.bm_beneficiary_id === (x.beneficiaryId ?? null) &&
    row.bm_beneficiary_reference_id === (x.beneficiaryReferenceId ?? null);
}

export type DerivedFinancialEntitlements = {
  provider: { id: string; amount: string; replayed: boolean };
  bmFee: { id: string; amount: string; replayed: boolean };
};

/** One atomic two-kind derivation. Missing/REFERENCE/unconfigured BM
 * prevents BOTH writes: never silently allocate the entire base to a
 * provider then later add a fee on top. No funding/settlement assertion.
 */
export async function deriveHandymanFinancialEntitlements(
  executionScopeId: string,
  actorUserId: string,
  idempotencyKey: string,
): Promise<DerivedFinancialEntitlements> {
  if (typeof executionScopeId !== 'string' || !isValidUuid(executionScopeId) ||
      typeof actorUserId !== 'string' || !isValidUuid(actorUserId) ||
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.trim() !== idempotencyKey ||
      idempotencyKey.length < 1 || idempotencyKey.length > 185) throw invalid();

  // The published read enforces the authenticated actor/client wall.
  const initial = await readHandymanLedgerTransactionAt(executionScopeId, actorUserId);
  assertLedger(initial, executionScopeId);
  return withTransaction(async (tx) => {
    const transactionId = await lockEntitlementTransaction(tx, executionScopeId);
    if (!transactionId || transactionId !== initial.transaction.transactionId) throw conflict();
    // Fresh read AFTER the ledger lock: concurrent correction writers
    // cannot alter the basis between this read and the two INSERTs.
    const ledger = await readHandymanLedgerTransactionAt(executionScopeId, actorUserId);
    assertLedger(ledger, executionScopeId);
    if (ledger.transaction.transactionId !== transactionId) throw conflict();
    const assignment = await getHandymanExecutionScopeAssignment(
      executionScopeId, actorUserId);
    if (!assignment || assignment.status !== 'ACTIVE' ||
        assignment.clientId !== ledger.transaction.clientId) throw attribution();
    const { assignments, sessions } = await readAttribution(tx, executionScopeId);
    if (new Set(assignments.map(a => a.handyman_provider_context_id)).size !== 1 ||
        !assignments.some(a => a.id === assignment.id)) throw attribution();
    const lead = await resolveHandymanAssignmentLead(executionScopeId, actorUserId);
    if (!lead || lead.assignmentId !== assignment.id ||
        lead.crewId !== assignment.handymanCrewId ||
        sessions.some(s => s.assignment_id !== assignment.id ||
                           s.lead_worker_id !== lead.leadWorkerContextId)) {
      throw attribution();
    }

    // No unscoped adjustment/refund/reversal may be prorated onto LABOR.
    const lineIds = new Set(ledger.chargeLines.map(l => l.chargeLineId));
    if (ledger.corrections.some(c => !c.sourceChargeLineId ||
        !lineIds.has(c.sourceChargeLineId))) throw bmBlocked();
    const configuration = await readHandymanBmFeeConfigurationAt(
      ledger.transaction.clientId, ledger.transaction.createdAt).catch((err: unknown) => {
        if (err instanceof AppError && (
          err.code === ERROR_CODES.HANDYMAN_BM_FEE_RULE_NOT_EFFECTIVE ||
          err.code === ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF ||
          err.code === ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_FOUND)) {
          throw bmBlocked();
        }
        throw err;
      });
    const { binding, rule, term, beneficiary } = configuration;
    if (!configuration.authoritativeForEntitlement ||
        configuration.unconfiguredSlots.length || !term || !beneficiary ||
        rule.mode !== 'DEFAULT' || !rule.authoritativeForEntitlement ||
        rule.basis !== 'LABOR_ONLY' ||
        term.termKind !== 'PERCENTAGE_OF_BASIS' ||
        beneficiary.beneficiaryKind !== 'CLIENT_ORGANIZATION' ||
        beneficiary.beneficiaryReferenceId !== ledger.transaction.clientId ||
        binding.clientId !== ledger.transaction.clientId ||
        binding.requestedAsOfUtc !== ledger.transaction.createdAt ||
        !binding.effectiveFromUtc ||
        [rule.agreementVersionId, term.agreementVersionId,
          beneficiary.agreementVersionId].some(id => id !== binding.agreementVersionId)) {
      throw bmBlocked();
    }

    const charged = cents(ledger.totals.chargedNet);
    const labor = cents(ledger.totals.laborNet);
    const material = cents(ledger.totals.materialNet);
    cents(ledger.totals.adjustedTransactionScope);
    if (charged < 0n || labor < 0n || material < 0n) throw conflict();
    const fee = feeCents(labor, term.ratePercent);
    if (fee > labor || fee > charged) throw conflict();
    const common = {
      clientId: ledger.transaction.clientId,
      transactionId, executionScopeId,
      currency: ledger.transaction.currency,
      ledgerPostedAt: ledger.transaction.createdAt,
      chargedNet: ledger.totals.chargedNet,
      laborNet: ledger.totals.laborNet,
      materialNet: ledger.totals.materialNet,
      adjustedTransactionScope: ledger.totals.adjustedTransactionScope,
      actorUserId,
    };
    const provider: FactInput = {
      ...common, kind: 'PROVIDER', amount: decimal(charged - fee),
      assignmentId: assignment.id,
      providerContextId: assignment.handymanProviderContextId,
      crewId: assignment.handymanCrewId,
      leadWorkerId: lead.leadWorkerContextId, leadUserId: lead.leadUserId,
      idempotencyKey: `${idempotencyKey}:PROVIDER`,
    };
    const bm: FactInput = {
      ...common, kind: 'BM_FEE', amount: decimal(fee),
      agreementId: binding.agreementId,
      agreementVersionId: binding.agreementVersionId,
      versionNumber: binding.versionNumber,
      effectiveFrom: binding.effectiveFromUtc,
      effectiveTo: binding.effectiveToUtc,
      ruleId: rule.ruleRowId, termId: term.termRowId,
      ratePercent: term.ratePercent,
      beneficiaryId: beneficiary.beneficiaryRowId,
      beneficiaryReferenceId: beneficiary.beneficiaryReferenceId,
      idempotencyKey: `${idempotencyKey}:BM_FEE`,
    };
    const facts: Array<{ row: FactRow; replayed: boolean }> = [];
    const previous = await Promise.all([findFact(tx, transactionId, 'PROVIDER'),
      findFact(tx, transactionId, 'BM_FEE')]);
    // An already-earned claim is never rewritten. One new governed
    // correction cause can produce one forward delta per kind; a
    // multi-cause gap is undecidable without inventing a proration.
    if (Boolean(previous[0]) !== Boolean(previous[1])) throw conflict();
    const changed = previous.some((row, i) => row &&
      row.amount !== [provider, bm][i].amount);
    for (const input of [provider, bm]) {
      const existing = previous[input.kind === 'PROVIDER' ? 0 : 1];
      const keyOwner = await findByKey(tx, input.idempotencyKey);
      if (keyOwner && keyOwner.id !== existing?.id) throw conflict();
      if (!existing) {
        if (changed || keyOwner) throw conflict();
        try {
          facts.push({ row: await insertFact(tx, input), replayed: false });
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw conflict();
          throw err;
        }
        continue;
      }
      const bound: FactInput = {
        ...input, chargedNet: existing.charged_net, laborNet: existing.labor_net,
        materialNet: existing.material_net,
        adjustedTransactionScope: existing.adjusted_transaction_scope,
        amount: existing.amount, idempotencyKey: existing.idempotency_key,
        actorUserId: existing.derived_by_user_id,
      };
      if (!same(existing, bound)) throw conflict();
      const deltas = await listCorrections(tx, existing.id);
      const live = deltas.reduce((n, d) => n +
        (d.fact_kind === 'ADJUSTED_INCREASE' ? cents(d.amount) : -cents(d.amount)),
      cents(existing.amount));
      const target = cents(input.amount);
      if (deltas.some(d => d.fact_kind === 'REVERSED') && target !== 0n) {
        throw conflict();
      }
      if (target === live) {
        const correctionReplay = await findCorrectionKey(tx, input.idempotencyKey);
        if (correctionReplay && correctionReplay.entitlement_id !== existing.id) throw conflict();
        if (target !== cents(existing.amount) && !correctionReplay) throw conflict();
        if (!changed && !same(existing, input) && !correctionReplay) throw conflict();
        if (keyOwner && !same(existing, input)) throw conflict();
        facts.push({ row: existing, replayed: true });
        continue;
      }
      if (keyOwner) throw conflict();
      const correctionKeyOwner = await findCorrectionKey(tx, input.idempotencyKey);
      if (correctionKeyOwner) throw conflict();
      const recorded = new Set(deltas.map(d => d.ledger_correction_id));
      const relevant = ledger.corrections.filter(c =>
        new Date(c.occurredAt) > existing.derived_at &&
        c.correctionKind === 'ADJUSTMENT' &&
        c.sourceChargeLineId &&
        (input.kind === 'PROVIDER' ||
         ledger.chargeLines.some(l => l.chargeLineId === c.sourceChargeLineId &&
                                    l.lineKind === 'LABOR')) &&
        !recorded.has(c.correctionId));
      if (relevant.length !== 1) throw conflict();
      const kind: CorrectionRow['fact_kind'] = target === 0n
        ? 'REVERSED' : target > live ? 'ADJUSTED_INCREASE' : 'ADJUSTED_DECREASE';
      const magnitude = target > live ? target - live : live - target;
      try {
        await insertCorrection(tx, {
          entitlementId: existing.id, ledgerCorrectionId: relevant[0].correctionId,
          kind, amount: decimal(magnitude), key: input.idempotencyKey,
          actorUserId,
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict();
        throw err;
      }
      facts.push({ row: existing, replayed: false });
    }
    return {
      provider: { id: facts[0].row.id, amount: provider.amount,
        replayed: facts[0].replayed },
      bmFee: { id: facts[1].row.id, amount: bm.amount,
        replayed: facts[1].replayed },
    };
  });
}
