import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  readHandymanLedgerTransactionAt, readHandymanLedgerClientBasisAt,
  HANDYMAN_LEDGER_READ_CONTRACT_VERSION,
  type HandymanLedgerTransactionRead,
} from '../handyman-customer-ledger-read';
import { findFact, listCorrections } from '../handyman-financial-entitlements/handyman-financial-entitlement.repository';
import * as repo from './handyman-settlement.repository';

/** CR-HM-14 PART 03. Internal only: settlement means a recorded state,
 * never movement of funds. No caller supplies a monetary value, status,
 * currency, beneficiary, external statement or ledger result.
 */
function error(code: keyof Pick<typeof ERROR_CODES,
  'HANDYMAN_SETTLEMENT_INVALID' | 'HANDYMAN_SETTLEMENT_NOT_FOUND' |
  'HANDYMAN_SETTLEMENT_CONFLICT' | 'HANDYMAN_SETTLEMENT_NOT_FUNDED' |
  'HANDYMAN_SETTLEMENT_NOT_AUTHORITATIVE' | 'HANDYMAN_SETTLEMENT_VARIANCE'>,
  message: string, statusCode = 409) {
  return new AppError({ code: ERROR_CODES[code], message, statusCode });
}
const conflict = () => error('HANDYMAN_SETTLEMENT_CONFLICT',
  'Settlement state, command key or immutable financial anchors conflict.');
const unfunded = () => error('HANDYMAN_SETTLEMENT_NOT_FUNDED',
  'Entitlements exceed collected, unrefunded ledger funds.');
const unavailable = () => error('HANDYMAN_SETTLEMENT_NOT_AUTHORITATIVE',
  'The exact ledger is not authoritative for this settlement decision.');
const variance = () => error('HANDYMAN_SETTLEMENT_VARIANCE',
  'Reconciliation has an unresolved variance or exception.');

function cents(s: string): bigint {
  if (!/^(0|[1-9]\d{0,15})\.\d{2}$/.test(s)) throw conflict();
  const [whole, fraction] = s.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
}
function money(n: bigint): string {
  if (n < 0n || n > 999999999999999999n) throw conflict();
  return `${n / 100n}.${(n % 100n).toString().padStart(2,'0')}`;
}
function abs(n: bigint) { return n >= 0n ? n : -n; }
function keyInput(scope: string, actor: string, key: string,
  cause?: string): void {
  if (typeof scope !== 'string' || !isValidUuid(scope) ||
      typeof actor !== 'string' || !isValidUuid(actor) ||
      typeof key !== 'string' || key.trim() !== key ||
      key.length < 1 || key.length > 175 ||
      (cause !== undefined && (typeof cause !== 'string' || !isValidUuid(cause)))) {
    throw error('HANDYMAN_SETTLEMENT_INVALID', 'Invalid settlement reference or key.', 400);
  }
}
function assertAuthoritative(ledger: HandymanLedgerTransactionRead, scope: string) {
  if (ledger.readOnly !== true ||
      ledger.contractVersion !== HANDYMAN_LEDGER_READ_CONTRACT_VERSION ||
      ledger.transaction.executionScopeId !== scope ||
      ledger.authority.authoritativeForEntitlement !== true ||
      ledger.authority.deniedBy.length !== 0) throw unavailable();
}
async function context<T>(scope: string, actor: string,
  work: (tx: PoolClient, ledger: HandymanLedgerTransactionRead,
    unit: repo.Unit | null) => Promise<T>, requireGate = true): Promise<T> {
  // The published read provides the authenticated local actor/client wall.
  const before = await readHandymanLedgerTransactionAt(scope, actor);
  if (requireGate) assertAuthoritative(before, scope);
  return withTransaction(async (tx) => {
    const id = await repo.lockTransaction(tx, scope);
    if (id !== before.transaction.transactionId) throw conflict();
    const ledger = await readHandymanLedgerTransactionAt(scope, actor);
    if (ledger.transaction.transactionId !== id) throw conflict();
    if (requireGate) assertAuthoritative(ledger, scope);
    return work(tx, ledger, await repo.getUnit(tx, id));
  });
}
async function replay(tx: PoolClient, key: string, action: repo.Action,
  unit: repo.Unit | null, actor: string) {
  const found = await repo.getKey(tx, key);
  if (!found) return null;
  if (!unit || found.unit_id !== unit.id || found.action !== action ||
      found.actor_user_id !== actor) throw conflict();
  return found;
}
function assertUnit(unit: repo.Unit | null,
  ledger: HandymanLedgerTransactionRead): asserts unit is repo.Unit {
  if (!unit) throw error('HANDYMAN_SETTLEMENT_NOT_FOUND',
    'No settlement unit exists for the transaction.', 404);
  if (unit.client_id !== ledger.transaction.clientId ||
      unit.transaction_id !== ledger.transaction.transactionId ||
      unit.execution_scope_id !== ledger.transaction.executionScopeId ||
      unit.currency !== ledger.transaction.currency) throw conflict();
}
async function state(tx: PoolClient, unit: repo.Unit) {
  const facts = await repo.transitions(tx, unit.id);
  if (facts.find(f => f.state === 'SETTLED')) return 'SETTLED' as const;
  if (facts.find(f => f.state === 'INCLUDED_IN_SETTLEMENT')) {
    return 'INCLUDED_IN_SETTLEMENT' as const;
  }
  if (facts.find(f => f.state === 'PAYABLE')) return 'PAYABLE' as const;
  throw conflict();
}
async function clearExceptions(tx: PoolClient, unit: repo.Unit) {
  if ((await repo.exceptions(tx, unit.id)).length !== 0) throw variance();
}

