import { AppError } from '../../shared/errors';
import {
  readHandymanLedgerTransactionAt,
  readHandymanLedgerClientBasisAt,
  HANDYMAN_LEDGER_READ_CONTRACT_VERSION,
  type HandymanLedgerReadAuthority,
} from '../handyman-customer-ledger-read';
import { readFinancialFactSets, type RawFinancialFactSet }
  from './handyman-financial-read.repository';
import {
  HANDYMAN_FINANCIAL_READ_CONTRACT_VERSION,
  type HandymanFinancialTransactionRead,
  type HandymanFinancialClientRead,
  type HandymanFinancialEntitlementFact,
  type HandymanFinancialEntitlementCorrection,
  type HandymanFinancialSettlementRead,
  type HandymanFinancialReadStatus,
  type HandymanFinancialRecordedState,
  type HandymanFinancialSettlementEvent,
  type HandymanFinancialReconciliation,
  type HandymanFinancialSettlementException,
  type ReadHandymanFinancialClientOptions,
  type HandymanFinancialNetBasis,
} from './handyman-financial-read.types';

/** CR-HM-14 PART 04: publication over posted facts only. This family
 * has zero write verbs, no transaction handle, no financial arithmetic,
 * and no command imports. Every ledger figure and gate comes verbatim
 * from CR-HM-13 PART 06; no client/caller money or state enters it.
 */
type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value as Row[] : [];
const text = (value: unknown): string => String(value);
const maybe = (value: unknown): string | null =>
  value === null || value === undefined ? null : text(value);
const iso = (value: unknown): string => new Date(text(value)).toISOString();
const maybeIso = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);

