import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { isValidUuid } from '../clients';
import { requireVerifiedBuyerBindingInSnapshot } from '../handyman-buyer-binding/handyman-buyer-binding.service';
import { requireVerifiedCustomerTaxInSnapshot } from '../handyman-customer-tax/handyman-customer-tax.service';
import { requireApprovedIdentityAtInSnapshot } from '../handyman-tax-identity/handyman-tax-identity.service';
import type { BmVerifiedCalculationInput } from '../handyman-bm-tax-case';
import { calculateCustomerPpnFromResolved, calculatePpnFromResolved, hash, normalizeCustomerPpnInput, normalizePpnInput, ppnError, validateApprovedPpnIdentityPin } from './handyman-ppn-core';
import type { ApprovedCustomerPpnBreakdown, CalculateCustomerPpnInput, VerifiedBmPpnBreakdown } from './handyman-ppn.types';

/** Customer PPN retains its verified-buyer path; BM PPN requires an independently approved case. */
export function calculateApprovedHandymanPpn(actorInput: string, input: BmVerifiedCalculationInput): Promise<VerifiedBmPpnBreakdown>;
export function calculateApprovedHandymanPpn(actorInput: string, input: CalculateCustomerPpnInput): Promise<ApprovedCustomerPpnBreakdown>;
export async function calculateApprovedHandymanPpn(actorInput: string, input: BmVerifiedCalculationInput | CalculateCustomerPpnInput): Promise<VerifiedBmPpnBreakdown | ApprovedCustomerPpnBreakdown> {
  if (typeof actorInput !== 'string' || !isValidUuid(actorInput))
    throw ppnError('HANDYMAN_PPN_INVALID','An authenticated actor is required.',400);
  const actor = actorInput.toLowerCase();
  if (input && typeof input === 'object' && 'transactionContext' in input && input.transactionContext === 'CUSTOMER_SERVICE_BILLING') {
    if (!('buyer' in input)) throw ppnError('HANDYMAN_PPN_CUSTOMER_IDENTITY_UNAVAILABLE','A verified buyer and customer classification are required.');
    return verifyCustomerBoundary(actor,input);
  }
  const {normalizeBmVerifiedCalculationInput}=await import('../handyman-bm-tax-case/handyman-bm-tax-case.service');
  const n=normalizeBmVerifiedCalculationInput(input as BmVerifiedCalculationInput),tx=await getPool().connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await calculateApprovedHandymanBmPpnInSnapshot(tx,actor,n);
    await tx.query('COMMIT');return result;
  } catch (err) { await tx.query('ROLLBACK').catch(()=>undefined);throw err; }
  finally { tx.release(); }
}

/** Internal only: caller must hold one repeatable-read, read-only transaction. */
export async function calculateApprovedHandymanBmPpnInSnapshot(tx:PoolClient,actor:string,input:BmVerifiedCalculationInput):Promise<VerifiedBmPpnBreakdown> {
  const {requireApprovedBmTaxCaseInSnapshot}=await import('../handyman-bm-tax-case/handyman-bm-tax-case.service');
  const verified=await requireApprovedBmTaxCaseInSnapshot(tx,actor,input);
  // normalizePpnInput deliberately rejects fractional IDR commission, rather than rounding it silently.
  const pure=calculatePpnFromResolved(normalizePpnInput(verified.ppnInput),verified.ppnBeneficiary,verified.ppnIssuer,verified.ppnRule,verified.readAt);
  const {schema:_schema,transactionPartyBinding:_unverified,checksumAlgorithm:_algorithm,checksum:_checksum,...rest}=pure;
  const body=Object.freeze({...rest,schema:'HANDYMAN_VERIFIED_BM_PPN_CALCULATION_V1' as const,
    transactionPartyBinding:'VERIFIED_BM_COMMISSION_FINANCE_APPROVED' as const,source:verified.source,determination:verified.reference});
  return Object.freeze({...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body)});
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
