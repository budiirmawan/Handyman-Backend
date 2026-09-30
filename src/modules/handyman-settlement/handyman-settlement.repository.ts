import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/** PART 03 persistence boundary. Only INSERTs into own append-only
 * tables and locked reads of the aggregate; never ledger mutations.
 */
export type Executor = Pick<PoolClient, 'query'>;
export type Unit = {
  id: string; client_id: string; transaction_id: string;
  execution_scope_id: string; currency: string; idempotency_key: string;
  actor_user_id: string;
};
export type Transition = {
  id: string; unit_id: string;
  state: 'PAYABLE' | 'INCLUDED_IN_SETTLEMENT' | 'SETTLED';
  reconciliation_id: string | null; idempotency_key: string;
  actor_user_id: string;
};
export type Inclusion = {
  id: string; unit_id: string; entitlement_id: string; amount: string;
  idempotency_key: string; actor_user_id: string;
};
export type Reconciliation = {
  id: string; unit_id: string; ledger_contract_version: string;
  currency: string; ledger_charged_net: string; ledger_applied: string;
  ledger_net_received: string; entitlement_total: string;
  included_total: string; outcome: 'MATCHED' | 'VARIANCE';
  variance_cause: string; variance_amount: string; idempotency_key: string;
  actor_user_id: string;
};
export type Exception = {
  id: string; unit_id: string; exception_kind: 'REVERSED' | 'ADJUSTED' | 'DISPUTED';
  ledger_correction_id: string | null; amount: string;
  idempotency_key: string; actor_user_id: string;
};
export type CommandKey = { idempotency_key: string; unit_id: string;
  action: Action; result_id: string; actor_user_id: string };
export type Action = 'PREPARE' | 'INCLUDE' | 'RECONCILE' | 'SETTLE' |
  'CORRECTION' | 'DISPUTE';

export async function lockTransaction(tx: PoolClient, scopeId: string) {
  // Same order as PART 02 and the scope/ledger writers: scope then tx.
  await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE',
    [scopeId]);
  const r = await tx.query<{ id: string }>(`SELECT id
    FROM handyman_customer_transactions WHERE execution_scope_id=$1 FOR UPDATE`,
  [scopeId]);
  return r.rows[0]?.id ?? null;
}
export async function getUnit(tx: Executor, transactionId: string) {
  const r = await tx.query<Unit>(`SELECT * FROM handyman_settlement_units
    WHERE transaction_id=$1`, [transactionId]);
  return r.rows[0] ?? null;
}
export async function getKey(tx: Executor, key: string) {
  const r = await tx.query<CommandKey>(`SELECT * FROM handyman_settlement_command_keys
    WHERE idempotency_key=$1`, [key]);
  return r.rows[0] ?? null;
}
export async function putKey(tx: Executor, key: string, unitId: string,
  action: Action, resultId: string, actorId: string) {
  await tx.query(`INSERT INTO handyman_settlement_command_keys
    (idempotency_key,unit_id,action,result_id,actor_user_id)
    VALUES($1,$2,$3,$4,$5)`, [key,unitId,action,resultId,actorId]);
}
export async function createUnit(tx: Executor, x: {
  clientId: string; transactionId: string; executionScopeId: string;
  currency: string; key: string; actorId: string;
}) {
  const r = await tx.query<Unit>(`INSERT INTO handyman_settlement_units
    (id,client_id,transaction_id,execution_scope_id,currency,idempotency_key,actor_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
  [randomUUID(),x.clientId,x.transactionId,x.executionScopeId,x.currency,x.key,x.actorId]);
  return r.rows[0];
}
export async function createTransition(tx: Executor, unitId: string,
  state: Transition['state'], key: string, actorId: string,
  reconciliationId: string | null = null) {
  const r = await tx.query<Transition>(`INSERT INTO handyman_settlement_events
    (id,unit_id,state,reconciliation_id,idempotency_key,actor_user_id)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
  [randomUUID(),unitId,state,reconciliationId,key,actorId]);
  return r.rows[0];
}
export async function transitions(tx: Executor, unitId: string) {
  const r = await tx.query<Transition>(`SELECT * FROM handyman_settlement_events
    WHERE unit_id=$1 ORDER BY occurred_at,id`, [unitId]);
  return r.rows;
}
export async function createInclusion(tx: Executor, unitId: string,
  entitlementId: string, amount: string, key: string, actorId: string) {
  const r = await tx.query<Inclusion>(`INSERT INTO handyman_settlement_inclusions
    (id,unit_id,entitlement_id,amount,idempotency_key,actor_user_id)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
  [randomUUID(),unitId,entitlementId,amount,key,actorId]);
  return r.rows[0];
}
export async function inclusions(tx: Executor, unitId: string) {
  const r = await tx.query<Inclusion>(`SELECT * FROM handyman_settlement_inclusions
    WHERE unit_id=$1 ORDER BY entitlement_id`, [unitId]);
  return r.rows;
}
export async function createReconciliation(tx: Executor, x: {
  unitId: string; from: string; to: string; currency: string;
  charged: string; applied: string; received: string; entitlement: string;
  included: string; outcome: Reconciliation['outcome']; cause: string;
  variance: string; key: string; actorId: string;
}) {
  const r = await tx.query<Reconciliation>(`INSERT INTO handyman_settlement_reconciliations
    (id,unit_id,ledger_contract_version,window_from,window_to,currency,
     ledger_charged_net,ledger_applied,ledger_net_received,entitlement_total,
     included_total,outcome,variance_cause,variance_amount,idempotency_key,
     actor_user_id)
    VALUES($1,$2,'CR-HM-13-PART-06',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING *`,
  [randomUUID(),x.unitId,x.from,x.to,x.currency,x.charged,x.applied,x.received,
    x.entitlement,x.included,x.outcome,x.cause,x.variance,x.key,x.actorId]);
  return r.rows[0];
}
export async function latestReconciliation(tx: Executor, unitId: string) {
  const r = await tx.query<Reconciliation>(`SELECT * FROM handyman_settlement_reconciliations
    WHERE unit_id=$1 ORDER BY reconciliation_seq DESC LIMIT 1`, [unitId]);
  return r.rows[0] ?? null;
}
export async function getReconciliationById(tx: Executor, id: string) {
  const r = await tx.query<Reconciliation>(`SELECT * FROM handyman_settlement_reconciliations
    WHERE id=$1`, [id]);
  return r.rows[0] ?? null;
}
export async function createException(tx: Executor, unitId: string,
  kind: Exception['exception_kind'], correctionId: string | null,
  amount: string, key: string, actorId: string) {
  const r = await tx.query<Exception>(`INSERT INTO handyman_settlement_exceptions
    (id,unit_id,exception_kind,ledger_correction_id,amount,
     idempotency_key,actor_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
  [randomUUID(),unitId,kind,correctionId,amount,key,actorId]);
  return r.rows[0];
}
export async function exceptions(tx: Executor, unitId: string) {
  const r = await tx.query<Exception>(`SELECT * FROM handyman_settlement_exceptions
    WHERE unit_id=$1 ORDER BY occurred_at,id`, [unitId]);
  return r.rows;
}
export async function getExceptionById(tx: Executor, id: string) {
  const r = await tx.query<Exception>(`SELECT * FROM handyman_settlement_exceptions
    WHERE id=$1`, [id]);
  return r.rows[0] ?? null;
}