function mapCorrections(raw: RawFinancialFactSet): HandymanFinancialEntitlementCorrection[] {
  return rows(raw.corrections).map(row => ({
    id: text(row.id), entitlementId: text(row.entitlement_id),
    ledgerCorrectionId: text(row.ledger_correction_id),
    factKind: row.fact_kind as HandymanFinancialEntitlementCorrection['factKind'],
    amount: text(row.amount), actorUserId: text(row.actor_user_id),
    occurredAt: iso(row.occurred_at),
  }));
}
function mapEntitlements(raw: RawFinancialFactSet): HandymanFinancialEntitlementFact[] {
  const corrections = mapCorrections(raw);
  return rows(raw.entitlements).map(row => ({
    id: text(row.id), clientId: text(row.client_id),
    transactionId: text(row.transaction_id),
    executionScopeId: text(row.execution_scope_id),
    currency: text(row.currency), ledgerPostedAt: iso(row.ledger_posted_at),
    ledgerContractVersion: row.ledger_contract_version as 'CR-HM-13-PART-06',
    entitlementKind: row.entitlement_kind as HandymanFinancialEntitlementFact['entitlementKind'],
    factState: row.fact_state as 'EARNED',
    basisKind: row.basis_kind as HandymanFinancialEntitlementFact['basisKind'],
    chargedNet: text(row.charged_net), laborNet: text(row.labor_net),
    materialNet: text(row.material_net),
    adjustedTransactionScope: text(row.adjusted_transaction_scope),
    amount: text(row.amount),
    provider: row.entitlement_kind === 'PROVIDER' ? {
      assignmentId: text(row.assignment_id),
      providerContextId: text(row.provider_context_id),
      crewId: text(row.crew_id), leadWorkerId: text(row.lead_worker_id),
      leadUserId: text(row.lead_user_id),
    } : null,
    bmFee: row.entitlement_kind === 'BM_FEE' ? {
      agreementId: text(row.agreement_id),
      agreementVersionId: text(row.agreement_version_id),
      versionNumber: Number(row.agreement_version_number),
      effectiveFrom: iso(row.agreement_effective_from),
      effectiveTo: maybeIso(row.agreement_effective_to),
      ruleId: text(row.bm_rule_id), termId: text(row.bm_term_id),
      ratePercent: text(row.bm_term_rate_percent),
      beneficiaryId: text(row.bm_beneficiary_id),
      beneficiaryReferenceId: text(row.bm_beneficiary_reference_id),
    } : null,
    derivedByUserId: text(row.derived_by_user_id),
    derivedAt: iso(row.derived_at),
    corrections: corrections.filter(c => c.entitlementId === row.id),
  }));
}
function mapReconciliations(raw: RawFinancialFactSet): HandymanFinancialReconciliation[] {
  return rows(raw.reconciliations).map(row => ({
    id: text(row.id), sequence: text(row.reconciliation_seq),
    ledgerContractVersion: row.ledger_contract_version as 'CR-HM-13-PART-06',
    windowFrom: iso(row.window_from), windowTo: iso(row.window_to),
    currency: text(row.currency), ledgerChargedNet: text(row.ledger_charged_net),
    ledgerApplied: text(row.ledger_applied),
    ledgerNetReceived: text(row.ledger_net_received),
    entitlementTotal: text(row.entitlement_total),
    includedTotal: text(row.included_total),
    outcome: row.outcome as HandymanFinancialReconciliation['outcome'],
    varianceCause: row.variance_cause as HandymanFinancialReconciliation['varianceCause'],
    varianceAmount: text(row.variance_amount),
    actorUserId: text(row.actor_user_id), occurredAt: iso(row.occurred_at),
  }));
}
function mapSettlement(raw: RawFinancialFactSet): HandymanFinancialSettlementRead | null {
  if (!raw.unit) return null;
  const unit = raw.unit;
  const events: HandymanFinancialSettlementEvent[] = rows(raw.events).map(row => ({
    id: text(row.id), state: row.state as HandymanFinancialSettlementEvent['state'],
    reconciliationId: maybe(row.reconciliation_id),
    actorUserId: text(row.actor_user_id), occurredAt: iso(row.occurred_at),
  }));
  const reconciliations = mapReconciliations(raw);
  const exceptions: HandymanFinancialSettlementException[] =
    rows(raw.exceptions).map(row => ({
      id: text(row.id),
      exceptionKind: row.exception_kind as HandymanFinancialSettlementException['exceptionKind'],
      ledgerCorrectionId: maybe(row.ledger_correction_id),
      amount: text(row.amount), actorUserId: text(row.actor_user_id),
      occurredAt: iso(row.occurred_at),
    }));
  const recordedState: HandymanFinancialSettlementRead['recordedState'] =
    events.some(e => e.state === 'SETTLED') ? 'SETTLED'
      : events.some(e => e.state === 'INCLUDED_IN_SETTLEMENT')
        ? 'INCLUDED_IN_SETTLEMENT'
        : events.some(e => e.state === 'PAYABLE') ? 'PAYABLE'
          : 'NOT_RECORDED';
  return {
    unitId: text(unit.id), clientId: text(unit.client_id),
    transactionId: text(unit.transaction_id),
    executionScopeId: text(unit.execution_scope_id),
    currency: text(unit.currency), createdByUserId: text(unit.actor_user_id),
    createdAt: iso(unit.created_at), recordedState, events,
    inclusions: rows(raw.inclusions).map(row => ({
      id: text(row.id), entitlementId: text(row.entitlement_id),
      amount: text(row.amount), actorUserId: text(row.actor_user_id),
      occurredAt: iso(row.occurred_at),
    })),
    reconciliations, latestReconciliation: reconciliations.at(-1) ?? null,
    exceptions,
  };
}
function status(
  authority: HandymanLedgerReadAuthority,
  entitlements: HandymanFinancialEntitlementFact[],
  settlement: HandymanFinancialSettlementRead | null,
): HandymanFinancialReadStatus {
  if (!authority.authoritativeForEntitlement || authority.deniedBy.length > 0) {
    return 'LEDGER_NOT_AUTHORITATIVE';
  }
  if (!entitlements.some(f => f.entitlementKind === 'PROVIDER') ||
      !entitlements.some(f => f.entitlementKind === 'BM_FEE')) {
    return 'ENTITLEMENT_FACTS_MISSING';
  }
  if (settlement?.exceptions.length) return 'EXCEPTION_RECORDED';
  if (settlement?.latestReconciliation?.outcome === 'VARIANCE') {
    return 'RECONCILIATION_VARIANCE';
  }
  const state: HandymanFinancialRecordedState =
    settlement?.recordedState ?? 'EARNED';
  return state === 'NOT_RECORDED' ? 'ENTITLEMENT_FACTS_MISSING' : state;
}
function mapFinancial(
  transaction: HandymanFinancialTransactionRead['transaction'],
  authority: HandymanLedgerReadAuthority,
  netBasis: HandymanFinancialNetBasis,
  raw: RawFinancialFactSet,
): HandymanFinancialTransactionRead {
  // The ledger anchor, not caller identity or a join to another realm,
  // selects these facts. An inconsistent own-domain anchor fails closed.
  if (raw.transaction_id !== transaction.transactionId ||
      rows(raw.entitlements).some(r =>
        r.transaction_id !== transaction.transactionId ||
        r.client_id !== transaction.clientId ||
        r.currency !== transaction.currency ||
        r.execution_scope_id !== transaction.executionScopeId ||
        r.ledger_contract_version !== HANDYMAN_LEDGER_READ_CONTRACT_VERSION) ||
      (raw.unit && (
        raw.unit.transaction_id !== transaction.transactionId ||
        raw.unit.client_id !== transaction.clientId ||
        raw.unit.currency !== transaction.currency ||
        raw.unit.execution_scope_id !== transaction.executionScopeId))) {
    throw AppError.internal('Financial read anchors are inconsistent.');
  }
  const entitlements = mapEntitlements(raw);
  const settlement = mapSettlement(raw);
  return {
    contractVersion: HANDYMAN_FINANCIAL_READ_CONTRACT_VERSION,
    ledgerContractVersion: HANDYMAN_LEDGER_READ_CONTRACT_VERSION,
    readOnly: true, transaction, authority, status: status(authority,entitlements,settlement),
    netBasis, entitlements, settlement,
  };
}