/** Projection over PART 02 EARNED + immutable corrections, not a
 * re-derivation. Each correction cause must be visible in the published
 * ledger. Sum is checked in cents and never inferred from gross charges.
 */
async function earned(tx: PoolClient, ledger: HandymanLedgerTransactionRead,
  allowDrift = false) {
  const result: { id: string; kind: 'PROVIDER' | 'BM_FEE'; amount: bigint }[] = [];
  const knownCauses = new Set(ledger.corrections.map(c => c.correctionId));
  for (const kind of ['PROVIDER','BM_FEE'] as const) {
    const row = await findFact(tx, ledger.transaction.transactionId, kind);
    if (!row || row.client_id !== ledger.transaction.clientId ||
        row.execution_scope_id !== ledger.transaction.executionScopeId ||
        row.currency !== ledger.transaction.currency ||
        row.ledger_contract_version !== HANDYMAN_LEDGER_READ_CONTRACT_VERSION) {
      throw conflict();
    }
    let amount = cents(row.amount);
    for (const change of await listCorrections(tx, row.id)) {
      if (!knownCauses.has(change.ledger_correction_id)) throw conflict();
      amount += change.fact_kind === 'ADJUSTED_INCREASE'
        ? cents(change.amount) : -cents(change.amount);
    }
    if (amount < 0n) throw conflict();
    if (!allowDrift && kind === 'BM_FEE' &&
        amount > cents(ledger.totals.laborNet)) throw conflict();
    result.push({ id: row.id, kind, amount });
  }
  const total = result[0].amount + result[1].amount;
  if (!allowDrift && total > cents(ledger.totals.chargedNet)) throw conflict();
  return { facts: result, total };
}
function available(ledger: HandymanLedgerTransactionRead) {
  const applied = cents(ledger.totals.applied);
  const received = cents(ledger.totals.netReceived);
  return applied < received ? applied : received;
}
function funded(ledger: HandymanLedgerTransactionRead, claim: bigint) {
  if (claim <= 0n || claim > available(ledger)) throw unfunded();
}
function exact(ledger: HandymanLedgerTransactionRead,
  claim: bigint) {
  if (claim !== cents(ledger.totals.chargedNet)) throw conflict();
}
async function included(tx: PoolClient, unit: repo.Unit,
  facts: Awaited<ReturnType<typeof earned>>) {
  const rows = await repo.inclusions(tx, unit.id);
  const total = rows.reduce((n, row) => n + cents(row.amount), 0n);
  const exactPair = rows.length === 2 && facts.facts.every(f =>
    f.amount > 0n && rows.some(r => r.entitlement_id === f.id &&
      cents(r.amount) === f.amount));
  return { rows, total, exactPair };
}
async function clientWindow(ledger: HandymanLedgerTransactionRead, actor: string) {
  const from = ledger.transaction.createdAt;
  const to = new Date(new Date(from).getTime() + 1).toISOString();
  const basis = await readHandymanLedgerClientBasisAt(
    ledger.transaction.clientId, actor, { from, to, limit: 500 });
  const entry = basis.transactions.find(t =>
    t.transactionId === ledger.transaction.transactionId);
  if (basis.contractVersion !== HANDYMAN_LEDGER_READ_CONTRACT_VERSION ||
      !entry || !entry.authority.authoritativeForEntitlement ||
      basis.authority.nonAuthoritativeTransactionIds.includes(
        ledger.transaction.transactionId) ||
      entry.chargedNet !== ledger.totals.chargedNet ||
      entry.applied !== ledger.totals.applied ||
      entry.netReceived !== ledger.totals.netReceived) throw unavailable();
  return { from, to };
}
function mapUnique(err: unknown): never {
  if ((err as { code?: string }).code === '23505') throw conflict();
  throw err;
}

/** EARNED is implicit in PART 02; the first append-only transition is
 * PAYABLE, only when BOTH claims are fully covered by collected funds.
 * Partial payment is not called PAYABLE or silently prorated.
 */
