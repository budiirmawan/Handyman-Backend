import { getPool } from '../../database';
import { isValidUuid } from '../clients';
import { requireVerifiedBuyerBindingInSnapshot } from '../handyman-buyer-binding/handyman-buyer-binding.service';
import { requireVerifiedCustomerTaxInSnapshot } from '../handyman-customer-tax/handyman-customer-tax.service';
import { requireApprovedIdentityAtInSnapshot } from '../handyman-tax-identity/handyman-tax-identity.service';
import { resolveHandymanTaxRuleInSnapshot } from '../handyman-tax-rules/handyman-tax-rules.service';
import { calculateCustomerPpnFromResolved, calculatePpnFromResolved, normalizeCustomerPpnInput, normalizePpnInput, ppnError, validateApprovedPpnIdentityPin } from './handyman-ppn-core';
import type { ApprovedPpnBreakdown, ApprovedCustomerPpnBreakdown, CalculateApprovedPpnInput, CalculateCustomerPpnInput } from './handyman-ppn.types';

/**
 * Read-only trusted adapter: all three approvals are resolved in one database
 * snapshot and matched against caller-supplied immutable pins. The math is pure;
 * this method does not post, persist, issue or link a financial transaction.
 */
export function calculateApprovedHandymanPpn(actorInput: string, input: CalculateApprovedPpnInput): Promise<ApprovedPpnBreakdown>;
export function calculateApprovedHandymanPpn(actorInput: string, input: CalculateCustomerPpnInput): Promise<ApprovedCustomerPpnBreakdown>;
export async function calculateApprovedHandymanPpn(actorInput: string, input: CalculateApprovedPpnInput | CalculateCustomerPpnInput): Promise<ApprovedPpnBreakdown | ApprovedCustomerPpnBreakdown> {
  if (typeof actorInput !== 'string' || !isValidUuid(actorInput))
    throw ppnError('HANDYMAN_PPN_INVALID','An authenticated actor is required.',400);
  const actor = actorInput.toLowerCase();
  if (input?.transactionContext === 'CUSTOMER_SERVICE_BILLING' && 'buyer' in input)
    return verifyCustomerBoundary(actor,input);
  const n = normalizePpnInput(input as CalculateApprovedPpnInput), tx = await getPool().connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const row = (await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS read_at")).rows[0];
    const readAt = (row.read_at as Date).toISOString();
    const cutoff = new Date(Math.min(new Date(readAt).getTime(),new Date(n.taxPointAt).getTime())).toISOString();
    const supplier = await requireApprovedIdentityAtInSnapshot(tx,actor,n.supplier.owner,n.taxPointAt);
    const recipient = await requireApprovedIdentityAtInSnapshot(tx,actor,n.recipient.owner,n.taxPointAt);
    const rule = await resolveHandymanTaxRuleInSnapshot(tx,actor,{ clientId:n.clientId, transactionContext:n.transactionContext,
      taxCode:'PPN', taxpayerClassification:n.taxpayerClassification, taxDate:n.taxDate, knownAt:cutoff });
    if (rule.status === 'MISSING') throw ppnError('HANDYMAN_PPN_MISSING_RULE','No exact PPN rule exists for the requested tax date.');
    if (rule.status === 'AMBIGUOUS') throw ppnError('HANDYMAN_PPN_AMBIGUOUS_RULE','More than one PPN rule matches the exact scope.');
    if (rule.status === 'NOT_APPROVED') throw ppnError('HANDYMAN_PPN_NOT_APPROVED','The exact PPN rule was not approved by the required instant.');
    if (rule.status === 'INTEGRITY_ERROR') throw ppnError('HANDYMAN_PPN_INTEGRITY_ERROR','The PPN rule failed its integrity checks.');
    if (rule.status !== 'APPROVED') throw ppnError('HANDYMAN_PPN_NOT_APPROVED','The PPN rule is not approved.');
    const result = calculatePpnFromResolved(n,supplier,recipient,rule,readAt);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { tx.release(); }
}

/** Customer calculation needs a verified buyer and a separately reviewed, rule-pinned classification. */
async function verifyCustomerBoundary(actor: string, input: CalculateCustomerPpnInput): Promise<ApprovedCustomerPpnBreakdown> {
  const n=normalizeCustomerPpnInput(input),tx=await getPool().connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const readAt=((await tx.query("SELECT date_trunc('milliseconds',transaction_timestamp()) AS read_at")).rows[0].read_at as Date).toISOString();
    if (!n.classification) {
      await requireVerifiedBuyerBindingInSnapshot(tx,actor,{clientId:n.clientId,requestId:n.requestId,pin:n.buyer,at:n.taxPointAt});
      const supplier=await requireApprovedIdentityAtInSnapshot(tx,actor,n.supplier.owner,n.taxPointAt);
      validateApprovedPpnIdentityPin(n.supplier,supplier,n.taxPointAt,readAt);
      throw ppnError('HANDYMAN_PPN_CUSTOMER_IDENTITY_UNAVAILABLE','A reviewed customer tax classification is required.');
    }
    const customer=await requireVerifiedCustomerTaxInSnapshot(tx,actor,{clientId:n.clientId,requestId:n.requestId,pin:n.classification});
    const supplier=await requireApprovedIdentityAtInSnapshot(tx,actor,n.supplier.owner,n.taxPointAt);
    const result=calculateCustomerPpnFromResolved(n,supplier,customer.buyer,customer,customer.rule,readAt);
    await tx.query('COMMIT');return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(()=>undefined);throw err;
  } finally { tx.release(); }
}