/** Exact authority-walled transaction. Historical facts remain visible
 * when the current ledger gate is false, but status is NOT_AUTHORITATIVE.
 * No financial decision may be made using this informational shape.
 */
export async function readHandymanFinancialTransactionAt(
  executionScopeId: string, actorUserId: string,
): Promise<HandymanFinancialTransactionRead> {
  const ledger = await readHandymanLedgerTransactionAt(executionScopeId,actorUserId);
  const id = ledger.transaction.transactionId;
  const factSet = (await readFinancialFactSets([id]))[0];
  if (!factSet) throw AppError.internal('Financial fact snapshot missing.');
  return mapFinancial({
    transactionId:id, executionScopeId:ledger.transaction.executionScopeId,
    clientId:ledger.transaction.clientId, currency:ledger.transaction.currency,
    openedAt:ledger.transaction.createdAt,
  }, ledger.authority, {
    chargedNet:ledger.totals.chargedNet, laborNet:ledger.totals.laborNet,
    materialNet:ledger.totals.materialNet, applied:ledger.totals.applied,
    netReceived:ledger.totals.netReceived,
    outstanding:ledger.totals.outstanding,
  }, factSet);
}

/** Windowed client read. The published ledger contract owns input
 * validation, actor wall, maximum 500 entries and net authority gate.
 * Non-authoritative IDs are explicitly excluded, never aggregated.
 */
export async function readHandymanFinancialClientAt(
  clientId: string, actorUserId: string,
  options: ReadHandymanFinancialClientOptions = {},
): Promise<HandymanFinancialClientRead> {
  const ledger = await readHandymanLedgerClientBasisAt(clientId,actorUserId,options);
  const excluded = new Set(ledger.authority.nonAuthoritativeTransactionIds);
  const entries = ledger.transactions.filter(t =>
    t.authority.authoritativeForEntitlement && !excluded.has(t.transactionId));
  const facts = await readFinancialFactSets(entries.map(t => t.transactionId));
  const byTransaction = new Map(facts.map(f => [f.transaction_id,f]));
  const transactions = entries.map(entry => {
    const factSet = byTransaction.get(entry.transactionId);
    if (!factSet) throw AppError.internal('Financial fact snapshot missing.');
    return mapFinancial({
      transactionId:entry.transactionId, executionScopeId:entry.executionScopeId,
      clientId:ledger.clientId, currency:entry.currency,
      openedAt:entry.openedAt,
    }, entry.authority, {
      chargedNet:entry.chargedNet, laborNet:entry.laborNet,
      materialNet:entry.materialNet, applied:entry.applied,
      netReceived:entry.netReceived, outstanding:entry.outstanding,
    }, factSet);
  });
  return {
    contractVersion:HANDYMAN_FINANCIAL_READ_CONTRACT_VERSION,
    ledgerContractVersion:HANDYMAN_LEDGER_READ_CONTRACT_VERSION,
    readOnly:true,clientId:ledger.clientId,
    from:ledger.from,to:ledger.to,limit:ledger.limit,
    authority:ledger.authority,transactions,
    excludedTransactionIds:ledger.authority.nonAuthoritativeTransactionIds,
  };
}