export async function prepareHandymanSettlement(scope: string, actor: string,
  key: string) {
  keyInput(scope, actor, key);
  return context(scope, actor, async (tx, ledger, existing) => {
    const prior = await replay(tx,key,'PREPARE',existing,actor);
    if (prior) return { unitId: prior.result_id, state: 'PAYABLE' as const,
      replayed: true };
    if (existing) throw conflict();
    const e = await earned(tx,ledger);
    exact(ledger,e.total);
    if (e.facts.some(f => f.amount <= 0n)) throw unfunded();
    funded(ledger,e.total);
    try {
      const unit = await repo.createUnit(tx, {
        clientId: ledger.transaction.clientId,
        transactionId: ledger.transaction.transactionId,
        executionScopeId: scope, currency: ledger.transaction.currency,
        key, actorId: actor,
      });
      await repo.createTransition(tx,unit.id,'PAYABLE',`${key}:PAYABLE`,actor);
      await repo.putKey(tx,key,unit.id,'PREPARE',unit.id,actor);
      return { unitId: unit.id, state: 'PAYABLE' as const, replayed: false };
    } catch (err) { mapUnique(err); }
  });
}

/** A unique inclusion per immutable entitlement, one-currency unit.
 * Inclusion amounts come from the live corrected PART 02 facts only.
 */
export async function includeHandymanSettlement(scope: string, actor: string,
  key: string) {
  keyInput(scope,actor,key);
  return context(scope,actor,async (tx,ledger,unit) => {
    assertUnit(unit,ledger);
    const prior = await replay(tx,key,'INCLUDE',unit,actor);
    if (prior) return { unitId: unit.id, state: 'INCLUDED_IN_SETTLEMENT' as const,
      replayed: true };
    if (await state(tx,unit) !== 'PAYABLE') throw conflict();
    await clearExceptions(tx,unit);
    const e = await earned(tx,ledger);
    exact(ledger,e.total);
    if (e.facts.some(f => f.amount <= 0n)) throw unfunded();
    funded(ledger,e.total);
    try {
      for (const f of e.facts) {
        await repo.createInclusion(tx,unit.id,f.id,money(f.amount),
          `${key}:${f.kind}`,actor);
      }
      const ev = await repo.createTransition(tx,unit.id,
        'INCLUDED_IN_SETTLEMENT',key,actor);
      await repo.putKey(tx,key,unit.id,'INCLUDE',ev.id,actor);
      return { unitId: unit.id, state: ev.state, replayed: false };
    } catch (err) { mapUnique(err); }
  });
}

/** Bounded, versioned client-window comparison. A variance is itself
 * an immutable result, never a silent correction of an inclusion.
 */
export async function reconcileHandymanSettlement(scope: string, actor: string,
  key: string) {
  keyInput(scope,actor,key);
  return context(scope,actor,async (tx,ledger,unit) => {
    assertUnit(unit,ledger);
    const prior = await replay(tx,key,'RECONCILE',unit,actor);
    if (prior) {
      const run = await repo.getReconciliationById(tx,prior.result_id);
      if (!run) throw conflict();
      return { id: run.id, outcome: run.outcome, cause: run.variance_cause,
        variance: run.variance_amount, replayed: true };
    }
    const current = await state(tx,unit);
    if (current !== 'INCLUDED_IN_SETTLEMENT' && current !== 'SETTLED') {
      throw conflict();
    }
    const { from,to } = await clientWindow(ledger,actor);
    const e = await earned(tx,ledger,true);
    const i = await included(tx,unit,e);
    const charged = cents(ledger.totals.chargedNet);
    const held = available(ledger);
    const exceptions = await repo.exceptions(tx,unit.id);
    let cause = 'NONE', difference = 0n;
    if (exceptions.length) {
      cause = 'OPEN_EXCEPTION';
      difference = exceptions.reduce((n,x) => n+cents(x.amount),0n);
    } else if (!i.exactPair || i.total !== e.total) {
      cause = 'INCLUSION_MISMATCH'; difference = abs(i.total-e.total);
    } else if (e.total !== charged) {
      cause = 'LEDGER_BASIS_MISMATCH'; difference = abs(e.total-charged);
    } else if (i.total > held) {
      cause = 'FUNDING_SHORTFALL'; difference = i.total-held;
    }
    try {
      const run = await repo.createReconciliation(tx,{
        unitId:unit.id, from,to, currency:unit.currency,
        charged:money(charged),applied:ledger.totals.applied,
        received:ledger.totals.netReceived,entitlement:money(e.total),
        included:money(i.total),outcome:cause==='NONE'?'MATCHED':'VARIANCE',
        cause,variance:money(difference),key,actorId:actor,
      });
      await repo.putKey(tx,key,unit.id,'RECONCILE',run.id,actor);
      return { id:run.id,outcome:run.outcome,cause:run.variance_cause,
        variance:run.variance_amount,replayed:false };
    } catch (err) { mapUnique(err); }
  });
}

/** SETTLED is terminal. Fresh exact checks are repeated after the
 * reconciliation read so a stale MATCHED assertion cannot close a
 * corrected/refunded or otherwise unfunded unit.
 */
export async function settleHandymanSettlement(scope: string, actor: string,
  key: string) {
  keyInput(scope,actor,key);
  return context(scope,actor,async (tx,ledger,unit) => {
    assertUnit(unit,ledger);
    const prior = await replay(tx,key,'SETTLE',unit,actor);
    if (prior) return { unitId:unit.id,state:'SETTLED' as const,replayed:true };
    if (await state(tx,unit) !== 'INCLUDED_IN_SETTLEMENT') throw conflict();
    await clearExceptions(tx,unit);
    await clientWindow(ledger,actor);
    const e = await earned(tx,ledger);
    const i = await included(tx,unit,e);
    if (!i.exactPair || i.total !== e.total ||
        e.total !== cents(ledger.totals.chargedNet)) throw variance();
    funded(ledger,i.total);
    const last = await repo.latestReconciliation(tx,unit.id);
    if (!last || last.outcome !== 'MATCHED' ||
        cents(last.included_total) !== i.total ||
        cents(last.entitlement_total) !== e.total ||
        last.ledger_charged_net !== ledger.totals.chargedNet ||
        last.ledger_applied !== ledger.totals.applied ||
        last.ledger_net_received !== ledger.totals.netReceived) throw variance();
    try {
      const ev = await repo.createTransition(tx,unit.id,'SETTLED',key,actor,last.id);
      await repo.putKey(tx,key,unit.id,'SETTLE',ev.id,actor);
      return { unitId:unit.id,state:ev.state,replayed:false };
    } catch (err) { mapUnique(err); }
  });
}

/** Ledger correction ID is a reference, never caller financial authority.
 * Kind and amount come exclusively from the read-only PART 06 fact.
 * May append AFTER SETTLED; the settled event remains terminal/untouched.
 */
export async function recordHandymanSettlementCorrection(scope: string,
  actor: string, correctionId: string, key: string) {
  keyInput(scope,actor,key,correctionId);
  return context(scope,actor,async (tx,ledger,unit) => {
    assertUnit(unit,ledger);
    const prior = await replay(tx,key,'CORRECTION',unit,actor);
    if (prior) {
      const fact = await repo.getExceptionById(tx,prior.result_id);
      if (!fact || fact.ledger_correction_id !== correctionId) throw conflict();
      return { id:fact.id,kind:fact.exception_kind,replayed:true };
    }
    const cause = ledger.corrections.find(c => c.correctionId===correctionId);
    if (!cause || cause.currency !== unit.currency ||
        cents(cause.amount) <= 0n) throw conflict();
    // A payment/allocation reversal alone does not erase an earned
    // entitlement. Only a PART 02 REVERSED fact with this exact cause
    // can authorize the REVERSED settlement exception vocabulary.
    let earnedReversed = false;
    for (const entitlementKind of ['PROVIDER','BM_FEE'] as const) {
      const fact = await findFact(tx,unit.transaction_id,entitlementKind);
      if (fact && (await listCorrections(tx,fact.id)).some(c =>
        c.ledger_correction_id===correctionId && c.fact_kind==='REVERSED')) {
        earnedReversed = true;
      }
    }
    const kind = earnedReversed ? 'REVERSED' : 'ADJUSTED';
    try {
      const fact = await repo.createException(tx,unit.id,kind,
        cause.correctionId,cause.amount,key,actor);
      await repo.putKey(tx,key,unit.id,'CORRECTION',fact.id,actor);
      return { id:fact.id,kind:fact.exception_kind,replayed:false };
    } catch (err) { mapUnique(err); }
  },false);
}

/** Internal explicit hold, never an external evidence-derived state.
 * Clearing/adjudication is not invented in this PART: fail closed.
 */
export async function holdHandymanSettlementDispute(scope: string,
  actor: string, key: string) {
  keyInput(scope,actor,key);
  return context(scope,actor,async (tx,ledger,unit) => {
    assertUnit(unit,ledger);
    const prior = await replay(tx,key,'DISPUTE',unit,actor);
    if (prior) return { id:prior.result_id,kind:'DISPUTED' as const,replayed:true };
    if (await state(tx,unit)==='SETTLED') throw conflict();
    try {
      const fact = await repo.createException(tx,unit.id,'DISPUTED',null,'0.00',key,actor);
      await repo.putKey(tx,key,unit.id,'DISPUTE',fact.id,actor);
      return { id:fact.id,kind:'DISPUTED' as const,replayed:false };
    } catch (err) { mapUnique(err); }
  },false);
}
